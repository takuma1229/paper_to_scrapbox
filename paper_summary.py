"""論文ページからPDFを取得し、OpenAIで要約してScrapboxに展開するCLI。"""

import argparse
import json
import logging
import os
import sys
import tempfile
import webbrowser
from pathlib import Path
from typing import Optional, Tuple
from urllib.parse import quote, urljoin, urlparse, parse_qs

import requests
from bs4 import BeautifulSoup
from dotenv import load_dotenv
from openai import OpenAI


DEFAULT_HTTP_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/126.0.0.0 Safari/537.36"
    )
}

TITLE_PROMPT_PATH = Path(__file__).with_name("title_prompt.txt")
SUMMARY_PROMPT_PATH = Path(__file__).with_name("summarization_prompt.txt")


def load_title_prompt() -> str:
    """タイトル抽出に用いるプロンプトを読み込む。"""

    try:
        return TITLE_PROMPT_PATH.read_text(encoding="utf-8").strip()
    except OSError as exc:  # pragma: no cover - ファイル欠如は運用時検知
        raise RuntimeError(
            f"タイトルプロンプトファイルを読み込めませんでした: {TITLE_PROMPT_PATH}"
        ) from exc


def load_summary_prompt() -> str:
    """要約生成に用いるユーザープロンプトをテキストファイルから読み込む。"""

    try:
        return SUMMARY_PROMPT_PATH.read_text(encoding="utf-8").strip()
    except OSError as exc:  # pragma: no cover - ファイル欠如は運用時検知
        raise RuntimeError(
            f"要約プロンプトファイルを読み込めませんでした: {SUMMARY_PROMPT_PATH}"
        ) from exc


def configure_logging(verbose: bool) -> None:
    """ロガーを設定し、詳細モードでログレベルを切り替える。

    Args:
        verbose (bool): 詳細ログを有効にする場合は``True``。
    """
    level = logging.DEBUG if verbose else logging.INFO
    logging.basicConfig(level=level, format="%(levelname)s: %(message)s")


