#!/usr/bin/env bash
# Invoice (English) サンプル — 同期 PDF 生成 (POST /v1/file/sync/single)
# 依存: bash, curl, jq
set -euo pipefail

EX_DIR="$(cd "$(dirname "$0")/.." && pwd)"       # examples/invoice-en
REPO_ROOT="$(cd "$EX_DIR/../.." && pwd)"          # リポジトリルート
[ -f "$REPO_ROOT/.env" ] && { set -a; . "$REPO_ROOT/.env"; set +a; }

: "${REPORTFLOW_API_KEY:?REPORTFLOW_API_KEY を .env に設定してください (ak_...)}"
BASE_URL="${REPORTFLOW_API_BASE_URL:-https://api.re-port-flow.com/v1}"
DESIGN_ID="${INVOICE_EN_DESIGN_ID:?テンプレート複製後の自分のデザインIDを INVOICE_EN_DESIGN_ID に設定してください}"
VERSION="${INVOICE_EN_DESIGN_VERSION:-1}"

# input.json = content.params。リクエストボディを組み立てて POST する。
BODY="$(jq -n \
  --arg designId "$DESIGN_ID" \
  --argjson version "$VERSION" \
  --arg fileName "invoice-en.pdf" \
  --slurpfile params "$EX_DIR/input.json" \
  '{designId: $designId, version: $version, content: {fileName: $fileName, params: $params[0]}}')"

curl -sS -X POST "$BASE_URL/file/sync/single" \
  -H "appkey: $REPORTFLOW_API_KEY" \
  -H "Content-Type: application/json" \
  -d "$BODY" \
  --output "$EX_DIR/output.pdf"

echo "✓ $EX_DIR/output.pdf を生成しました"
