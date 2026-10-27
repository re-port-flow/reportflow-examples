#!/usr/bin/env node
/**
 * Re:port Flow PDF 生成ベンチマーク実行スクリプト。
 *
 * 測定条件・統計・失敗判定の定義は benchmarks/method.md を一次情報とする。本ファイルは
 * その手順の実装であり、method.md と食い違ったら method.md を正とする。
 * 集計・ペイロード生成などの純粋ロジックは lib.mjs にあり、lib.test.mjs で固定している。
 *
 * 設計方針:
 *   - 依存パッケージなし（Node 20.6+ 標準ライブラリのみ）。第三者が clone して
 *     `node benchmarks/run.mjs` だけで動く状態を保つため。
 *   - 逐次実行（同時実行数 1）。**レイテンシのベンチマークであって、スループット
 *     やロードテストではない。** 並列で叩くと自分の負荷を測ることになる。
 *   - 生成の失敗は自動リトライしない。429（レート上限）だけは、リクエストが受理されず
 *     PDF も生成されていないので Retry-After に従って待ち直す。
 *
 * 使い方:
 *   node benchmarks/run.mjs --dry-run            # 実行計画と生成ファイル数だけ表示
 *   node benchmarks/run.mjs                      # config.default.json で実測
 *   node benchmarks/run.mjs --config benchmarks/config.smoke.json
 *   node benchmarks/run.mjs --scenario sync-single-r5 --iterations 5
 */
import { readFile, open, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { openEvidence, responseIdentity } from './evidence.mjs';

import {
  FAILURE,
  MIN_ITERATIONS_FOR_P95,
  RESULT_SCHEMA_VERSION,
  buildParams,
  buildPlan,
  buildRequestBody,
  countFailuresByReason,
  estimateFloorSeconds,
  estimatePdfPageCount,
  intervalMsFor,
  looksLikePdf,
  looksLikeZip,
  median,
  normalizeScenarios,
  pickCompletionMs,
  summarize,
} from './lib.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');

