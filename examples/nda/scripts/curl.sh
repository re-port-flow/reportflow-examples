#!/usr/bin/env bash
# 秘密保持誓約書 サンプル — 同期 PDF 生成 (POST /v1/file/sync/single)
# 依存: bash, curl, jq
set -euo pipefail

API_BASE="https://api.re-port-flow.com/v1"   # Re:port Flow 本番エンドポイント（固定）

EX_DIR="$(cd "$(dirname "$0")/.." && pwd)"       # examples/nda
REPO_ROOT="$(cd "$EX_DIR/../.." && pwd)"
[ -f "$REPO_ROOT/.env" ] && { set -a; . "$REPO_ROOT/.env"; set +a; }

: "${REPORTFLOW_API_KEY:?REPORTFLOW_API_KEY を .env に設定してください (ak_...)}"
DESIGN_ID="${NDA_DESIGN_ID:?テンプレート複製後の自分のデザインIDを NDA_DESIGN_ID に設定してください}"
VERSION="${NDA_DESIGN_VERSION:-2}"

# input.json = content.params。リクエストボディを組み立てて POST する。
BODY="$(jq -n \
  --arg designId "$DESIGN_ID" \
  --argjson version "$VERSION" \
  --arg fileName "秘密保持誓約書" \
  --slurpfile params "$EX_DIR/input.json" \
  '{designId: $designId, version: $version, content: {fileName: $fileName, params: $params[0]}}')"

# 応答を一時ファイルに受け、HTTPステータスとContent-Typeで成否を判定する
TMP="$(mktemp)"
STATUS="$(curl -sS -X POST "$API_BASE/file/sync/single" \
  -H "appkey: $REPORTFLOW_API_KEY" \
  -H "Content-Type: application/json" \
  -d "$BODY" \
  -o "$TMP" -w '%{http_code};%{content_type}')"
CODE="${STATUS%%;*}"
CTYPE="${STATUS#*;}"

if { [ "$CODE" = "200" ] || [ "$CODE" = "201" ]; } && printf '%s' "$CTYPE" | grep -qi '^application/pdf'; then
  mv "$TMP" "$EX_DIR/output.pdf"
  echo "✓ $EX_DIR/output.pdf を生成しました"
else
  echo "✗ 生成に失敗しました (HTTP $CODE, $CTYPE)" >&2
  echo "--- レスポンス ---" >&2
  cat "$TMP" >&2; echo >&2
  rm -f "$TMP"
  exit 1
fi
