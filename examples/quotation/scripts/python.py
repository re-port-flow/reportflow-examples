#!/usr/bin/env python3
# 見積もり サンプル — 同期 PDF 生成 (POST /v1/file/sync/single)
# 依存: Python 3.8+ (標準ライブラリのみ。追加パッケージ不要)
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

API_BASE = "https://api.re-port-flow.com/v1"  # Re:port Flow 本番エンドポイント（固定）

ex_dir = Path(__file__).resolve().parent.parent          # examples/quotation
repo_root = ex_dir.parent.parent

# .env を最小パース（KEY=VALUE 形式のみ）
env_path = repo_root / ".env"
if env_path.exists():
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip("\"'"))

api_key = os.environ.get("REPORTFLOW_API_KEY")
if not api_key:
    sys.exit("REPORTFLOW_API_KEY を .env に設定してください (ak_...)")
design_id = os.environ.get("QUOTATION_DESIGN_ID")
if not design_id:
    sys.exit("テンプレート複製後の自分のデザインIDを QUOTATION_DESIGN_ID に設定してください")
version = int(os.environ.get("QUOTATION_DESIGN_VERSION", "1"))

params = json.loads((ex_dir / "input.json").read_text(encoding="utf-8"))
body = {"designId": design_id, "version": version,
        "content": {"fileName": "quotation.pdf", "params": params}}

req = urllib.request.Request(
    f"{API_BASE}/file/sync/single",
    data=json.dumps(body).encode("utf-8"),
    headers={"appkey": api_key, "Content-Type": "application/json"},
    method="POST",
)
try:
    with urllib.request.urlopen(req, timeout=130) as res:
        ctype = res.headers.get("Content-Type", "")
        data = res.read()
        if "application/pdf" not in ctype:
            sys.exit(f"✗ 生成に失敗しました (予期しない応答: {ctype})\n{data.decode('utf-8', 'replace')}")
        out = ex_dir / "output.pdf"
        out.write_bytes(data)
        print(f"✓ {out} を生成しました")
except urllib.error.HTTPError as e:
    sys.exit(f"✗ 生成に失敗しました (HTTP {e.code} {e.reason})\n{e.read().decode('utf-8', 'replace')}")
