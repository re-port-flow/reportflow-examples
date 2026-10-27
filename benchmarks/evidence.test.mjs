import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { openEvidence, responseIdentity } from './evidence.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

describe('responseIdentity', () => {
  it('selects only request/file IDs, never URLs, params or passthrough', () => {
    const response = new Response('', { headers: { 'request-id': 'r-1', 'x-file-mapping': encodeURIComponent(JSON.stringify([
      { fileId: 'f-1', url: 'https://example.invalid/?token=secret', passthrough: { secret: 'hidden' } },
    ])) } });
    assert.deepEqual(responseIdentity(response), { requestId: 'r-1', fileIds: ['f-1'] });
    assert.deepEqual(responseIdentity(response, { requestId: 'a-1', files: [{ fileId: 'a-2', url: 'private' }] }),
      { requestId: 'a-1', fileIds: ['a-2'] });
  });
  it('handles absent/malformed mapping and rejects URLs as IDs', () => {
    assert.deepEqual(responseIdentity(new Response('', { headers: { 'x-file-mapping': '%broken' } })),
      { requestId: null, fileIds: [] });
    assert.deepEqual(responseIdentity(new Response(''), { requestId: 'https://private', files: [{ fileId: 'https://private' }] }),
      { requestId: null, fileIds: [] });
  });
});

