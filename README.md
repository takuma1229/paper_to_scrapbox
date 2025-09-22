# paper-summary-automation

論文のWebページからPDFを取得し、OpenAI APIで日本語要約を生成してScrapboxの新規ページをブラウザで開く自動化スクリプトです。

## 必要条件

- Python 3.10 以上
- OpenAI APIキー (`OPENAI_API_KEY`)

## セットアップ

1. ブラウザでScrapboxにログインしていることを確認して下さい。
2. [uv](https://github.com/astral-sh/uv) をインストールします (未導入の場合)。macOS/Linux では次のコマンドで導入できます。
   ```bash
   curl -LsSf https://astral.sh/uv/install.sh | sh
   ```
   Windows の場合は公式ドキュメントの PowerShell コマンドを利用してください。
3. `.env.example` をコピーして `.env` を作成し、必要な値を設定します。
   ```bash
   cp .env.example .env
   ```
   - `OPENAI_API_KEY`: OpenAIのAPIキー。
   - `OPENAI_MODEL`: 使用するモデル名 (例: `gpt-4o-mini`)。
   - `SCRAPBOX_BASE_URL`: 独自ドメインでScrapboxを利用している場合に指定します (既定値は `https://scrapbox.io`で、多くの場合これを変更する必要はありません)。

   ブラウザでScrapboxにログインしていれば、生成されたURLを開くだけで新しいページが作成されます。
   ページ名には要約処理で検出した論文タイトルが自動的に使用されるため、必要に応じてScrapbox上で編集してください。

## 使い方

以下のコマンドで、指定した論文ページからPDFを検出・ダウンロードし、PDF本文から抽出したタイトルと要約をScrapboxの新規ページとしてブラウザで開きます。

次のコマンドで、必要な依存関係を自動解決しつつ一時的な環境でスクリプトを実行できます。
```bash
uv run python paper_summary.py \
  "https://example.com/paper-page" \
  your-scrapbox-project \
  --model gpt-4o-mini
```

--> ブラウザが起動し、Scrapboxにページが作成されます。

オプション:
- `--pdf-url`: ページからPDFリンクを特定できない場合に、直接PDFのURLを指定します。
- `--verbose`: 詳細ログを表示します。

### Optional: venvを使う場合
venvを用いてスクリプトを実行したい場合は、以下で環境を作成して下さい。

```bash
uv venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate
uv pip install --editable .
paper-summary "https://example.com/paper-page" your-scrapbox-project --model gpt-4.1-mini
```

## 注意事項
- OpenAI APIの利用料金が発生するため、必要に応じてトークン使用量を監視してください。

## テストの実行

### 単体テスト

`find_pdf_url` のロジックを検証する単体テストは次のコマンドで実行できます。

```bash
. .venv/bin/activate
python -m unittest -v test_paper_summary
```

### 統合テスト（実サイト + OpenAI API）

外部サイトにアクセスし、OpenAI API まで含めたフルフローを検証する統合テストです。事前に `.env` の API キーを設定し、実行時はブラウザ起動を抑止するため `SCRAPBOX_SKIP_BROWSER=1` を設定します。

```bash
export RUN_NETWORK_TESTS=1
export SCRAPBOX_SKIP_BROWSER=1
. .venv/bin/activate
python -m unittest -v test_integration_paper_summary
```

※ `RUN_NETWORK_TESTS=1` を付けない場合、統合テストはスキップされます。
