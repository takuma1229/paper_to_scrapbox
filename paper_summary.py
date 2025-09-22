import argparse
import logging
import os
import sys
import tempfile
import webbrowser
from typing import Optional
from urllib.parse import quote, urljoin

import requests
from bs4 import BeautifulSoup
from dotenv import load_dotenv
from openai import OpenAI


def configure_logging(verbose: bool) -> None:
    level = logging.DEBUG if verbose else logging.INFO
    logging.basicConfig(level=level, format="%(levelname)s: %(message)s")


def find_pdf_url(page_url: str) -> str:
    logging.info("Fetching page: %s", page_url)
    try:
        response = requests.get(page_url, timeout=30)
        response.raise_for_status()
    except requests.RequestException as exc:
        raise RuntimeError(f"Failed to fetch page {page_url}: {exc}") from exc

    soup = BeautifulSoup(response.text, "html.parser")
    for anchor in soup.find_all("a", href=True):
        href = anchor["href"].strip()
        if href.lower().endswith(".pdf"):
            pdf_url = urljoin(page_url, href)
            logging.info("Found PDF link: %s", pdf_url)
            return pdf_url

    raise RuntimeError("Could not find any PDF link on the provided page")


def download_pdf(pdf_url: str) -> str:
    logging.info("Downloading PDF: %s", pdf_url)
    try:
        response = requests.get(pdf_url, timeout=60)
        response.raise_for_status()
    except requests.RequestException as exc:
        raise RuntimeError(f"Failed to download PDF {pdf_url}: {exc}") from exc

    with tempfile.NamedTemporaryFile(delete=False, suffix=".pdf") as tmp_file:
        tmp_file.write(response.content)
        tmp_path = tmp_file.name

    logging.info("Saved PDF to %s", tmp_path)
    return tmp_path


def extract_text_from_response(response) -> str:
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
        raise RuntimeError("No textual content returned by OpenAI response")
    return text


def summarize_pdf(pdf_path: str, model: str) -> str:
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY is not set")

    client = OpenAI()

    with open(pdf_path, "rb") as pdf_file:
        logging.info("Uploading PDF to OpenAI")
        uploaded_file = client.files.create(file=pdf_file, purpose="assistants")

    system_prompt = (
        "You are an expert research assistant who writes concise Japanese summaries. "
        "Focus on conveying the core contributions of the paper accurately."
    )
    user_prompt = (
        "添付した論文PDFを読んで、以下の条件で日本語要約を作成してください:\n"
        "1. 背景・目的、手法、主要な結果、考察/限界の順で4つの箇条書きを用意する。\n"
        "2. 各箇条書きは2文以内でまとめる。\n"
        "3. 専門用語は必要に応じて簡潔に補足説明を入れる。\n"
        "4. 論文の貢献や今後の課題が分かるように記述する。"
    )

    logging.info("Requesting summary from OpenAI (%s)", model)
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
                    {"type": "input_text", "text": user_prompt},
                    {"type": "input_file", "file_id": uploaded_file.id},
                ],
            },
        ],
        temperature=0.2,
    )

    summary = extract_text_from_response(response)
    logging.info("OpenAI summary received (%d chars)", len(summary))

    logging.info(f"Summary:\n{summary}")

    logging.debug("Deleting uploaded file %s", uploaded_file.id)
    client.files.delete(uploaded_file.id)

    return summary


def open_scrapbox_page(
    project: str,
    title: str,
    summary: str,
    base_url: Optional[str],
) -> None:
    base = base_url.rstrip("/") if base_url else "https://scrapbox.io"
    encoded_project = quote(project, safe="")
    encoded_title = quote(title, safe="")
    body_lines = [title.strip(), "", summary.strip()]
    body_text = "\n".join(line for line in body_lines if line)
    encoded_body = quote(body_text, safe="")
    url = f"{base}/{encoded_project}/{encoded_title}?body={encoded_body}"

    logging.info("ブラウザでScrapboxページを開きます: %s", url)
    opened = webbrowser.open(url)
    if not opened:
        raise RuntimeError("Scrapboxページのオープンに失敗しました。ブラウザ設定を確認してください。")


def run(
    page_url: str, pdf_url: Optional[str], project: str, title: str, model: str
) -> None:
    resolved_pdf_url = pdf_url
    if not resolved_pdf_url:
        resolved_pdf_url = find_pdf_url(page_url)
    else:
        if page_url:
            resolved_pdf_url = urljoin(page_url, resolved_pdf_url)
        logging.info("Using provided PDF URL: %s", resolved_pdf_url)

    pdf_path = download_pdf(resolved_pdf_url)

    try:
        summary = summarize_pdf(pdf_path, model)
    finally:
        if os.path.exists(pdf_path):
            os.remove(pdf_path)

    scrapbox_base_url = os.getenv("SCRAPBOX_BASE_URL")
    open_scrapbox_page(project, title, summary, scrapbox_base_url)

    logging.info("Done")


def main() -> None:
    load_dotenv()

    parser = argparse.ArgumentParser(
        description=(
            "Download a paper PDF from a web page, summarize it with OpenAI, "
            "and open the summary as a new Scrapbox page in your browser."
        )
    )
    parser.add_argument("page_url", help="Web page URL that contains a link to the PDF")
    parser.add_argument(
        "project",
        help="Scrapbox project name (e.g. your-project)",
    )
    parser.add_argument(
        "title",
        help="Scrapbox page title to open/create",
    )
    parser.add_argument(
        "--pdf-url",
        dest="pdf_url",
        default=None,
        help="Optional direct link to the PDF if it cannot be inferred from the page",
    )
    parser.add_argument(
        "--model",
        default=os.getenv("OPENAI_MODEL", "gpt-4.1-mini"),
        help="OpenAI model name to use",
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="Enable debug logging",
    )

    args = parser.parse_args()
    configure_logging(args.verbose)

    try:
        run(args.page_url, args.pdf_url, args.project, args.title, args.model)
    except Exception as exc:  # pragma: no cover - CLI surface
        logging.error(str(exc))
        sys.exit(1)


if __name__ == "__main__":
    main()
