# 検証手順

サンプルが正しく動作することを確認する手順です。検証には2段階あります。

## 1. 構造検証（API キー不要 / CI）

必須ファイルの有無と JSON 形式を検証します。CI（GitHub Actions）でも自動実行されます。

```bash
./scripts/verify.sh
```

チェック内容:

- 各サンプルに `README.md` / `input.json` / `metadata.json` / `scripts/{curl.sh,node.js,python.py}` が揃っているか
- `input.json` / `metadata.json` が正しい JSON か
- `metadata.json` に必須キー（`reportType`, `title`, `templateSlug`, `templateGalleryUrl`, `apiVersion`, `apiEndpoint`, `verificationPoints`）が含まれるか

## 2. 生成検証（API キー・デザインID が必要）

実際に API を呼び出して PDF を生成し、期待結果と比較します。

### 前提

1. 対象テンプレートをワークスペースへ複製済みであること。
2. `.env` に `REPORTFLOW_API_KEY` と対象の `*_DESIGN_ID` が設定済みであること。

### 実行

```bash
# 個別
./scripts/generate.sh invoice

# すべて
./scripts/generate-all.sh
```

### 期待結果との比較

生成された `examples/<name>/output.pdf` を、`metadata.json` の内容と照合します。

- `expectedPages`: 生成 PDF のページ数と一致するか
- `verificationPoints`: 各観点（税計算、改ページ、日英表示など）が正しく反映されているか

問題なければ、`metadata.json` の `lastVerifiedAt`（検証日）と `verifiedEnvironment`（検証環境）を更新し、`output.pdf` をコミットします。

## 再検証

API やテンプレートが更新された場合は、上記「2. 生成検証」を再実行し、`output.pdf` と `metadata.json` を更新してください。手順を共通化しているため、全サンプルを `./scripts/generate-all.sh` で一括再生成できます。
