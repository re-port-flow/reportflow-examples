# 労働者名簿 (worker-roster)

Re:port Flow の「労働者名簿」テンプレートから PDF を生成するサンプルです。労働者1名分の項目（フリガナ・氏名・生年月日・雇入れ年月日など）を差し込みます。日付項目や日本語表示を確認します。

- **検証観点**: 単一レコード / 日付項目（生年月日・雇入れ年月日） / 日本語表示
- **想定ページ数**: 1
- 備考: このテンプレートは明細配列を持たず、労働者1名分のフラットな項目で構成されます。
- **対応 API バージョン**: `v1`（`POST /v1/file/sync/single`）

## 手順

### 1. テンプレートを複製する

[テンプレートギャラリーの「労働者名簿」](https://templates.re-port-flow.com/templates/01K1X116H10VNP0GD5684VDB3Y) を開き、「テンプレートを複製」から自分の Re:port Flow ワークスペースへ複製します。

### 2. 自分のデザインIDを取得する

```bash
curl -s "https://api.re-port-flow.com/v1/file/designs" -H "appkey: $REPORTFLOW_API_KEY"
```

### 3. 環境変数を設定する

リポジトリルートの `.env`（`.env.example` をコピー）に設定します。

```dotenv
REPORTFLOW_API_KEY=ak_xxxxxxxxxxxxxxxx
WORKER_ROSTER_DESIGN_ID=（複製したデザインID）
WORKER_ROSTER_DESIGN_VERSION=1
```

### 4. 実行する

いずれか1つを実行すると、このディレクトリに `output.pdf` が生成されます。

```bash
./scripts/curl.sh          # curl (要 jq)
node scripts/node.js       # Node.js 18+
python3 scripts/python.py  # Python 3.8+
```

または、リポジトリルートから: `./scripts/generate.sh worker-roster`

## ファイル

| ファイル | 内容 |
|---|---|
| `input.json` | API へ渡す入力データ（`content.params` に対応） |
| `metadata.json` | 対応バージョン・検証観点・テンプレート情報 |
| `output.pdf` | 検証済みの期待出力（実行して生成・検証後にコミット） |
| `scripts/` | curl / Node.js / Python の実行例 |

## 注意事項

- `input.json` の各キーは **複製したテンプレートのパラメータ定義に合わせてください**。定義は `GET /v1/file/design/parameter/{designId}?version=1` で取得できます。
- 記載の値はすべてサンプルです。実データ・実在の個人／企業情報は含めていません。
- `appkey` は秘密情報です。`.env` はコミットしないでください（`.gitignore` 済み）。