def find_pdf_url(page_url: str) -> str:
    """論文ページを解析し、PDFの直接URLを推測して返す。

    Args:
        page_url (str): PDFリンクを含む論文ページのURL。

    Returns:
        str: 推定されたPDFの直接URL。

    Raises:
        RuntimeError: PDFリンクを取得できなかった場合。
    """

    logging.info("ページを取得します: %s", page_url)

    parsed_page = urlparse(page_url)

    def derive_direct_pdf_url() -> Optional[str]:
        """既知のURLパターンからPDFリンクを構築する。

        Returns:
            Optional[str]: 推定されたPDFの直接URL。取得できない場合は``None``。
        """
        host = (parsed_page.netloc or "").lower()
        path = parsed_page.path or ""

        if host.endswith("arxiv.org") and path.startswith("/abs/"):
            identifier = path[len("/abs/") :].strip("/")
            if identifier:
                suffix = ".pdf" if not identifier.endswith(".pdf") else ""
                return urljoin(page_url, f"/pdf/{identifier}{suffix}")

        if host.endswith("aclanthology.org"):
            normalized = path.rstrip("/")
            if normalized:
                return urljoin(page_url, f"{normalized}.pdf")

        if host.endswith("openreview.net"):
            query = parse_qs(parsed_page.query)
            paper_ids = query.get("id")
            if paper_ids and paper_ids[0]:
                return urljoin(page_url, f"/pdf?id={paper_ids[0]}")

        if host == "dl.acm.org" and "/doi/" in path:
            doi_part = path.split("/doi/")[-1].strip("/")
            if doi_part:
                return urljoin(page_url, f"/doi/pdf/{doi_part}?download=true")

        return None

    direct_pdf = derive_direct_pdf_url()
    if direct_pdf:
        logging.info("スクレイピングなしでPDFリンクを推定: %s", direct_pdf)
        return direct_pdf

    try:
        response = requests.get(page_url, timeout=30, headers=DEFAULT_HTTP_HEADERS)
        response.raise_for_status()
    except requests.RequestException as exc:
        raise RuntimeError(f"ページの取得に失敗しました: {page_url} : {exc}") from exc

    soup = BeautifulSoup(response.text, "html.parser")
    pdf_like_links = []

    def record_candidate(raw_url: str) -> None:
        """候補となるURLを正規化して保存する。

        Args:
            raw_url (str): ページ上で検出したリンク文字列。
        """
        if not raw_url:
            return
        resolved = urljoin(page_url, raw_url.strip())
        if resolved:
            pdf_like_links.append(resolved)

    def looks_like_pdf(url: str, anchor_text: str = "", mime_type: str = "") -> bool:
        """リンク先がPDFらしいかどうかを判定する。

        Args:
            url (str): リンク先URL。
            anchor_text (str, optional): アンカーの表示文字列。デフォルトは空文字列。
            mime_type (str, optional): ``type``属性で示されたMIMEタイプ。デフォルトは空文字列。

        Returns:
            bool: PDFへのリンクと推定できる場合は``True``。
        """
        parsed = urlparse(url)
        path = (parsed.path or "").lower()
        query = (parsed.query or "").lower()
        mime = (mime_type or "").lower()
        text = (anchor_text or "").lower()

        if path.endswith(".pdf"):
            return True
        if mime == "application/pdf":
            return True
        if ".pdf" in path:
            return True
        if "/pdf/" in path:
            return True
        if "format=pdf" in query or "download=1" in query:
            return True
        if "pdf" in text:
            return True
        return False

    for anchor in soup.find_all("a", href=True):
        href = anchor["href"].strip()
        mime_type = anchor.get("type", "")
        resolved = urljoin(page_url, href)
        if looks_like_pdf(resolved, anchor_text=anchor.get_text(strip=True), mime_type=mime_type):
            logging.info("PDFリンク候補を検出: %s", resolved)
            if urlparse(resolved).path.lower().endswith(".pdf"):
                return resolved
            record_candidate(resolved)

    meta_pdf = soup.find("meta", attrs={"name": "citation_pdf_url"})
    if meta_pdf and meta_pdf.get("content"):
        record_candidate(meta_pdf["content"])

    for link in soup.find_all("link", href=True):
        link_type = (link.get("type") or "").lower()
        if link_type == "application/pdf":
            record_candidate(link["href"])

    if pdf_like_links:
        unique_candidates = []
        seen = set()
        for candidate in pdf_like_links:
            if candidate not in seen:
                seen.add(candidate)
                unique_candidates.append(candidate)
        chosen = unique_candidates[0]
        logging.info("候補一覧からPDFリンクを選択: %s", chosen)
        return chosen

    raise RuntimeError("指定したページからPDFリンクを検出できませんでした")


def download_pdf(pdf_url: str, referer: Optional[str] = None) -> str:
    """PDFをダウンロードして一時ファイルに保存し、そのパスを返す。

    Args:
        pdf_url (str): ダウンロード対象のPDF URL。
        referer (Optional[str]): リクエスト時に利用するリファラURL。

    Returns:
        str: 保存した一時PDFファイルのパス。

    Raises:
        RuntimeError: PDFの取得に失敗した場合。
    """

    logging.info("PDFをダウンロードします: %s", pdf_url)
    try:
        headers = dict(DEFAULT_HTTP_HEADERS)
        if referer:
            headers["Referer"] = referer
        response = requests.get(pdf_url, timeout=60, headers=headers)
        response.raise_for_status()
    except requests.RequestException as exc:
        raise RuntimeError(f"PDFのダウンロードに失敗しました: {pdf_url} : {exc}") from exc

    with tempfile.NamedTemporaryFile(delete=False, suffix=".pdf") as tmp_file:
        tmp_file.write(response.content)
        tmp_path = tmp_file.name

    logging.info("PDFを一時ファイルに保存しました: %s", tmp_path)
    return tmp_path