describe('openEvidence', () => {
  it('writes durable JSONL privately, rejects repository paths and overwrite', async () => {
    const dir = await mkdtemp(resolve(tmpdir(), 'benchmark-evidence-'));
    try {
      await assert.rejects(openEvidence(resolve(root, 'evidence.jsonl'), root), /outside/);
      const path = resolve(dir, 'private.jsonl');
      const journal = await openEvidence(path, root);
      await journal.write({ type: 'test', latencyMs: 1.234567 });
      assert.equal((await stat(path)).mode & 0o777, 0o600);
      assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { type: 'test', latencyMs: 1.234567 });
      await journal.close();
      await assert.rejects(openEvidence(path, root), /EEXIST/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

async function runFixture(mode, options = {}) {
  const dir = await mkdtemp(resolve(tmpdir(), 'benchmark-run-'));
  let posts = 0;
  const server = createServer((req, res) => {
    req.resume();
    if (req.method === 'POST') posts++;
    if (mode === 'hang') return;
    if (mode === 'rate-limit') { res.writeHead(429, { 'retry-after': '0' }); res.end(); return; }
    if (mode === 'fail') { res.writeHead(500); res.end('private error-body'); return; }
    if (mode === 'bad-status') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ requestId: 'request-1', files: [{ fileId: 'file-1' }] }));
      return;
    }
    if (mode === 'async' && req.method === 'POST') {
      res.writeHead(202, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ requestId: 'request-1', files: [{ fileId: 'file-1', url: 'https://secret.invalid' }] }));
      return;
    }
    res.writeHead(200, { 'request-id': 'request-1', 'x-file-mapping': encodeURIComponent(JSON.stringify([{ fileId: 'file-1', url: 'secret' }])) });
    res.end('%PDF-1.7 /Type /Pages /Count 1 /Type /Page');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const config = JSON.parse(await readFile(resolve(root, 'benchmarks/config.smoke.json'), 'utf8'));
    config.apiBase = `http://127.0.0.1:${server.address().port}/v1`;
    config.scenarios = [{ id: 'fixture', endpoint: mode === 'async' || mode === 'bad-status' ? 'async/single' : 'sync/single', lineItems: 5 }];
    config.iterations = options.iterations ?? 1;
    config.warmupIterations = options.warmup ?? 0;
    config.consecutiveFailureLimit = 1;
    config.maxRateLimitRetries = 0;
    const configPath = resolve(dir, 'config.json');
    await writeFile(configPath, JSON.stringify(config));
    const journal = resolve(dir, 'evidence.jsonl');
    const output = resolve(dir, 'result.json');
    if (options.existingOutput) await writeFile(output, JSON.stringify({ preserved: true }));
    const child = spawn(process.execPath, [resolve(root, 'benchmarks/run.mjs'), '--config', configPath,
      '--out', output, '--evidence-out', journal, '--max-duration-ms', String(options.duration ?? 5000)], {
      env: { ...process.env, REPORTFLOW_API_KEY: 'fixture-secret', INVOICE_DESIGN_ID: 'fixture-design' },
    });
    let stdout = '';
    let signalled = false;
    child.stdout.on('data', (d) => {
      stdout += d;
      if (options.signal && !signalled && stdout.includes('▶')) {
        signalled = true;
        child.kill('SIGTERM');
      }
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    const code = await new Promise((r, reject) => { child.on('error', reject); child.on('close', r); });
    const report = JSON.parse(await readFile(output, 'utf8'));
    const rawEvents = await readFile(journal, 'utf8').catch(() => '');
    const events = rawEvents.trim() ? rawEvents.trim().split('\n').map(JSON.parse) : [];
    return { code, report, events, posts, stdout, stderr };
  } finally { server.closeAllConnections(); await new Promise((r) => server.close(r)); await rm(dir, { recursive: true, force: true }); }
}

describe('runner private evidence and stopping (local HTTP only)', () => {
  for (const mode of ['sync', 'async']) {
    it(`${mode}: raw precision and correlation persist separately from public aggregates`, async () => {
      const r = await runFixture(mode);
      assert.equal(r.code, 0, r.stderr);
      const trial = r.events.find((e) => e.type === 'trial_end');
      assert.equal(trial.requestId, 'request-1');
      assert.deepEqual(trial.fileIds, ['file-1']);
      assert.equal(trial.route, 'unverified');
      assert.ok(Number.isFinite(trial.latencyMs));
      assert.equal(r.report.scenarios[0].latencyMs.median, Math.round(trial.latencyMs * 10) / 10);
      assert.ok(Date.parse(trial.finishedAt) >= Date.parse(trial.startedAt));
      assert.equal(trial.statisticsCandidate, true);
      assert.equal(r.events.at(-1).type, 'run_end');
      assert.ok(!JSON.stringify(r.report).includes('request-1'));
      assert.ok(!JSON.stringify(r.events).includes('fixture-secret'));
      assert.ok(!JSON.stringify(r.events).includes('https://secret.invalid'));
    });
  }
  it('keeps warmup failures, stops before further POSTs, and hides arbitrary error bodies', async () => {
    const r = await runFixture('fail', { warmup: 1, iterations: 5 });
    assert.equal(r.code, 2);
    assert.equal(r.posts, 1);
    assert.equal(r.report.abortedEarly, true);
    assert.equal(r.report.scenarios[0].failures.total, 0);
    const end = r.events.find((e) => e.type === 'trial_end');
    assert.equal(end.warmup, true);
    assert.equal(end.ok, false);
    assert.equal(end.statisticsCandidate, false);
    assert.ok(!r.stdout.includes('private error-body'));
  });
  it('does not generate or overwrite an existing result file', async () => {
    const r = await runFixture('sync', { existingOutput: true });
    assert.equal(r.code, 1);
    assert.equal(r.posts, 0);
    assert.deepEqual(r.report, { preserved: true });
    assert.deepEqual(r.events, []);
  });
  it('records a 429 as excluded and stops without a retry', async () => {
    const r = await runFixture('rate-limit', { iterations: 3 });
    assert.equal(r.code, 2);
    assert.equal(r.posts, 1);
    const end = r.events.find((e) => e.type === 'trial_end');
    assert.equal(end.rateLimited, 1);
    assert.equal(end.statisticsCandidate, false);
    assert.equal(r.report.scenarios[0].latencyMs.samples, 0);
  });
  it('rejects non-202 async acceptance', async () => {
    const r = await runFixture('bad-status');
    assert.equal(r.code, 2);
    assert.equal(r.report.scenarios[0].failures.byReason.invalid_body, 1);
  });
  it('deadline aborts in-flight request, flushes evidence and marks report unpublishable', async () => {
    const r = await runFixture('hang', { duration: 250, iterations: 5 });
    assert.equal(r.code, 2, r.stderr);
    assert.equal(r.posts, 1);
    assert.equal(r.report.abortedEarly, true);
    assert.equal(r.events.find((e) => e.type === 'trial_end').ok, false);
  });
  it('SIGTERM stops further requests and still finalizes the partial report', async () => {
    const r = await runFixture('hang', { signal: true, iterations: 5 });
    assert.equal(r.code, 2, r.stderr);
    assert.ok(r.posts <= 1);
    assert.equal(r.report.abortedEarly, true);
    assert.equal(r.events.at(-1).abortedEarly, true);
  });
});
