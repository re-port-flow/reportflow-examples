#!/usr/bin/env bash
# 指定した1サンプルの PDF を生成する。
#   使い方: ./scripts/generate.sh <example>
#   例:     ./scripts/generate.sh invoice
#
# 内部では各サンプルの scripts/curl.sh を呼び出す（要 curl, jq）。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

usage() {
  echo "使い方: $0 <example>"
  echo "利用可能なサンプル:"
  for d in "$REPO_ROOT"/examples/*/; do echo "  - $(basename "$d")"; done
  exit 1
}

[ $# -eq 1 ] || usage
EXAMPLE="$1"
EX_DIR="$REPO_ROOT/examples/$EXAMPLE"
[ -d "$EX_DIR" ] || { echo "不明なサンプル: $EXAMPLE"; usage; }

echo "▶ $EXAMPLE の PDF を生成します..."
bash "$EX_DIR/scripts/curl.sh"