def extract_text_from_response(response) -> str:
    """OpenAIレスポンスからテキスト断片を抽出し結合して返す。

    Args:
        response: OpenAIクライアントから返却されたレスポンスオブジェクト。

    Returns:
        str: 結合された要約テキスト。

    Raises:
        RuntimeError: テキストが抽出できなかった場合。
    """
    # The OpenAI client returns a Pydantic model; fall back to dict access for stability.
    chunks = []
    response_dict = (
        response.model_dump() if hasattr(response, "model_dump") else response
    )
    if isinstance(response_dict, dict):
        for item in response_dict.get("output", []):
            for content in item.get("content", []):
                if content.get("type") == "output_text":
                    chunks.append(content.get("text", ""))
        if not chunks and response_dict.get("output_text"):
            chunks.append(response_dict.get("output_text"))
    if not chunks and hasattr(response, "output_text"):
        chunks.append(getattr(response, "output_text"))

    text = "\n".join(chunk.strip() for chunk in chunks if chunk).strip()
    if not text:
        raise RuntimeError("OpenAIレスポンスからテキストを取得できませんでした")
    return text


def summarize_pdf_with_title(pdf_path: str, model: str) -> Tuple[str, str]:
    """PDFをOpenAIで要約し、タイトルと要約本文を取得して返す。

    Args:
        pdf_path (str): 要約対象のPDFファイルパス。
        model (str): 利用するOpenAIモデル名。

    Returns:
        Tuple[str, str]: 検出したタイトルと要約本文のペア。

    Raises:
        RuntimeError: OpenAI APIの利用やレスポンス解析に失敗した場合。
    """
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEYが設定されていません")

    client = OpenAI()

    with open(pdf_path, "rb") as pdf_file:
        logging.info("PDFをOpenAIへアップロードします")
        uploaded_file = client.files.create(file=pdf_file, purpose="assistants")

    system_prompt = (
        "あなたは日本語で簡潔かつ正確な要約を書く研究支援アシスタントです。"
        "論文の主要な貢献を正確に伝え、指示された形式を厳守してください。"
    )

    def request_text(prompt: str, description: str) -> str:
        logging.info("OpenAIに%sをリクエストします (%s)", description, model)
        response = client.responses.create(
            model=model,
            input=[
                {
                    "role": "system",
                    "content": [{"type": "input_text", "text": system_prompt}],
                },
                {
                    "role": "user",
                    "content": [
                        {"type": "input_text", "text": prompt},
                        {"type": "input_file", "file_id": uploaded_file.id},
                    ],
                },
            ],
        )
        raw_text = extract_text_from_response(response)
        logging.debug("OpenAIの生テキスト (%s): %s", description, raw_text)
        text = raw_text.strip()
        if not text:
            raise RuntimeError(f"OpenAIレスポンスに{description}が含まれていません")
        return text

    title_prompt = load_title_prompt()
    title_text = request_text(title_prompt, "タイトル抽出")
    title = title_text.splitlines()[0].strip()
    if not title:
        raise RuntimeError("OpenAIからタイトルを取得できませんでした")
    logging.info("OpenAIが検出したタイトル: %s", title)

    summary_prompt = load_summary_prompt()
    summary_raw = request_text(summary_prompt, "要約生成")
    summary_raw = summary_raw.strip()
    if not summary_raw:
        raise RuntimeError("OpenAIから要約を取得できませんでした")

    summary = summary_raw
    if summary_raw.startswith("{"):
        try:
            parsed_summary = json.loads(summary_raw)
        except json.JSONDecodeError:
            logging.warning("要約レスポンスをJSON解析できませんでした。生テキストを使用します。")
        else:
            summary_field = (parsed_summary.get("summary") or "").strip()
            if summary_field:
                summary = summary_field
            parsed_title = (parsed_summary.get("title") or "").strip()
            if parsed_title and parsed_title != title:
                logging.info("要約レスポンス内タイトル: %s", parsed_title)

    logging.info("OpenAIから受信した要約の文字数: %d", len(summary))
    logging.info("要約:\n%s", summary)

    logging.debug("アップロード済みファイルを削除します: %s", uploaded_file.id)
    client.files.delete(uploaded_file.id)

    return title, summary


