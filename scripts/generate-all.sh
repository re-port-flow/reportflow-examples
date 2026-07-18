#!/usr/bin/env bash
# すべてのサンプルの PDF を順に生成する。
#   使い方: ./scripts/generate-all.sh
#
# デザインID未設定など、個別サンプルで失敗しても最後まで続行し、末尾に結果を集計する。
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

ok=0; ng=0; failed=()
for d in "$REPO_ROOT"/examples/*/; do
  name="$(basename "$d")"
  echo "==================================================="
  echo "▶ $name"
  echo "==================================================="
  if bash "$d/scripts/curl.sh"; then
    ok=$((ok + 1))
  else
    ng=$((ng + 1)); failed+=("$name")
  fi
  echo
done

echo "==================================================="
echo "完了: 成功 $ok / 失敗 $ng"
if [ "$ng" -gt 0 ]; then
  echo "失敗したサンプル: ${failed[*]}"
  exit 1
fi
