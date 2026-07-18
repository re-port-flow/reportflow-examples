# 請求書 (invoice)

Re:port Flow の「請求書」テンプレートから PDF を生成するサンプルです。

- **検証観点**: 複数明細 / 消費税 10%・8% 混在 / 端数処理 / 日本語表示
- **想定ページ数**: 1
- **対応 API バージョン**: `v1`（`POST /v1/file/sync/single`）

## 手順

### 1. テンプレートを複製する

[テンプレートギャラリーの「請求書」](https://templates.re-port-flow.com/templates/0eUPGyiGX8uzwE8L) を開き、「テンプレートを複製」から自分の Re:port Flow ワークスペースへ複製します。

### 2. 自分のデザインIDを取得する

複製したデザインの ID を取得します（API からも取得できます）。

```bash
curl -s "https://api.re-port-flow.com/v1/file/designs" -H "appkey: $REPORTFLOW_API_KEY"
```

### 3. 環境変数を設定する

リポジトリルートの `.env`（`.env.example` をコピー）に設定します。

```dotenv
REPORTFLOW_API_KEY=ak_xxxxxxxxxxxxxxxx
INVOICE_DESIGN_ID=（複製したデザインID）
INVOICE_DESIGN_VERSION=1
```

### 4. 実行する

いずれか1つを実行すると、このディレクトリに `output.pdf` が生成されます。

```bash
# curl (要 jq)
./scripts/curl.sh

# Node.js 18+
node scripts/node.js

# Python 3.8+
python3 scripts/python.py
```

または、リポジトリルートから: `./scripts/generate.sh invoice`

## ファイル

| ファイル | 内容 |
|---|---|
| `input.json` | API へ渡す入力データ（`content.params` に対応） |
| `metadata.json` | 対応バージョン・検証観点・テンプレート情報 |
| `output.pdf` | 検証済みの期待出力（実行して生成・検証後にコミット） |
| `scripts/` | curl / Node.js / Python の実行例 |

## 注意事項

- `input.json` の各キーは **複製したテンプレートのパラメータ定義に合わせてください**。定義は `GET /v1/file/design/parameter/{designId}?version=1` で取得できます。テンプレート側のキー名が異なる場合は `input.json` を調整してください。
- 金額・税額はサンプル値です。実データ・実在の個人／企業情報は含めていません。
- `appkey` は秘密情報です。`.env` はコミットしないでください（`.gitignore` 済み）。