def open_scrapbox_page(
    project: str,
    title: str,
    summary: str,
    base_url: Optional[str],
) -> None:
    """ScrapboxのページURLを生成し、設定によってはブラウザで開く。

    Args:
        project (str): Scrapboxプロジェクト名。
        title (str): Scrapboxページタイトル。
        summary (str): ページ本文に書き込む要約。
        base_url (Optional[str]): ScrapboxのベースURL。指定しない場合は公式URLを使用。

    Raises:
        RuntimeError: ブラウザの起動に失敗した場合。
    """
    if os.getenv("SCRAPBOX_SKIP_BROWSER", "").lower() in {"1", "true", "yes"}:
        logging.info("SCRAPBOX_SKIP_BROWSERが設定されているためブラウザ起動をスキップします")
        return

    base = base_url.rstrip("/") if base_url else "https://scrapbox.io"
    encoded_project = quote(project, safe="")
    encoded_title = quote(title, safe="")
    body_lines = [summary.strip()]
    body_text = "\n".join(line for line in body_lines if line)
    encoded_body = quote(body_text, safe="")
    url = f"{base}/{encoded_project}/{encoded_title}?body={encoded_body}"

    logging.info("ブラウザでScrapboxページを開きます: %s", url)
    opened = webbrowser.open(url)
    if not opened:
        raise RuntimeError("Scrapboxページのオープンに失敗しました。ブラウザ設定を確認してください。")


def run(
    page_url: str,
    pdf_url: Optional[str],
    project: str,
    model: str,
) -> None:
    """PDF取得から要約生成、Scrapboxページ作成までの主要フローを実行する。

    Args:
        page_url (str): PDFリンクを含む論文ページのURL。
        pdf_url (Optional[str]): 直接指定されたPDF URL。
        project (str): Scrapboxプロジェクト名。
        model (str): 利用するOpenAIモデル名。

    Raises:
        RuntimeError: PDF取得・要約生成・ページ構築の各段階で問題が発生した場合。
    """
    resolved_pdf_url = pdf_url
    if not resolved_pdf_url:
        resolved_pdf_url = find_pdf_url(page_url)
    else:
        if page_url:
            resolved_pdf_url = urljoin(page_url, resolved_pdf_url)
        logging.info("指定されたPDF URLを使用します: %s", resolved_pdf_url)

    pdf_path = download_pdf(resolved_pdf_url, referer=page_url)

    try:
        detected_title, summary = summarize_pdf_with_title(pdf_path, model)
    finally:
        if os.path.exists(pdf_path):
            os.remove(pdf_path)

    page_title = detected_title
    logging.info("検出したタイトルをScrapboxに使用します: %s", page_title)
    if not page_title:
        raise RuntimeError("Scrapboxページのタイトルを決定できませんでした")

    scrapbox_base_url = os.getenv("SCRAPBOX_BASE_URL")
    open_scrapbox_page(project, page_title, summary, scrapbox_base_url)

    logging.info("処理が完了しました")


def main() -> None:
    """環境変数を読み込み、CLI引数を解析して処理を実行する。

    Raises:
        SystemExit: 処理中にエラーが発生した際、戻り値1で終了する。
    """
    load_dotenv()

    parser = argparse.ArgumentParser(
        description=(
            "論文ページからPDFを取得し、OpenAIで要約してScrapboxページとして開きます"
        )
    )
    parser.add_argument("page_url", help="PDFリンクを含む論文ページのURL")
    parser.add_argument(
        "project",
        help="Scrapboxのプロジェクト名（例: your-project）",
    )
    parser.add_argument(
        "--pdf-url",
        dest="pdf_url",
        default=None,
        help="ページから推定できない場合に指定するPDFの直接URL",
    )
    parser.add_argument(
        "--model",
        default=os.getenv("OPENAI_MODEL", "gpt-4.1-mini"),
        help="使用するOpenAIモデル名",
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="デバッグログを有効にする",
    )

    args = parser.parse_args()
    configure_logging(args.verbose)

    try:
        run(args.page_url, args.pdf_url, args.project, args.model)
    except Exception as exc:  # pragma: no cover - CLI surface
        logging.error(str(exc))
        sys.exit(1)


if __name__ == "__main__":
    main()
