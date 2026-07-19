# 対応バージョン・エンドポイント

## API バージョン

| 項目 | 値 |
|---|---|
| API バージョン | `v1` |
| ベースURL | `https://api.re-port-flow.com/v1`（固定） |
| 認証ヘッダ | `appkey: ak_...` |

各サンプルが対応する API バージョンは、それぞれの `metadata.json` の `apiVersion` に記載しています。

## PDF 生成エンドポイント

| 用途 | メソッド + パス | レスポンス |
|---|---|---|
| 単一PDF（同期） | `POST /v1/file/sync/single` | `201` + PDF バイナリを直接返却 |
| 単一PDF（非同期） | `POST /v1/file/async/single` | `202` + JSON（`requestId`, `url`, `files`） |
| 複数PDF（同期・ZIP） | `POST /v1/file/sync/multiple` | `201` + ZIP バイナリ |
| 複数PDF（非同期・ZIP） | `POST /v1/file/async/multiple` | `202` + JSON |
| ダウンロード（ZIP一括） | `GET /v1/file/download/{requestId}` | `200` + ZIP |
| ダウンロード（個別） | `GET /v1/file/download/{requestId}/{fileId}` | `200` + PDF |
| デザイン一覧 | `GET /v1/file/designs` | `200` + JSON |
| デザインのパラメータ構造 | `GET /v1/file/design/parameter/{designId}?version=` | `200` + JSON |

本リポジトリのサンプルは、最も単純な **同期・単一PDF** (`POST /v1/file/sync/single`) を使用します。

## リクエストボディ（sync/single, async/single）

```jsonc
{
  "designId": "（複製したデザインID）",  // 必須 (string)
  "version": 1,                          // 必須 (integer)
  "content": {
    "fileName": "invoice.pdf",           // 必須 (string) 使用不可文字: / \ : * ? " < > |
    "params": { }                        // 必須 (object) テンプレートへ渡す入力データ
    // shareType, passcodeEnabled, passthrough は任意
  }
}
```

- 入力データはすべて `content.params` に渡します。ページ設定やフォーマット指定のパラメータはボディには存在しません（レイアウトはデザイン側に内包されます）。
- `params` のキーは、複製したテンプレートのパラメータ定義に一致させる必要があります。

## 制限値（目安）

| 項目 | 値 |
|---|---|
| リクエストボディ上限 | 50 MB |
| 同期リクエストのタイムアウト | 120 秒 |
| レート制限（同期） | 30 req/min |
| レート制限（非同期・ダウンロード） | 100 req/min |

制限値は変更される場合があります。最新は [API ドキュメント](https://doc.re-port-flow.com) を確認してください。
