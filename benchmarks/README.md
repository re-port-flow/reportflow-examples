# PDF 生成ベンチマーク

Re:port Flow の PDF 生成 API（同期・非同期）の所要時間を、**自分のワークスペースで追試できる**
ベンチマークです。公開されている測定結果は <https://lp.re-port-flow.com/benchmarks/> にあります。

- **測定仕様（条件・統計・失敗判定・制限事項）**: [method.md](./method.md)
- **実行スクリプト**: [run.mjs](./run.mjs)（依存パッケージなし・Node.js 20.6 以上）

> このベンチマークは**レイテンシ**（1 リクエストの所要時間）を測ります。スループットや
> 負荷試験ではありません。理由と、他に測れていないことは [method.md §5](./method.md#5-この測定で分からないこと例外制限事項) を参照してください。

---

## 実行するとどうなるか（先に読んでください）

このスクリプトは**本番環境に対して実際に PDF を生成します**。生成されたファイルはワークスペースの
作成回数・従量課金の対象になります（[料金](https://lp.re-port-flow.com/#price)）。

既定のマトリクス（`config.default.json`）で **242 件**の PDF を生成します。
実行前に必ず `--dry-run` で件数を確認してください。

> **件数（`batchSize`）を既定の 5 より大きくしないでください。**
> 2026-08-06 に 20 件・50 件のバッチを含むマトリクスを通したところ、生成 API のコンテナが
> メモリを使い切って停止し、**API 全体が約 2 分間 503 を返す状態**になりました（詳細は
> [method.md §5-10](./method.md#5-この測定で分からないこと例外制限事項)）。レート上限には一度も
> 到達しておらず、上限を守っていれば安全とは限りません。本番環境は共有基盤なので、他の利用者にも影響します。
> 大きい件数を測る必要がある場合は、設定の `maxBatchSize` を上げたうえで、自分の環境の容量を
> 確認してから実行してください。

```bash
node benchmarks/run.mjs --dry-run
```

API は呼ばれず、シナリオ一覧・生成リクエスト数・生成 PDF 件数・所要時間の下限だけが表示されます。

---

## セットアップ

### 1. テンプレートを複製する

ベンチマークは「請求書」テンプレートを使います。テンプレートギャラリーから自分のワークスペースへ複製してください。

<https://templates.re-port-flow.com/templates/0eUPGyiGX8uzwE8L>

### 2. `.env` を設定する

リポジトリルートの `.env`（`.env.example` からコピー）に、API キーと複製したデザイン ID を設定します。
`examples/invoice` と同じ変数を使うので、サンプルを一度動かしていれば追加設定は不要です。

```bash
REPORTFLOW_API_KEY=ak_xxxxxxxxxxxxxxxx
INVOICE_DESIGN_ID=（複製したデザインID）
INVOICE_DESIGN_VERSION=1
```

デザイン ID は次でも確認できます。

```bash
curl -s "https://api.re-port-flow.com/v1/file/designs" -H "appkey: $REPORTFLOW_API_KEY"
```

### 3. 描画エンジンのフォールバックが起きていないか確認する

Re:port Flow は PDF 描画を専用サービスで行い、そこでエラーが起きると呼び出し元プロセス内の別実装へ
自動的にフォールバックします。**どちらが応答したかを示すヘッダは無いため、API の外側からは区別できません。**
フォールバック中に測ると、本来の生成経路ではないものを測ることになります。

運用側でメトリクスを見られる場合は、測定の前後で CloudWatch `ReportFlow/PdfService` の `Invocation`
（ディメンション `FallbackUsed=true`）が増えていないことを確認してください。見られない場合は、
その測定値が「どちらの経路のものか分からない値」であることを結果と一緒に明示してください。
詳細は [method.md §5-9](./method.md#5-この測定で分からないこと例外制限事項)。

### 4. 計測環境を申告する（推奨）

測定値にはインターネット区間が含まれるため、**どこから測ったか**が無いと数値を比較できません。
未設定なら結果には「未申告」と記録されます（推測では埋めません）。

```bash
export BENCHMARK_CLIENT_LOCATION="日本 / 東京"
export BENCHMARK_CLIENT_NETWORK="光回線 (FTTH)"
```

---

## 実行

```bash
# 疎通確認（4 エンドポイントを 3 試行ずつ。PDF 32 件・数分）
node benchmarks/run.mjs --config benchmarks/config.smoke.json

# 公開用マトリクス（PDF 242 件）
node benchmarks/run.mjs

# 1 シナリオだけ
node benchmarks/run.mjs --scenario sync-single-r50 --iterations 5
```

結果は `benchmarks/results/<YYYY-MM-DD>.json` に書き出されます（`--out` で変更可）。

### オプション

| オプション | 既定 | 説明 |
|---|---|---|
| `--dry-run` | — | API を呼ばず、実行計画と生成件数だけ表示する |
| `--config <path>` | `benchmarks/config.default.json` | 測定マトリクスの設定ファイル |
| `--scenario <id>` | 全件 | 指定した ID のシナリオだけ実行する |
| `--iterations <n>` | 設定ファイル | 全シナリオの試行回数を上書きする |
| `--warmup <n>` | 設定ファイル | 全シナリオのウォームアップ回数を上書きする |
| `--out <path>` | `benchmarks/results/<日付>.json` | 結果 JSON の出力先 |

---

## 入力データ

[`payloads/invoice.json`](./payloads/invoice.json) が入力のひな形です。`明細` 配列の 1 行目を
テンプレートとして、指定された行数ぶん複製します。

- 値がちょうど `"{{index}}"` なら**数値**の行番号に、文字列の一部に含まれるなら文字列として埋め込まれます。
- 小計・消費税・合計金額は生成された明細から再計算されます（行数を変えても金額が矛盾しないように）。
  計算対象のキーは設定ファイルの `payload.totals` で指定します。

データはすべて架空です。実在の個人・企業・取引情報は含みません。

---

## 結果 JSON の読み方

```jsonc
{
  "schemaVersion": 1,
  "startedAt": "2026-01-01T00:00:00.000Z",
  "client": { "location": "日本 / 東京", "network": "光回線 (FTTH)", "node": "v22.23.1" },
  "config": { "iterations": 20, "warmupIterations": 2, "concurrency": 1, ... },
  "scenarios": [
    {
      "id": "sync-single-r50",
      "endpoint": "sync/single",
      "lineItems": 50,          // 明細行数（入力）
      "batchSize": 1,           // 件数
      "pageCount": 3,           // 観測されたページ数（推定できなければ null）
      "pageCountMethod": "type-page+count-agree",
      "latencyMs": { "samples": 20, "median": 0, "p95": 0, "min": 0, "max": 0, "mean": 0 },
      "acceptedMs": null,       // 非同期のみ（202 受信までの時間）
      "failures": { "total": 0, "byReason": {}, "detail": [] },
      "rateLimited": 0          // 429 の発生回数（標本には含まない）
    }
  ]
}
```

- `latencyMs` は同期なら「PDF/ZIP 受信完了まで」、非同期なら「全ファイルがダウンロード可能になるまで」。
- `failures.total > 0` の条件は、中央値だけを見ずに必ず内訳（`byReason`）も見てください。
- `pageCount` が `null` は「測れなかった（未判定）」であって「0 ページ」ではありません。

各値の厳密な定義は [method.md](./method.md) にあります。

---

## トラブルシューティング

| 症状 | 原因と対処 |
|---|---|
| `REPORTFLOW_API_KEY が未設定です` | リポジトリルートの `.env` に `ak_...` を設定する |
| `INVOICE_DESIGN_ID が未設定です` | テンプレートを複製し、そのデザイン ID を設定する |
| `HTTP 400 ... must be a UUID` 等 | `INVOICE_DESIGN_ID` の値がデザイン ID になっていない |
| `失敗 http_error — HTTP 403 ... 上限` | 月間のファイル作成回数上限に達した。プランを確認する |
| `rateLimited` が増え続ける | 同じワークスペースで別の処理が API を使っていないか確認する |
| `poll_timeout` | 件数の多いシナリオで完了期限を超えた。`asyncCompletionTimeoutMs` を延ばす |
| `HTTP 503 upstream connect error` が続く | サーバー側が停止している可能性がある。`consecutiveFailureLimit` に達すると自動で中断する。復旧を確認してから再実行する（件数を上げていた場合は戻す） |

その他のエラーは [docs/troubleshooting.md](../docs/troubleshooting.md) を参照してください。
