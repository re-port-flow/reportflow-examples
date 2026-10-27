/**
 * ベンチマークの純粋ロジック（統計・ペイロード生成・PDF 検査・設定検証）。
 *
 * HTTP を伴わない部分をここに切り出して `lib.test.mjs` で固定する。集計が黙って
 * 壊れると、誤った数値をそのまま公開してしまうため。
 *
 * 各定義の意味は benchmarks/method.md を一次情報とする。
 */

/**
 * P95 が最大値と区別できる最小の試行回数。
 *
 * 最近傍順位法では P95 の順位が ceil(0.95n) になるため、n < 20 では常に
 * n 番目＝最大値に一致してしまい「P95」を名乗る意味が無くなる。
 */
export const MIN_ITERATIONS_FOR_P95 = 20;

/** 結果 JSON の構造バージョン。消費側（LP の /benchmarks/）が互換性判定に使う。 */
export const RESULT_SCHEMA_VERSION = 1;

/** 失敗の分類。結果 JSON の failures.byReason のキーになる。 */
export const FAILURE = {
  HTTP_ERROR: 'http_error',
  TIMEOUT: 'timeout',
  NETWORK_ERROR: 'network_error',
  INVALID_BODY: 'invalid_body',
  POLL_TIMEOUT: 'poll_timeout',
  RATE_LIMIT_EXHAUSTED: 'rate_limit_exhausted',
};

export const ENDPOINTS = ['sync/single', 'sync/multiple', 'async/single', 'async/multiple'];

// ---------------------------------------------------------------------------
// 統計
// ---------------------------------------------------------------------------

const round1 = (v) => (v === null ? null : Math.round(v * 10) / 10);

/**
 * 中央値。標本数が偶数のときは中央 2 値の平均（統計の慣用的な定義）。
 * P95 の最近傍順位法とは定義が異なるので、method.md にも両方明記してある。
 */
export function median(sortedAsc) {
  const n = sortedAsc.length;
  if (n === 0) return null;
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? sortedAsc[mid] : (sortedAsc[mid - 1] + sortedAsc[mid]) / 2;
}

/** P95（最近傍順位法: ceil(0.95n) 番目の小さい値）。補間はしない。 */
export function p95(sortedAsc) {
  const n = sortedAsc.length;
  if (n === 0) return null;
  const rank = Math.min(Math.max(Math.ceil(0.95 * n), 1), n);
  return sortedAsc[rank - 1];
}

export function summarize(values) {
  if (values.length === 0) {
    return { samples: 0, median: null, p95: null, min: null, max: null, mean: null };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  return {
    samples: sorted.length,
    median: round1(median(sorted)),
    p95: round1(p95(sorted)),
    min: round1(sorted[0]),
    max: round1(sorted[sorted.length - 1]),
    mean: round1(sum / sorted.length),
  };
}

// ---------------------------------------------------------------------------
// PDF / ZIP の検証とページ数の推定
// ---------------------------------------------------------------------------

const PDF_MAGIC = Buffer.from('%PDF-', 'latin1');
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

export function looksLikePdf(buffer) {
  return buffer.length >= PDF_MAGIC.length && buffer.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC);
}

export function looksLikeZip(buffer) {
  return buffer.length >= ZIP_MAGIC.length && buffer.subarray(0, ZIP_MAGIC.length).equals(ZIP_MAGIC);
}

/**
 * PDF のページ数を、外部ライブラリなしで**推定**する。
 *
 * `/Type /Page` の出現数と、ページツリーの `/Count n` を両方数えて突き合わせる。
 * オブジェクトストリーム（`/ObjStm`）で圧縮された PDF はこの方法では読めないので、
 * 推測せず `null`（＝未判定）を返す。呼び出し側は `method` をそのまま結果 JSON に
 * 載せ、公開時も「推定値／未判定」を区別できるようにする。
 *
 * @returns {{ pageCount: number|null, method: string }}
 */
export function estimatePdfPageCount(buffer) {
  const text = buffer.toString('latin1');
  if (text.includes('/ObjStm')) {
    return { pageCount: null, method: 'unavailable-object-stream' };
  }
  const typePageHits = text.match(/\/Type\s*\/Page(?![sA-Za-z])/g)?.length ?? 0;
  const counts = [...text.matchAll(/\/Count\s+(\d+)/g)].map((m) => Number(m[1]));
  const maxCount = counts.length > 0 ? Math.max(...counts) : null;

  if (typePageHits > 0 && maxCount === typePageHits) {
    return { pageCount: typePageHits, method: 'type-page+count-agree' };
  }
  if (typePageHits > 0) return { pageCount: typePageHits, method: 'type-page-only' };
  if (maxCount !== null && maxCount > 0) return { pageCount: maxCount, method: 'count-only' };
  return { pageCount: null, method: 'unavailable-no-marker' };
}

// ---------------------------------------------------------------------------
// ペイロード生成
// ---------------------------------------------------------------------------

