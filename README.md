# paper2scrapbox

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

## 要約プロンプトを変更する

ルートディレクトリの `title_prompt.txt`（タイトル抽出）と `summarization_prompt.txt`（要約生成）が、CLIとChrome拡張で共有されるプロンプトです。内容を編集すると、次回の実行時に自動的に反映されます。`extension/` 以下の同名ファイルはシンボリックリンクで本体を参照しています。

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

## Chrome拡張として使う

リポジトリ直下の `extension/` ディレクトリにローカル専用のChrome拡張を同梱しています。ご自身のみが利用する前提のため、OpenAI APIキーはポップアップに入力し、`chrome.storage.local` に平文で保存されます（自己責任でご利用ください）。

1. Chromeで `chrome://extensions/` を開き、右上で「デベロッパーモード」を有効化します。
2. 「パッケージ化されていない拡張機能を読み込む」から本プロジェクトの `extension/` ディレクトリを指定します。
3. 拡張アイコンをクリックすると、現在アクティブなタブのURLが自動入力されます（論文ページ以外を開いている場合は必要に応じて書き換えてください）。任意で直接PDF URLを入力し、Scrapboxプロジェクト名、ScrapboxベースURL、OpenAI APIキー、モデル名を設定して「要約してScrapboxを開く」を押します。
4. 成功すると要約済み内容が反映されたScrapboxページが新しいタブで開きます。処理状況はポップアップ下部のステータス欄で確認できます。

### 注意
- OpenAI APIとの通信はブラウザから直接行うため、APIキー流出リスクを理解したうえでご利用ください。
- PDF取得や要約生成には数十秒要する場合があります。完了までポップアップを閉じないでください。
