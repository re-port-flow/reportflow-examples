#!/usr/bin/env bash
# サンプルの構造検証（API キー不要 / CI 用）。
#   - 各サンプルに必須ファイルが揃っているか
#   - input.json / metadata.json が正しい JSON か
#   - metadata.json に必須キーが含まれるか
# API を実行して PDF を生成する検証ではない（それは scripts/generate*.sh）。
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REQUIRED_FILES=(README.md input.json metadata.json scripts/curl.sh scripts/node.js scripts/python.py)
REQUIRED_META_KEYS=(reportType title templateSlug templateGalleryUrl apiVersion apiEndpoint verificationPoints)

errors=0
note() { echo "  ✗ $1"; errors=$((errors + 1)); }

# JSON バリデータ（python3 優先、無ければ node）
json_check() {
  if command -v python3 >/dev/null 2>&1; then
    python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$1" 2>/dev/null
  elif command -v node >/dev/null 2>&1; then
    node -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))" "$1" 2>/dev/null
  else
    echo "python3 も node も見つかりません（JSON 検証不可）" >&2; return 2
  fi
}

meta_has_key() {
  if command -v python3 >/dev/null 2>&1; then
    python3 -c "import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if sys.argv[2] in d else 1)" "$1" "$2"
  else
    node -e "process.exit(Object.prototype.hasOwnProperty.call(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')), process.argv[2])?0:1)" "$1" "$2"
  fi
}

shopt -s nullglob
examples=("$REPO_ROOT"/examples/*/)
[ ${#examples[@]} -gt 0 ] || { echo "examples/ にサンプルがありません"; exit 1; }

echo "検証対象: ${#examples[@]} サンプル"
for d in "${examples[@]}"; do
  name="$(basename "$d")"
  echo "▶ $name"
  for f in "${REQUIRED_FILES[@]}"; do
    [ -f "$d/$f" ] || note "$name: 必須ファイルが無い: $f"
  done
  for j in input.json metadata.json; do
    if [ -f "$d/$j" ]; then
      json_check "$d/$j" || note "$name: $j が不正な JSON です"
    fi
  done
  if [ -f "$d/metadata.json" ]; then
    for k in "${REQUIRED_META_KEYS[@]}"; do
      meta_has_key "$d/metadata.json" "$k" || note "$name: metadata.json に必須キーが無い: $k"
    done
  fi
done

echo "==================================================="
if [ "$errors" -eq 0 ]; then
  echo "✓ すべての検証に合格しました"
else
  echo "✗ $errors 件のエラーがあります"
  exit 1
fi
