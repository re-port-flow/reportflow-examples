#!/usr/bin/env node
// 見積もり サンプル — 同期 PDF 生成 (POST /v1/file/sync/single)
// 依存: Node.js 18+ (グローバル fetch を使用。追加パッケージ不要)
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const exDir = path.resolve(__dirname, '..');            // examples/quotation
const repoRoot = path.resolve(exDir, '..', '..');

// .env を最小パース（KEY=VALUE 形式のみ）
const envPath = path.join(repoRoot, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const apiKey = process.env.REPORTFLOW_API_KEY;
if (!apiKey) { console.error('REPORTFLOW_API_KEY を .env に設定してください (ak_...)'); process.exit(1); }
const baseUrl = process.env.REPORTFLOW_API_BASE_URL || 'https://api.re-port-flow.com/v1';
const designId = process.env.QUOTATION_DESIGN_ID;
if (!designId) { console.error('テンプレート複製後の自分のデザインIDを QUOTATION_DESIGN_ID に設定してください'); process.exit(1); }
const version = parseInt(process.env.QUOTATION_DESIGN_VERSION || '1', 10);

const params = JSON.parse(fs.readFileSync(path.join(exDir, 'input.json'), 'utf8'));
const body = { designId, version, content: { fileName: 'quotation.pdf', params } };

(async () => {
  const res = await fetch(`${baseUrl}/file/sync/single`, {
    method: 'POST',
    headers: { appkey: apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    console.error(`APIエラー: ${res.status} ${res.statusText}`);
    console.error(await res.text());
    process.exit(1);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const out = path.join(exDir, 'output.pdf');
  fs.writeFileSync(out, buf);
  console.log(`✓ ${out} を生成しました`);
})().catch((e) => { console.error(e); process.exit(1); });
