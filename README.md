# paper-summary-automation

論文のWebページからPDFを取得し、OpenAI APIで日本語要約を生成してScrapboxの新規ページをブラウザで開く自動化スクリプトです。

## 必要条件

- Python 3.10 以上
- OpenAI APIキー (`OPENAI_API_KEY`)

## セットアップ

1. [uv](https://github.com/astral-sh/uv) をインストールします (未導入の場合)。macOS/Linux では次のコマンドで導入できます。
   ```bash
   curl -LsSf https://astral.sh/uv/install.sh | sh
   ```
   Windows の場合は公式ドキュメントの PowerShell コマンドを利用してください。
2. `.env.example` をコピーして `.env` を作成し、必要な値を設定します。
   ```bash
   cp .env.example .env
   ```
   - `OPENAI_API_KEY`: OpenAIのAPIキー。
   - `OPENAI_MODEL`: 使用するモデル名 (例: `gpt-4.1-mini`)。
   - `SCRAPBOX_BASE_URL`: 独自ドメインでScrapboxを利用している場合に指定します (既定値は `https://scrapbox.io`)。

   ブラウザでScrapboxにログインしていれば、生成されたURLを開くだけで新しいページが作成されます。タイトルの指定ミスによる不要なページ生成を避けるため、ページ名を確認してから実行してください。

## 使い方

以下のコマンドで、指定した論文ページからPDFを検出・ダウンロードし、要約をScrapboxの新規ページとしてブラウザで開きます。

次のコマンドで、必要な依存関係を自動解決しつつ一時的な環境でスクリプトを実行できます。

```bash
uv run python paper_summary.py \
  "https://example.com/paper-page" \
  your-scrapbox-project \
  "論文タイトル" \
  --model gpt-4.1-mini
```

都度仮想環境を作成する必要がないため、最も手軽な実行方法です。

### 任意: ローカル仮想環境を使う場合

継続的に利用する場合はプロジェクト直下で次の手順を実行すると便利です (`.venv/` が生成されます)。

```bash
uv venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate
uv pip install --editable .
paper-summary "https://example.com/paper-page" your-scrapbox-project "論文タイトル" --model gpt-4.1-mini
```

`uv pip install` は `pip install` と同じ感覚で使える高速な代替コマンドです。

オプション:
- `--pdf-url`: ページからPDFリンクを特定できない場合に、直接PDFのURLを指定します。
- `--verbose`: 詳細ログを表示します。

ブラウザが起動し、Scrapboxにページが作成されます (先頭行にタイトル、以降に日本語要約が挿入された状態)。必要に応じてブラウザ上で編集・保存を行ってください。

## 注意事項

- ネットワークや認証に関わる環境変数は `.env` に保存し、Gitにはコミットしないでください。
- OpenAI APIの利用料金が発生するため、必要に応じてトークン使用量を監視してください。
