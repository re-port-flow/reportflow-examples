# トラブルシューティング

サンプル実行時によくあるエラーと対処です。

## 412 Precondition Failed / `appkey` ヘッダが必要

`appkey` ヘッダが送信されていません。`.env` に `REPORTFLOW_API_KEY` を設定し、スクリプトがそれを読み込んでいるか確認してください。

```bash
grep REPORTFLOW_API_KEY .env
```

## 401 Unauthorized

API キーが不正、または失効しています。管理画面のワークスペース詳細 →「API連携」タブで有効なキー（`ak_...`）を再確認してください。認証ヘッダは `Authorization` ではなく **`appkey`** です。

## 404 Not Found / デザインが見つからない

- `designId` が誤っているか、そのキーが属するワークスペース以外のデザインを指定しています。API キーと同じワークスペースに複製したデザインのIDを指定してください。
- デザイン一覧で正しいIDを確認できます。

  ```bash
  curl -s "https://api.re-port-flow.com/v1/file/designs" -H "appkey: $REPORTFLOW_API_KEY"
  ```

## PDF は生成されるが値が反映されない / 空欄になる

`input.json` の `params` のキー名が、テンプレートのパラメータ定義と一致していません。テンプレート側の定義を取得して合わせてください。

```bash
curl -s "https://api.re-port-flow.com/v1/file/design/parameter/（デザインID）?version=1" \
  -H "appkey: $REPORTFLOW_API_KEY"
```

## 400 Bad Request

- `fileName` に使用不可文字（`/ \ : * ? " < > |`）が含まれていないか確認してください。
- `version` は整数である必要があります。
- ボディが正しい JSON か確認してください（`./scripts/verify.sh` で `input.json` の JSON 形式を検証できます）。

## 429 Too Many Requests

レート制限（同期 30 req/min）に達しています。時間をおいて再実行するか、`./scripts/generate-all.sh` の連続実行を控えてください。

## タイムアウト / 大きな帳票が生成できない

同期エンドポイントのタイムアウトは 120 秒です。大量明細など生成に時間がかかる帳票は、非同期エンドポイント `POST /v1/file/async/single` を利用し、返却された `url` からダウンロードしてください。

## `jq: command not found`（curl.sh）

`scripts/curl.sh` は `jq` を使用します。インストールするか、代わりに `node scripts/node.js` / `python3 scripts/python.py`（追加依存なし）を利用してください。

## それでも解決しない場合

[GitHub Issues](https://github.com/re-port-flow/reportflow-examples/issues) で報告してください（API キーなどの秘密情報は記載しないでください）。