let runSignal;
const sleep = (ms) => delay(ms, undefined, { signal: runSignal });
const requestSignal = (ms) => runSignal ? AbortSignal.any([runSignal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);

// ---------------------------------------------------------------------------
// 入力（.env / 引数）
// ---------------------------------------------------------------------------

/**
 * `.env` を読んで process.env に反映する（既存の環境変数は上書きしない）。
 *
 * 各サンプルは bash の `set -a; . .env` で読んでいるが、こちらは Node なので
 * 最小のパーサを持つ。`export KEY=VALUE`・行コメント・引用符に対応する。
 */
async function loadDotEnv(path) {
  if (!existsSync(path)) return;
  const text = await readFile(path, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    let value = rawValue.trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

/** `--key value` / `--flag` 形式の最小パーサ。 */
function parseArgs(argv) {
  const args = { flags: new Set(), values: new Map() };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args.flags.add(key);
    } else {
      args.values.set(key, next);
      i += 1;
    }
  }
  return args;
}

function resolveFromRepo(path) {
  return isAbsolute(path) ? path : resolve(REPO_ROOT, path);
}

/** `--iterations` などの数値オプション。不正値は実行前に弾く。 */
function readIntOption(args, name) {
  if (!args.values.has(name)) return undefined;
  const raw = args.values.get(name);
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new Error(`--${name} には整数を指定してください（受け取った値: ${raw}）`);
  return value;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/**
 * 一定間隔を空けるペーサ。レート上限に自分からぶつからないために使う。
 *
 * 待ち時間は**計測窓の外**で消化する（`pace()` を t0 の前に呼ぶ）。中で待つと
 * 待機時間がレイテンシとして計上されてしまう。
 */
function createPacer(minIntervalMs) {
  let nextAllowedAt = 0;
  return async function pace() {
    const waitMs = nextAllowedAt - Date.now();
    if (waitMs > 0) await sleep(waitMs);
    nextAllowedAt = Date.now() + minIntervalMs;
  };
}

function classifyThrown(error) {
  const name = error?.name ?? '';
  if (name === 'TimeoutError' || name === 'AbortError') return FAILURE.TIMEOUT;
  return FAILURE.NETWORK_ERROR;
}

/** `Retry-After`（秒）をミリ秒で返す。欠落・不正なら既定値。 */
function retryAfterMs(response, fallbackMs) {
  const raw = response.headers.get('retry-after');
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : fallbackMs;
}

const discardBody = (response) => response.body?.cancel().catch(() => {});

/**
 * 429 のときだけ Retry-After に従って待ち直す。
 *
 * 429 は**リクエストが受理されず PDF も生成されていない**ので、待って投げ直しても
 * 二重生成にならない。それ以外のエラー（5xx 等）はリトライせず、そのまま失敗として
 * 記録する（成功するまで叩き直すと、実際の失敗率が結果から消えるため）。
 *
 * `rateLimited` を返すのは、**待ち直した試行を標本から外す**ため。計測は最初の送信
 * から始まっているので、Retry-After の待機（既定 60 秒）がそのままレイテンシとして
 * 乗ってしまう。成功はしていても製品の所要時間ではないので、統計には入れない。
 */
async function postWithRateLimitBackoff(fn, { maxRateLimitRetries, fallbackRetryAfterMs, onRateLimited }) {
  let rateLimited = false;
  for (let attempt = 0; attempt <= maxRateLimitRetries; attempt += 1) {
    const response = await fn();
    if (response.status !== 429) return { response, rateLimited };
    rateLimited = true;
    onRateLimited();
    const waitMs = retryAfterMs(response, fallbackRetryAfterMs);
    await discardBody(response);
    if (attempt === maxRateLimitRetries) return { response, rateLimited };
    await sleep(waitMs);
  }
  throw new Error('unreachable');
}

function postGenerate(ctx, scenario, body) {
  return postWithRateLimitBackoff(
    () =>
      fetch(`${ctx.apiBase}/file/${scenario.endpoint}`, {
        method: 'POST',
        headers: { appkey: ctx.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: requestSignal(ctx.config.syncRequestTimeoutMs),
      }),
    ctx.rateLimitOptions,
  );
}

async function readErrorDetail(response) {
  await discardBody(response);
  return `HTTP ${response.status}`;
}

// ---------------------------------------------------------------------------
// 1 試行の実行
// ---------------------------------------------------------------------------

/** 同期エンドポイント 1 回。レスポンス本文（PDF / ZIP）の受信完了までを測る。 */
async function runSyncIteration(ctx, scenario, body) {
  const isMultiple = scenario.endpoint.endsWith('/multiple');
  await ctx.pacers.sync();

  ctx.measurementStartedAt = new Date().toISOString();
  const startedAt = performance.now();
  let response;
  let rateLimited = false;
  try {
    ({ response, rateLimited } = await postGenerate(ctx, scenario, body));
  } catch (error) {
    return { ok: false, reason: classifyThrown(error), detail: String(error?.message ?? error) };
  }

  if (response.status === 429) {
    await discardBody(response);
    return { ok: false, reason: FAILURE.RATE_LIMIT_EXHAUSTED, detail: 'HTTP 429（再送上限に到達）' };
  }
  if (!response.ok) {
    return { ok: false, reason: FAILURE.HTTP_ERROR, detail: await readErrorDetail(response) };
  }

  ctx.identity = responseIdentity(response);
  let buffer;
  try {
    buffer = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    return { ok: false, reason: classifyThrown(error), detail: String(error?.message ?? error) };
  }
  const latencyMs = performance.now() - startedAt;

  if (!(isMultiple ? looksLikeZip(buffer) : looksLikePdf(buffer))) {
    return {
      ok: false,
      reason: FAILURE.INVALID_BODY,
      detail: `期待した ${isMultiple ? 'ZIP' : 'PDF'} ではない (content-type=${response.headers.get('content-type')}, bytes=${buffer.length})`,
    };
  }

  // ZIP の中身のページ数は展開しないと分からないので推定しない（未判定のまま出す）。
  const page = isMultiple ? { pageCount: null, method: 'not-applicable-zip' } : estimatePdfPageCount(buffer);
  return {
    ok: true,
    rateLimited,
    latencyMs,
    outputBytes: buffer.length,
    pageCount: page.pageCount,
    pageCountMethod: page.method,
  };
}

/**
 * 非同期エンドポイント 1 回。2 つの値を測る。
 *   acceptedMs … 送信 → 202 受信（呼び出し側がブロックされる時間）
 *   latencyMs  … 送信 → 全ファイルがダウンロード可能になるまで（完了時間）
 */
async function runAsyncIteration(ctx, scenario, body) {
  await ctx.pacers.async();

  ctx.measurementStartedAt = new Date().toISOString();
  const startedAt = performance.now();
  let response;
  let rateLimited = false;
  try {
    ({ response, rateLimited } = await postGenerate(ctx, scenario, body));
  } catch (error) {
    return { ok: false, reason: classifyThrown(error), detail: String(error?.message ?? error) };
  }

  if (response.status === 429) {
    await discardBody(response);
    return { ok: false, reason: FAILURE.RATE_LIMIT_EXHAUSTED, detail: 'HTTP 429（再送上限に到達）' };
  }
  if (!response.ok) {
    return { ok: false, reason: FAILURE.HTTP_ERROR, detail: await readErrorDetail(response) };
  }

  if (response.status !== 202) {
    await discardBody(response);
    return { ok: false, reason: FAILURE.INVALID_BODY, detail: 'Expected HTTP 202' };
  }
  let accepted;
  try {
    accepted = await response.json();
  } catch (error) {
    return { ok: false, reason: FAILURE.INVALID_BODY, detail: String(error?.message ?? error) };
  }
  const acceptedMs = performance.now() - startedAt;

  const files = Array.isArray(accepted?.files) ? accepted.files : [];
  if (!accepted?.requestId || files.length !== scenario.batchSize) {
    return {
      ok: false,
      reason: FAILURE.INVALID_BODY,
      detail: `202 の識別子またはfiles件数が不正（期待 ${scenario.batchSize} 件）`,
    };
  }

  ctx.identity = responseIdentity(response, accepted);
  const completion = await waitForCompletion(ctx, { requestId: accepted.requestId, files, startedAt });
  if (!completion.ok) return { ok: false, reason: completion.reason, detail: completion.detail };

  return {
    ok: true,
    // ダウンロードのポーリング中に 429 を見た場合も、待機がそのまま完了時間に
    // 乗るので標本から外す。
    rateLimited: rateLimited || completion.rateLimited,
    acceptedMs,
    latencyMs: completion.completionMs,
    outputBytes: completion.outputBytes,
    pageCount: completion.pageCount,
    pageCountMethod: completion.pageCountMethod,
  };
}

/**
 * 非同期の完了を検知する。
 *
 * `GET /file/download/{requestId}/{fileId}` は生成中 404、完了後 200 を返す。
 * `contents` はおおむね配列順に処理され、各ファイルは生成し終えた時点で個別に取得可能になる。
 * したがって末尾がいちばん遅く仕上がりやすいので、まず末尾を監視し、200 になってから
 * 残りを逆順に 1 巡して全件を確認する。毎回全件を叩くと、ダウンロードのレート上限
 *（100 req/分）に自分でぶつかり、その待ち時間が完了時間として計上されてしまう。
 *
 * 完了時刻はヘッダ受信時点で取る（本文の転送時間を完了時間に混ぜない）。
 * サイズとページ数は先頭ファイル 1 件だけ実体を読み、残りは本文を破棄する。
 *
 * **完了時刻の基準は「配列末尾のファイルが 200 になった時点」**。掃引で回る残りの
 * ファイルは既に生成済みなので、こちらのペーシング（ダウンロード 750ms 間隔）で
 * 掛かった時間を完了時間に足してはいけない。50 件のバッチなら掃引だけで 37 秒あり、
 * それをそのまま計上すると完了時間が実態の数倍になる。掃引中に 404 を見た
 * （＝本当にまだ生成中だった）ファイルがあった場合だけ、その確認時刻へ更新する。
 * 完了順は保証されないので、この 1 巡が順序の前提が崩れた場合の取りこぼしを拾う。
 */
async function waitForCompletion(ctx, { requestId, files, startedAt }) {
  const remaining = files.map((f) => f.fileId).reverse();
  const firstFileId = files[0].fileId;
  const deadlineAt = startedAt + ctx.config.asyncCompletionTimeoutMs;
  /** 404（生成中）を実際に観測したファイル。掃引で待たされた証拠になる。 */
  const waitedFor = new Set();
  let completionMs = null;
  let outputBytes = null;
  let rateLimited = false;
  let page = { pageCount: null, method: 'not-measured' };

  while (remaining.length > 0) {
    if (performance.now() > deadlineAt) {
      return {
        ok: false,
        reason: FAILURE.POLL_TIMEOUT,
        detail: `${remaining.length}/${files.length} 件が ${ctx.config.asyncCompletionTimeoutMs}ms 以内に取得できなかった`,
      };
    }
    const fileId = remaining[0];
    await ctx.pacers.download();

    let res;
    try {
      res = await fetch(`${ctx.apiBase}/file/download/${requestId}/${fileId}`, {
        headers: { appkey: ctx.apiKey },
        signal: requestSignal(ctx.config.downloadRequestTimeoutMs),
      });
    } catch (error) {
      return { ok: false, reason: classifyThrown(error), detail: String(error?.message ?? error) };
    }

    if (res.status === 404) {
      await discardBody(res);
      waitedFor.add(fileId);
      await sleep(ctx.config.pollIntervalMs);
      continue;
    }
    if (res.status === 429) {
      await discardBody(res);
      ctx.counters.rateLimited += 1;
      rateLimited = true;
      await sleep(retryAfterMs(res, ctx.config.fallbackRetryAfterMs));
      continue;
    }
    if (!res.ok) {
      return { ok: false, reason: FAILURE.HTTP_ERROR, detail: `download ${await readErrorDetail(res)}` };
    }

    completionMs = pickCompletionMs(completionMs, performance.now(), waitedFor.has(fileId));
    remaining.shift();

    if (fileId === firstFileId) {
      const buffer = Buffer.from(await res.arrayBuffer());
      if (!looksLikePdf(buffer)) {
        return {
          ok: false,
          reason: FAILURE.INVALID_BODY,
          detail: `download が PDF ではない (content-type=${res.headers.get('content-type')}, bytes=${buffer.length})`,
        };
      }
      outputBytes = buffer.length;
      page = estimatePdfPageCount(buffer);
    } else {
      await discardBody(res);
    }
  }

  return {
    ok: true,
    rateLimited,
    completionMs: completionMs - startedAt,
    outputBytes,
    pageCount: page.pageCount,
    pageCountMethod: page.method,
  };
}

// ---------------------------------------------------------------------------
// シナリオ実行と集計
// ---------------------------------------------------------------------------

async function runScenario(ctx, scenario) {
  const params = buildParams({
    template: ctx.payload.template,
    lineItemsKey: ctx.payload.lineItemsKey,
    rowCount: scenario.lineItems,
    totals: ctx.payload.totals,
  });

  const isAsync = scenario.endpoint.startsWith('async/');
  const latencies = [];
  const acceptedTimes = [];
  const outputBytes = [];
  const pageCounts = new Set();
  const pageCountMethods = new Set();
  const failures = [];
  const rateLimitedBefore = ctx.counters.rateLimited;
  /**
   * 連続失敗でその場で中断するためのカウンタ（サーキットブレーカ）。
   *
   * サーバー側が応答できない状態になったあとも試行を投げ続けるのは、復旧の邪魔に
   * しかならないうえ、得られるのは同じエラーの山だけ。続けて失敗したら止める。
   */
  let consecutiveFailures = 0;
  let aborted = false;

  const total = scenario.warmupIterations + scenario.iterations;
  for (let i = 0; i < total; i += 1) {
    const isWarmup = i < scenario.warmupIterations;
    const label = isWarmup ? `w${i + 1}` : `${i - scenario.warmupIterations + 1}`;
    const body = buildRequestBody({
      scenario,
      design: ctx.design,
      params,
      fileNamePrefix: ctx.payload.fileNamePrefix,
      iterationLabel: `${ctx.runToken}-${label}`,
    });

    if (runSignal?.aborted) { aborted = true; break; }
    const trialStartedAt = new Date().toISOString();
    ctx.trial = { runId: ctx.runToken, conditionId: scenario.id, iteration: label, warmup: isWarmup };
    ctx.identity = { requestId: null, fileIds: [] };
    ctx.measurementStartedAt = null;
    const rateLimitedStart = ctx.counters.rateLimited;
    await ctx.journal?.write({ type: 'trial_start', ...ctx.trial, scheduledAt: trialStartedAt,
      endpoint: scenario.endpoint, lineItems: scenario.lineItems, batchSize: scenario.batchSize });
    let result;
    try {
      result = isAsync ? await runAsyncIteration(ctx, scenario, body) : await runSyncIteration(ctx, scenario, body);
    } catch (error) {
      result = { ok: false, reason: classifyThrown(error), detail: 'Trial interrupted or could not complete' };
    }
    await ctx.journal?.write({ type: 'trial_end', ...ctx.trial, startedAt: ctx.measurementStartedAt, scheduledAt: trialStartedAt,
      finishedAt: new Date().toISOString(), ...ctx.identity, ok: result.ok,
      reason: result.reason ?? null, latencyMs: result.latencyMs ?? null,
      acceptedMs: result.acceptedMs ?? null, pageCount: result.pageCount ?? null,
      pageCountMethod: result.pageCountMethod ?? null, outputBytes: result.outputBytes ?? null,
      rateLimited: ctx.counters.rateLimited - rateLimitedStart,
      statisticsCandidate: result.ok && !result.rateLimited && !isWarmup && !runSignal?.aborted,
      route: 'unverified' });
    if (runSignal?.aborted) aborted = true;

    console.log(
      `  ${scenario.id} ${isWarmup ? '(warmup) ' : ''}${label}: ` +
        (result.ok
          ? `${Math.round(result.latencyMs)}ms${result.rateLimited ? '（429 待機を含むため標本から除外）' : ''}`
          : `失敗 ${result.reason} — ${result.detail}`),
    );

    // 連続失敗の判定はウォームアップも含めて数える（落ちているサービスを
    // 叩き続けないことが目的なので、統計の対象かどうかとは別の話）。
    if (result.ok) {
      consecutiveFailures = 0;
    } else {
      consecutiveFailures += 1;
      if (consecutiveFailures >= ctx.config.consecutiveFailureLimit) {
        console.log(
          `  ${scenario.id}: ${consecutiveFailures} 回連続で失敗したため中断します。` +
            'サーバー側が停止している可能性があります（復旧を確認してから再実行してください）。',
        );
        aborted = true;
      }
    }

    // ウォームアップは統計にも失敗件数にも含めない（method.md §2.4）。
    if (isWarmup) {
      if (aborted) break;
      continue;
    }

    if (!result.ok) {
      failures.push({ iteration: label, reason: result.reason, detail: result.detail });
      if (aborted) break;
      continue;
    }
    // 429 で待ち直した試行は、Retry-After の待機（既定 60 秒）がそのまま計測値に
    // 乗るので標本にしない。失敗でもないので rateLimited の件数だけに残る
    // （method.md §3「リトライの扱い」）。
    if (aborted) break;
    if (result.rateLimited) continue;

    latencies.push(result.latencyMs);
    if (result.acceptedMs !== undefined) acceptedTimes.push(result.acceptedMs);
    if (typeof result.outputBytes === 'number') outputBytes.push(result.outputBytes);
    if (result.pageCount !== null) pageCounts.add(result.pageCount);
    pageCountMethods.add(result.pageCountMethod);
  }

  return {
    aborted,
    id: scenario.id,
    label: scenario.label ?? scenario.id,
    endpoint: scenario.endpoint,
    lineItems: scenario.lineItems,
    batchSize: scenario.batchSize,
    iterations: scenario.iterations,
    warmupIterations: scenario.warmupIterations,
    // ページ数は行数から決まるので通常 1 種類。ばらついたら pageCount は null にして
    // 観測値を配列で残す（代表値をでっち上げない）。
    pageCount: pageCounts.size === 1 ? [...pageCounts][0] : null,
    pageCountObserved: [...pageCounts].sort((a, b) => a - b),
    pageCountMethod: [...pageCountMethods].join(','),
    outputBytesMedian: outputBytes.length > 0 ? median([...outputBytes].sort((a, b) => a - b)) : null,
    latencyMs: summarize(latencies),
    acceptedMs: acceptedTimes.length > 0 ? summarize(acceptedTimes) : null,
    failures: { total: failures.length, byReason: countFailuresByReason(failures), detail: failures.slice(0, 10) },
    rateLimited: ctx.counters.rateLimited - rateLimitedBefore,
  };
}

// ---------------------------------------------------------------------------
// 実行計画の表示
// ---------------------------------------------------------------------------

function printPlan(config, scenarios) {
  const plan = buildPlan(scenarios);
  console.table(plan.rows);
  console.log(`合計: 生成リクエスト ${plan.totalRequests} 件 / 生成 PDF ${plan.totalFiles} 件`);
  console.log(
    'PDF は実際にワークスペースで生成され、プランの作成回数・従量課金の対象になります。' +
      '料金は https://lp.re-port-flow.com/#price を参照してください。',
  );
  if (plan.shortRunIds.length > 0) {
    console.log(
      `警告: 試行回数 ${MIN_ITERATIONS_FOR_P95} 未満のシナリオでは P95 が最大値と一致します` +
        `（${plan.shortRunIds.join(', ')}）。`,
    );
  }
  const floorMinutes = Math.ceil(estimateFloorSeconds(config, scenarios) / 60);
  console.log(`想定所要時間の下限（ペーシングのみ・生成時間を含まない）: 約 ${floorMinutes} 分`);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  let journal;
  let reportFile;
  let timer;
  const controller = new AbortController();
  const stop = () => controller.abort();
  try {
    const args = parseArgs(process.argv.slice(2));
    for (const name of ['config', 'out', 'scenario', 'iterations', 'warmup', 'evidence-out', 'max-duration-ms']) {
      if (args.flags.has(name)) throw new Error(`--${name} requires a value`);
    }
    await loadDotEnv(resolve(REPO_ROOT, '.env'));

    const configPath = resolveFromRepo(args.values.get('config') ?? 'benchmarks/config.default.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));

    let scenarios = normalizeScenarios(config, {
      iterations: readIntOption(args, 'iterations'),
      warmup: readIntOption(args, 'warmup'),
    });
    const only = args.values.get('scenario');
    if (only) {
      scenarios = scenarios.filter((s) => s.id === only);
      if (scenarios.length === 0) throw new Error(`--scenario ${only} に一致するシナリオがありません`);
    }

    console.log(`設定: ${configPath}`);
    printPlan(config, scenarios);

    if (args.flags.has('dry-run')) {
      console.log('\n--dry-run のため API は呼び出していません。');
      return;
    }

    const apiKey = process.env[config.env.apiKeyVar];
    const designId = process.env[config.env.designIdVar];
    const designVersion = Number(process.env[config.env.designVersionVar] ?? 1);
    if (!apiKey) {
      throw new Error(`${config.env.apiKeyVar} が未設定です（.env に ak_... を設定してください）`);
    }
    if (!designId) {
      throw new Error(
        `${config.env.designIdVar} が未設定です（${config.template.galleryUrl} を自分のワークスペースへ複製し、そのデザインIDを設定してください）`,
      );
    }

    const duration = readIntOption(args, 'max-duration-ms');
    if (duration !== undefined && (duration < 1 || duration > 2147483647)) {
      throw new Error('--max-duration-ms must be 1..2147483647');
    }
    runSignal = controller.signal;
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    if (duration !== undefined) timer = setTimeout(stop, duration);
    const outPath = resolveFromRepo(args.values.get('out') ?? `benchmarks/results/${new Date().toISOString().slice(0, 10)}.json`);
    await mkdir(dirname(outPath), { recursive: true });
    reportFile = await open(outPath, 'wx', 0o600);
    const runId = randomUUID();
    if (args.values.has('evidence-out')) journal = await openEvidence(args.values.get('evidence-out'), REPO_ROOT);
    const payloadTemplate = JSON.parse(await readFile(resolveFromRepo(config.payload.file), 'utf8'));
    const startedAt = new Date().toISOString();
    const utilization = config.rateLimitUtilization;

    const counters = { rateLimited: 0 };
    const ctx = {
      apiBase: config.apiBase,
      apiKey,
      design: { id: designId, version: designVersion },
      config,
      payload: { ...config.payload, template: payloadTemplate },
      // 実行ごとに変えて、ワークスペース上でどの実行の生成物か見分けられるようにする。
      runToken: runId,
      journal,
      pacers: {
        sync: createPacer(intervalMsFor(config.rateLimits.syncPerMin, utilization)),
        async: createPacer(intervalMsFor(config.rateLimits.asyncPerMin, utilization)),
        download: createPacer(intervalMsFor(config.rateLimits.downloadPerMin, utilization)),
      },
      rateLimitOptions: {
        maxRateLimitRetries: config.maxRateLimitRetries,
        fallbackRetryAfterMs: config.fallbackRetryAfterMs,
        onRateLimited: () => {
          counters.rateLimited += 1;
        },
      },
      counters,
    };

    await journal?.write({ type: 'run_start', runId, startedAt,
      configSha256: createHash('sha256').update(await readFile(configPath)).digest('hex'),
      payloadSha256: createHash('sha256').update(await readFile(resolveFromRepo(config.payload.file))).digest('hex'),
      runnerSha256: createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex'),
      librarySha256: createHash('sha256').update(await readFile(resolve(SCRIPT_DIR, 'lib.mjs'))).digest('hex'),
      evidenceSha256: createHash('sha256').update(await readFile(resolve(SCRIPT_DIR, 'evidence.mjs'))).digest('hex'),
      plan: buildPlan(scenarios), maxDurationMs: duration ?? null });
    console.log('');
    const results = [];
    let abortedEarly = false;
    for (const scenario of scenarios) {
      console.log(`▶ ${scenario.id}（${scenario.endpoint} / 明細 ${scenario.lineItems} 行 / ${scenario.batchSize} 件）`);
      if (runSignal.aborted) { abortedEarly = true; break; }
      const result = await runScenario(ctx, scenario);
      results.push(result);
      // 1 シナリオが連続失敗で中断したら、残りのシナリオも実行しない。
      // 途中までの結果は書き出す（何がどこまで測れたかを残すため）。
      if (result.aborted) {
        abortedEarly = true;
        console.log('連続失敗のため、残りのシナリオを実行せずに中断しました。');
        break;
      }
    }

    const report = {
      schemaVersion: RESULT_SCHEMA_VERSION,
      apiVersion: config.apiVersion,
      apiBase: config.apiBase,
      startedAt,
      finishedAt: new Date().toISOString(),
      // 連続失敗で打ち切ったかどうか。true の結果は全条件を測り切れていないので、
      // 公開値として扱ってはいけない。
      abortedEarly: abortedEarly || runSignal.aborted,
      template: config.template,
      // デザインIDはワークスペース固有の識別子なのでそのままは公開しない。
      // 同じデザインで測ったことだけ照合できるよう短いハッシュにする。
      designRef: createHash('sha256').update(`${designId}:${designVersion}`).digest('hex').slice(0, 12),
      designVersion,
      client: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        // 測定元の所在地・回線はレイテンシに直接効くので必ず添える。自動判定できないため
        // 環境変数から受け取り、未設定なら「未申告」と残す（推測で埋めない）。
        location: process.env.BENCHMARK_CLIENT_LOCATION ?? '未申告',
        network: process.env.BENCHMARK_CLIENT_NETWORK ?? '未申告',
      },
      config: {
        iterations: config.iterations,
        warmupIterations: config.warmupIterations,
        concurrency: 1,
        pollIntervalMs: config.pollIntervalMs,
        syncRequestTimeoutMs: config.syncRequestTimeoutMs,
        asyncCompletionTimeoutMs: config.asyncCompletionTimeoutMs,
        rateLimits: config.rateLimits,
        rateLimitUtilization: config.rateLimitUtilization,
        statistics: {
          median: '中央値（偶数標本は中央2値の平均）',
          p95: '最近傍順位法（ceil(0.95n) 番目）',
          minIterationsForP95: MIN_ITERATIONS_FOR_P95,
        },
      },
      scenarios: results,
    };

    await reportFile.writeFile(`${JSON.stringify(report, null, 2)}\n`, 'utf8');
    await reportFile.sync();
    console.log(`\n結果を書き出しました: ${outPath}`);

    await journal?.write({ type: 'run_end', runId, finishedAt: report.finishedAt, abortedEarly: report.abortedEarly });
    if (report.abortedEarly) process.exitCode = 2;
    const failed = results.reduce((sum, r) => sum + r.failures.total, 0);
    if (failed > 0) {
      console.log(`失敗 ${failed} 件（内訳は結果 JSON の scenarios[].failures を参照）`);
    }
  } finally {
    clearTimeout(timer);
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    try { await journal?.close(); } finally { await reportFile?.close(); }
  }
}

main().catch((error) => {
  console.error(`エラー: ${error.message}`);
  process.exitCode = 1;
});