/**
 * 明細行テンプレートの `{{index}}` を行番号に置き換える。
 *
 * 値がちょうど `"{{index}}"` のときだけ**数値**に、文字列の一部に含まれるときは
 * 文字列として埋め込む。デザイン側のパラメータ型（number / string）に合わせられる
 * ようにするためで、暗黙の型変換は行わない。
 */
export function materializeRow(rowTemplate, index) {
  const row = {};
  for (const [key, value] of Object.entries(rowTemplate)) {
    if (typeof value !== 'string') {
      row[key] = value;
      continue;
    }
    row[key] = value === '{{index}}' ? index : value.replaceAll('{{index}}', String(index));
  }
  return row;
}

/**
 * 明細行数 `rowCount` の params を組み立てる。
 *
 * `totals` が設定されていれば小計・消費税・合計を明細から再計算する。行数を変えても
 * 帳票上の金額が矛盾しないようにするためで、レイテンシ自体には影響しない。
 */
export function buildParams({ template, lineItemsKey, rowCount, totals }) {
  const params = structuredClone(template);
  if (!lineItemsKey) return params;

  const rows = params[lineItemsKey];
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error(
      `payload の "${lineItemsKey}" が 1 行以上の配列ではありません（明細行テンプレートが必要）`,
    );
  }
  const rowTemplate = rows[0];
  params[lineItemsKey] = Array.from({ length: rowCount }, (_, i) => materializeRow(rowTemplate, i + 1));

  if (totals) {
    const { amountKey, subtotalKey, taxKey, totalKey, taxRate } = totals;
    const subtotal = params[lineItemsKey].reduce((sum, row) => {
      const amount = row[amountKey];
      return sum + (typeof amount === 'number' ? amount : 0);
    }, 0);
    const tax = Math.floor(subtotal * taxRate);
    if (subtotalKey) params[subtotalKey] = subtotal;
    if (taxKey) params[taxKey] = tax;
    if (totalKey) params[totalKey] = subtotal + tax;
  }
  return params;
}

/**
 * リクエストボディを組み立てる。
 *
 * 複数生成（`/multiple`）の `fileName` は配列内で一意である必要がある
 * （大文字小文字は区別されない）。
 */
export function buildRequestBody({ scenario, design, params, fileNamePrefix, iterationLabel }) {
  const isMultiple = scenario.endpoint.endsWith('/multiple');
  if (!isMultiple) {
    return {
      designId: design.id,
      version: design.version,
      content: { fileName: `${fileNamePrefix}-${scenario.id}-${iterationLabel}`, params },
    };
  }
  return {
    designId: design.id,
    version: design.version,
    contents: Array.from({ length: scenario.batchSize }, (_, i) => ({
      fileName: `${fileNamePrefix}-${scenario.id}-${iterationLabel}-${String(i + 1).padStart(3, '0')}`,
      params,
    })),
  };
}

// ---------------------------------------------------------------------------
// 設定の検証
// ---------------------------------------------------------------------------

/**
 * 設定ファイルのシナリオを検証し、既定値と CLI の上書きを反映した形にする。
 * 不正な設定は実行前に例外にする（本番へリクエストを投げてから気づかないため）。
 */
export function normalizeScenarios(config, overrides = {}) {
  // 0 以下だとリクエスト間隔が Infinity になり、エラーも出さずに固まる。
  // 実行前に落とす（黙って止まっている状態がいちばん分かりにくい）。
  const utilization = config.rateLimitUtilization;
  if (!(typeof utilization === 'number' && utilization > 0 && utilization <= 1)) {
    throw new Error(`rateLimitUtilization は 0 より大きく 1 以下の数値（受け取った値: ${utilization}）`);
  }
  if (!Number.isInteger(config.consecutiveFailureLimit) || config.consecutiveFailureLimit < 1) {
    throw new Error(
      `consecutiveFailureLimit は 1 以上の整数（受け取った値: ${config.consecutiveFailureLimit}）`,
    );
  }
  // 件数の上限。本番環境は他の利用者と共有しているため、大きいバッチを繰り返し投げると
  // 自分の測定のために他の利用者の生成を遅らせることになる。レート上限を守っていれば
  // 負荷をかけないとは限らない（method.md §5-10）。
  const overLimit = config.scenarios.filter((s) => (s.batchSize ?? 1) > (config.maxBatchSize ?? 5));
  if (overLimit.length > 0) {
    throw new Error(
      `batchSize が maxBatchSize (${config.maxBatchSize ?? 5}) を超えています: ` +
        `${overLimit.map((s) => `${s.id}=${s.batchSize}`).join(', ')}。` +
        '共有基盤に負荷をかけるおそれがあります（method.md §5-10）。意図的に測る場合は設定の maxBatchSize を上げてください。',
    );
  }
  const seen = new Set();
  return config.scenarios.map((scenario) => {
    if (!scenario.id) throw new Error('シナリオに id がありません');
    if (seen.has(scenario.id)) throw new Error(`シナリオ id が重複しています: ${scenario.id}`);
    seen.add(scenario.id);
    if (!ENDPOINTS.includes(scenario.endpoint)) {
      throw new Error(`${scenario.id}: 未知の endpoint「${scenario.endpoint}」（${ENDPOINTS.join(' / ')} のいずれか）`);
    }
    const isMultiple = scenario.endpoint.endsWith('/multiple');
    if (!isMultiple && scenario.batchSize !== undefined && scenario.batchSize !== 1) {
      throw new Error(`${scenario.id}: single エンドポイントに batchSize は指定できません`);
    }
    const batchSize = isMultiple ? (scenario.batchSize ?? 1) : 1;
    if (!Number.isInteger(batchSize) || batchSize < 1) {
      throw new Error(`${scenario.id}: batchSize は 1 以上の整数`);
    }
    if (!Number.isInteger(scenario.lineItems) || scenario.lineItems < 1) {
      throw new Error(`${scenario.id}: lineItems は 1 以上の整数`);
    }
    const iterations = overrides.iterations ?? scenario.iterations ?? config.iterations;
    const warmupIterations = overrides.warmup ?? scenario.warmupIterations ?? config.warmupIterations;
    if (!Number.isInteger(iterations) || iterations < 1) {
      throw new Error(`${scenario.id}: iterations は 1 以上の整数`);
    }
    if (!Number.isInteger(warmupIterations) || warmupIterations < 0) {
      throw new Error(`${scenario.id}: warmupIterations は 0 以上の整数`);
    }
    return { ...scenario, batchSize, iterations, warmupIterations };
  });
}

