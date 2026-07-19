# reportflow-examples

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

Re:port Flow 公式サンプル集 — テンプレートを複製し、入力データ JSON と API 実行例を使って完成 PDF を追試できる帳票サンプルの実装集です。

- **Re:port Flow**: <https://re-port-flow.com>
- **サンプル集（Webで閲覧）**: <https://doc.re-port-flow.com/examples>
- **テンプレートギャラリー**: <https://templates.re-port-flow.com>
- **API ドキュメント**: <https://doc.re-port-flow.com>

## このリポジトリの目的

Re:port Flow は、ブラウザ上のGUIエディタでデザインしたテンプレートに入力データを渡して PDF 帳票を生成するサービスです。本リポジトリは、**利用者が自分のワークスペースで完成 PDF を再現（追試）できる**ように、帳票ごとに次を提供します。

- テンプレートギャラリーへの複製リンク
- API へ渡す入力データ JSON（`input.json`）
- curl / Node.js / Python の最小 API 実行例
- 対応バージョン・検証観点などのメタデータ

> デザイン定義 JSON は配布しません。デザインはテンプレートギャラリーからワークスペースへ**複製**して利用します。GitHub で配布するのは、API へ渡す**入力データ JSON** と実行例です。

## 対象利用者

Re:port Flow の API を使って帳票 PDF を自動生成したい開発者・担当者。

## サンプル一覧

| サンプル | 帳票 | 主な検証観点 | 解説ページ |
|---|---|---|---|
| [invoice](examples/invoice/) | 請求書 | 複数明細 / 消費税10%・8%混在 / 端数処理 | [/examples/invoice](https://doc.re-port-flow.com/examples/invoice) |
| [quotation](examples/quotation/) | 見積もり | 小計・消費税・合計 / 有効期限 / 備考の長文 | [/examples/quotation](https://doc.re-port-flow.com/examples/quotation) |
| [invoice-en](examples/invoice-en/) | Invoice（英語） | 英数字 / 通貨 / 明細配列 | [/examples/invoice-en](https://doc.re-port-flow.com/examples/invoice-en) |
| [worker-roster](examples/worker-roster/) | 労働者名簿 | 単一レコード / 日付項目 | [/examples/worker-roster](https://doc.re-port-flow.com/examples/worker-roster) |
| [nda](examples/nda/) | 秘密保持誓約書 | 差込項目 / 長文の条項 | [/examples/nda](https://doc.re-port-flow.com/examples/nda) |

## 全体の流れ

```
1. テンプレートギャラリーで帳票を選ぶ
2. 「テンプレートを複製」で自分のワークスペースへ複製する
3. 複製したデザインのID（と version）を取得する
4. このリポジトリの input.json と実行例を取得する
5. .env に API キーとデザインIDを設定する
6. 実行して output.pdf を生成する
7. リポジトリ内の期待結果・検証観点と比較する
```

## セットアップ

### 1. API キーを発行する

Re:port Flow 管理画面のワークスペース詳細 →「API連携」タブで API キー（`ak_...`）を発行します。

### 2. `.env` を作成する

```bash
cp .env.example .env
# .env を編集して REPORTFLOW_API_KEY と各 *_DESIGN_ID を設定
```

デザインIDは、テンプレート複製後に次でも確認できます。

```bash
curl -s "https://api.re-port-flow.com/v1/file/designs" -H "appkey: $REPORTFLOW_API_KEY"
```

## 最短の API 実行例

同期エンドポイント `POST /v1/file/sync/single` は、PDF バイナリを直接返します。

```bash
curl -X POST https://api.re-port-flow.com/v1/file/sync/single \
  -H "appkey: ak_xxxxxxxxxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{
    "designId": "（複製したデザインID）",
    "version": 1,
    "content": {
      "fileName": "invoice.pdf",
      "params": { "invoiceNumber": "INV-2026-0001", "total": 475018 }
    }
  }' \
  --output invoice.pdf
```

- 認証ヘッダは **`appkey`**（`Authorization` や `X-API-Key` ではありません）。
- 入力データは **`content.params`** に渡します。
- 非同期版は `POST /v1/file/async/single`（202 で JSON を返し、`url` からダウンロード）。

詳細は [docs/](docs/) を参照してください。

## サンプルを実行する

各サンプルディレクトリで、または リポジトリルートから実行できます。

```bash
# 個別
./scripts/generate.sh invoice

# すべて
./scripts/generate-all.sh

# 直接（各サンプル内）
cd examples/invoice && ./scripts/curl.sh
```

生成された `output.pdf` を、各サンプルの検証観点・期待ページ数（`metadata.json`）と比較します。

## サンプルをコピー・改変する

1. 使いたいサンプルディレクトリ（例: `examples/invoice/`）を自分のプロジェクトにコピーします。
2. `input.json` の値を自分のデータに書き換えます。
3. `input.json` のキーは、複製したテンプレートのパラメータ定義に合わせてください。定義は次で取得できます。

   ```bash
   curl -s "https://api.re-port-flow.com/v1/file/design/parameter/（デザインID）?version=1" \
     -H "appkey: $REPORTFLOW_API_KEY"
   ```

## 対応 API バージョン

- Re:port Flow API: **`v1`**
- ベースURL: `https://api.re-port-flow.com/v1`（固定。設定不要）

バージョン・検証情報の詳細は [docs/compatibility.md](docs/compatibility.md) を参照してください。

## ドキュメント

- [docs/compatibility.md](docs/compatibility.md) — 対応バージョン・エンドポイント・制限値
- [docs/verification.md](docs/verification.md) — 検証手順
- [docs/troubleshooting.md](docs/troubleshooting.md) — よくあるエラーと対処

## ライセンス・コントリビューション・問題報告

- ライセンス: [MIT](LICENSE)
- コントリビューション: [CONTRIBUTING.md](CONTRIBUTING.md)
- 問題報告: [GitHub Issues](https://github.com/re-port-flow/reportflow-examples/issues)

サンプルデータはすべて架空であり、実在の個人・企業・取引情報は含みません。API キーなどの秘密情報はコミットしないでください。
