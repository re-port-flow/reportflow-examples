# 測定結果

`node benchmarks/run.mjs` の出力（`<YYYY-MM-DD>.json`）を置くディレクトリです。

このリポジトリにコミットされている結果は、<https://lp.re-port-flow.com/benchmarks/> で公開している
数値の**元データ**です。公開ページは同じ JSON をそのまま読んで表にしているため、両者の数値は一致します。

読み方と各値の定義は [../method.md](../method.md) を参照してください。特に次に注意してください。

- `pageCount` が `null` は「測れなかった（未判定）」であって「0 ページ」ではありません。
- `failures.total > 0` の条件は、中央値だけでなく必ず内訳（`byReason`）も見てください。
- `client.location` / `client.network` が「未申告」の結果は、測定値をどこから測ったか分からないため、
  他の測定と比較できません。

自分で測った結果をここに置く必要はありません（`--out` で任意の場所に出力できます）。