/** レート上限の何割まで使うかから、リクエスト間の最小間隔を出す。 */
export function intervalMsFor(perMinuteLimit, utilization) {
  return Math.ceil(60_000 / (perMinuteLimit * utilization));
}

/** 実行計画（シナリオごとのリクエスト数・生成ファイル数）。 */
export function buildPlan(scenarios) {
  const rows = scenarios.map((s) => {
    const requests = s.warmupIterations + s.iterations;
    return {
      シナリオ: s.id,
      endpoint: s.endpoint,
      明細行数: s.lineItems,
      件数: s.batchSize,
      'ウォームアップ+試行': `${s.warmupIterations}+${s.iterations}`,
      リクエスト数: requests,
      生成ファイル数: requests * s.batchSize,
    };
  });
  return {
    rows,
    totalRequests: rows.reduce((sum, r) => sum + r.リクエスト数, 0),
    totalFiles: rows.reduce((sum, r) => sum + r.生成ファイル数, 0),
    shortRunIds: scenarios.filter((s) => s.iterations < MIN_ITERATIONS_FOR_P95).map((s) => s.id),
  };
}

/**
 * ペーシングだけで最低限かかる秒数。生成時間もダウンロード待ちも含まないので、
 * 実際の所要時間は必ずこれより長くなる（「下限」としてしか読めない値）。
 */
export function estimateFloorSeconds(config, scenarios) {
  const u = config.rateLimitUtilization;
  const syncMs = intervalMsFor(config.rateLimits.syncPerMin, u);
  const asyncMs = intervalMsFor(config.rateLimits.asyncPerMin, u);
  return (
    scenarios.reduce((sum, s) => {
      const requests = s.warmupIterations + s.iterations;
      return sum + requests * (s.endpoint.startsWith('sync/') ? syncMs : asyncMs);
    }, 0) / 1000
  );
}

/**
 * 非同期の完了時刻として、どの観測を採るかを決める。
 *
 * 完了確認は「配列末尾のファイルを監視 → 200 になったら残りを 1 巡して全件確認」の順で行う
 * （生成はおおむね配列順に進むため、末尾がいちばん遅く仕上がりやすい）。
 * 1 巡ぶんのリクエストはダウンロードのレート上限に合わせて 750ms 間隔で回るため、
 * その時間を完了時間に足すと**測定側のペーシングを製品の遅さとして計上してしまう**
 * （50 件なら 1 巡だけで 37 秒）。よって基準は最初の確認（＝末尾ファイル）の時刻。
 *
 * 例外は、1 巡の途中で 409 FILE_NOT_READY を観測したファイル。それは本当にまだ生成中だったので、
 * そのファイルが 200 になった時刻へ更新する（末尾が最後に終わるとは限らない —
 * 内部では複数ファイルが並行処理されており、完了順は保証されない）。
 *
 * @param {number|null} current 現在の完了時刻（未確定なら null）
 * @param {number} observedMs 今回 200 を観測した時刻
 * @param {boolean} waited このファイルで 409 FILE_NOT_READY（生成中）を観測していたか
 */
export function pickCompletionMs(current, observedMs, waited) {
  return current === null || waited ? observedMs : current;
}

/** 失敗一覧を `{ reason: 件数 }` に畳む。 */
export function countFailuresByReason(failures) {
  const byReason = {};
  for (const failure of failures) {
    byReason[failure.reason] = (byReason[failure.reason] ?? 0) + 1;
  }
  return byReason;
}
