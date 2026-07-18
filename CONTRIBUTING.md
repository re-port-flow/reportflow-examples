# コントリビューションガイド

reportflow-examples へのご協力ありがとうございます。新しい帳票サンプルの追加や既存サンプルの改善を歓迎します。

## 基本ルール

- **秘密情報をコミットしない**: API キー（`ak_...`）、内部URL、トークン等は絶対に含めないでください。設定は `.env`（`.gitignore` 済み）に置きます。
- **実データを使わない**: サンプルデータは架空のものにしてください。実在の個人・企業・取引情報は使用しないでください。
- **デザイン定義 JSON を配布しない**: 配布物は入力データ JSON（`input.json`）と実行例に限ります。デザインはテンプレートギャラリー経由で複製する導線とします。

## 新しいサンプルを追加する手順

1. 対応するテンプレートが[テンプレートギャラリー](https://templates.re-port-flow.com)に公開されていることを確認します。
2. `examples/<name>/` を作成し、次のファイルを用意します。

   ```
   examples/<name>/
   ├── README.md        # 概要・複製リンク・実行手順・検証観点・注意事項
   ├── input.json       # API へ渡す入力データ（content.params）
   ├── metadata.json    # 対応バージョン・検証観点・テンプレート情報
   ├── output.pdf       # 検証済みの期待出力（生成・検証後にコミット）
   └── scripts/
       ├── curl.sh
       ├── node.js
       └── python.py
   ```

3. `.env.example` に `<NAME>_DESIGN_ID` / `<NAME>_DESIGN_VERSION` を追記します。
4. `metadata.json` には最低限、次を記載します。

   - `reportType`, `title`, `templateSlug`, `templateGalleryUrl`
   - `apiVersion`, `apiEndpoint`
   - `verificationPoints`, `expectedPages`
   - `lastVerifiedAt`, `verifiedEnvironment`（検証実施後に記入）

## 提出前チェック

```bash
# 構造・JSON 検証（API キー不要）
./scripts/verify.sh

# 実際に PDF が生成できることを確認（API キー・デザインID が必要）
./scripts/generate.sh <name>
```

`./scripts/verify.sh` は CI でも実行されます。必須ファイルの欠落や不正な JSON があるとマージできません。

## コミット・PR

- ブランチを作成して変更し、Pull Request を作成してください（`main` への直接 push は保護されています）。
- PR には、追加・変更したサンプルと検証結果（生成できたか、期待ページ数と一致したか）を記載してください。
