/**
 * benchmarks/lib.mjs の単体テスト（依存なし・`node --test benchmarks/` で実行）。
 *
 * 集計や失敗判定が黙って壊れると、誤った数値をそのまま公開ページに載せることになる。
 * ここで固定するのは method.md に書いた定義そのもの。
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ENDPOINTS,
  MIN_ITERATIONS_FOR_P95,
  buildParams,
  buildPlan,
  buildRequestBody,
  countFailuresByReason,
  estimateFloorSeconds,
  estimatePdfPageCount,
  intervalMsFor,
  looksLikePdf,
  looksLikeZip,
  materializeRow,
  median,
  normalizeScenarios,
  p95,
  pickCompletionMs,
  summarize,
} from './lib.mjs';

const BENCHMARK_DIR = dirname(fileURLToPath(import.meta.url));

describe('統計', () => {
  it('中央値は奇数なら中央値、偶数なら中央2値の平均', () => {
    assert.equal(median([1, 2, 3]), 2);
    assert.equal(median([1, 2, 3, 4]), 2.5);
    assert.equal(median([]), null);
  });

  it('P95 は最近傍順位法（ceil(0.95n) 番目）で補間しない', () => {
    // n=20 → ceil(19) = 19 番目 = 上から 2 番目
    const twenty = Array.from({ length: 20 }, (_, i) => i + 1);
    assert.equal(p95(twenty), 19);
    // n=100 → 95 番目
    assert.equal(p95(Array.from({ length: 100 }, (_, i) => i + 1)), 95);
    assert.equal(p95([]), null);
  });

  it('試行回数が MIN_ITERATIONS_FOR_P95 未満だと P95 が最大値と一致する', () => {
    for (let n = 1; n < MIN_ITERATIONS_FOR_P95; n += 1) {
      const values = Array.from({ length: n }, (_, i) => i + 1);
      assert.equal(p95(values), n, `n=${n} で P95 が最大値と一致しない`);
    }
    // 20 で初めて最大値と分かれる
    const at20 = Array.from({ length: MIN_ITERATIONS_FOR_P95 }, (_, i) => i + 1);
    assert.notEqual(p95(at20), MIN_ITERATIONS_FOR_P95);
  });

  it('summarize は未ソートの入力でも正しく集計する', () => {
    const s = summarize([30, 10, 20]);
    assert.deepEqual(s, { samples: 3, median: 20, p95: 30, min: 10, max: 30, mean: 20 });
  });

  it('標本 0 件でも例外にせず null を返す（失敗だけの条件を表現できる）', () => {
    assert.deepEqual(summarize([]), {
      samples: 0,
      median: null,
      p95: null,
      min: null,
      max: null,
      mean: null,
    });
  });
});

describe('PDF / ZIP の判定', () => {
  it('マジックナンバーで PDF と ZIP を見分ける', () => {
    assert.equal(looksLikePdf(Buffer.from('%PDF-1.7\n...', 'latin1')), true);
    assert.equal(looksLikePdf(Buffer.from('{"statusCode":500}', 'latin1')), false);
    assert.equal(looksLikePdf(Buffer.alloc(0)), false);
    assert.equal(looksLikeZip(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00])), true);
    assert.equal(looksLikeZip(Buffer.from('%PDF-1.7', 'latin1')), false);
  });

  it('/Type /Page と /Count が一致すればページ数として採用する', () => {
    const pdf = Buffer.from('%PDF-1.7 /Type /Pages /Count 2 /Type /Page x /Type /Page y', 'latin1');
    assert.deepEqual(estimatePdfPageCount(pdf), { pageCount: 2, method: 'type-page+count-agree' });
  });

  it('/Pages を /Page と数えない', () => {
    const pdf = Buffer.from('%PDF-1.7 /Type /Pages /Count 1 /Type /Page a', 'latin1');
    assert.equal(estimatePdfPageCount(pdf).pageCount, 1);
  });

  it('オブジェクトストリーム圧縮の PDF は推測せず未判定にする', () => {
    const pdf = Buffer.from('%PDF-1.7 /Type /ObjStm /N 12', 'latin1');
    assert.deepEqual(estimatePdfPageCount(pdf), {
      pageCount: null,
      method: 'unavailable-object-stream',
    });
  });

  it('手掛かりが無ければ 0 ではなく未判定を返す', () => {
    assert.deepEqual(estimatePdfPageCount(Buffer.from('%PDF-1.7 no markers', 'latin1')), {
      pageCount: null,
      method: 'unavailable-no-marker',
    });
  });
});

describe('ペイロード生成', () => {
  const template = {
    件名: '固定',
    小計: 1000,
    消費税: 100,
    合計金額: 1100,
    明細: [{ No: '{{index}}', 品目: '明細 {{index}}', 数量: 1, 単価: 1000, 金額: 1000 }],
  };
  const totals = {
    amountKey: '金額',
    subtotalKey: '小計',
    taxKey: '消費税',
    totalKey: '合計金額',
    taxRate: 0.1,
  };

  it('{{index}} だけの値は数値、文字列に埋め込まれた場合は文字列にする', () => {
    const row = materializeRow({ No: '{{index}}', 品目: 'X{{index}}', 数量: 2 }, 7);
    assert.equal(row.No, 7);
    assert.equal(row.品目, 'X7');
    assert.equal(row.数量, 2);
  });

  it('指定した行数ぶん明細を複製し、行番号を振る', () => {
    const params = buildParams({ template, lineItemsKey: '明細', rowCount: 3 });
    assert.equal(params.明細.length, 3);
    assert.deepEqual(
      params.明細.map((r) => r.No),
      [1, 2, 3],
    );
    assert.equal(params.件名, '固定');
  });

  it('小計・消費税・合計を明細から再計算する', () => {
    const params = buildParams({ template, lineItemsKey: '明細', rowCount: 50, totals });
    assert.equal(params.小計, 50_000);
    assert.equal(params.消費税, 5_000);
    assert.equal(params.合計金額, 55_000);
  });

  it('元のテンプレートを書き換えない', () => {
    buildParams({ template, lineItemsKey: '明細', rowCount: 10, totals });
    assert.equal(template.明細.length, 1);
    assert.equal(template.小計, 1000);
  });

  it('明細キーが配列でなければ実行前に例外にする', () => {
    assert.throws(
      () => buildParams({ template: { 明細: {} }, lineItemsKey: '明細', rowCount: 3 }),
      /1 行以上の配列ではありません/,
    );
  });
});

describe('リクエストボディ', () => {
  const design = { id: 'design-1', version: 2 };
  const params = { a: 1 };

  it('single は content、multiple は contents を組み立てる', () => {
    const single = buildRequestBody({
      scenario: { id: 's', endpoint: 'sync/single', batchSize: 1 },
      design,
      params,
      fileNamePrefix: 'bench',
      iterationLabel: '1',
    });
    assert.equal(single.designId, 'design-1');
    assert.equal(single.version, 2);
    assert.equal(single.content.fileName, 'bench-s-1');
    assert.equal(single.contents, undefined);

    const multiple = buildRequestBody({
      scenario: { id: 'm', endpoint: 'async/multiple', batchSize: 3 },
      design,
      params,
      fileNamePrefix: 'bench',
      iterationLabel: '1',
    });
    assert.equal(multiple.contents.length, 3);
    assert.equal(multiple.content, undefined);
  });

  it('multiple の fileName は配列内で一意（大文字小文字を無視しても）', () => {
    const body = buildRequestBody({
      scenario: { id: 'm', endpoint: 'async/multiple', batchSize: 50 },
      design,
      params,
      fileNamePrefix: 'bench',
      iterationLabel: '1',
    });
    const lowered = body.contents.map((c) => c.fileName.toLowerCase());
    assert.equal(new Set(lowered).size, 50);
  });
});

describe('設定の検証', () => {
  const base = {
    iterations: 20,
    warmupIterations: 2,
    rateLimitUtilization: 0.8,
    consecutiveFailureLimit: 3,
  };

  it('既定値を各シナリオに展開する', () => {
    const [s] = normalizeScenarios({
      ...base,
      scenarios: [{ id: 'a', endpoint: 'sync/single', lineItems: 5 }],
    });
    assert.equal(s.iterations, 20);
    assert.equal(s.warmupIterations, 2);
    assert.equal(s.batchSize, 1);
  });

  it('シナリオ個別の指定と CLI の上書きが効く（CLI が優先）', () => {
    const scenarios = [{ id: 'a', endpoint: 'sync/single', lineItems: 5, iterations: 10 }];
    assert.equal(normalizeScenarios({ ...base, scenarios })[0].iterations, 10);
    assert.equal(normalizeScenarios({ ...base, scenarios }, { iterations: 3 })[0].iterations, 3);
  });

  it('rateLimitUtilization が 0 以下・1 超・非数値なら実行前に弾く', () => {
    // 0 だとリクエスト間隔が Infinity になり、エラーも出さずに固まる。
    const scenarios = [{ id: 'a', endpoint: 'sync/single', lineItems: 1 }];
    for (const utilization of [0, -0.5, 1.5, undefined, '0.8']) {
      assert.throws(
        () => normalizeScenarios({ ...base, rateLimitUtilization: utilization, scenarios }),
        /rateLimitUtilization/,
        `rateLimitUtilization=${utilization} が通ってしまった`,
      );
    }
    assert.doesNotThrow(() => normalizeScenarios({ ...base, rateLimitUtilization: 1, scenarios }));
  });

  it('件数が maxBatchSize を超えたら実行前に弾く', () => {
    // 2026-08-06 に 20〜50 件のバッチでサーバー側が OOM 停止した。既定の上限を
    // 超える設定は、意図的に上げない限り実行させない。
    assert.throws(
      () =>
        normalizeScenarios({
          ...base,
          scenarios: [{ id: 'big', endpoint: 'async/multiple', lineItems: 5, batchSize: 20 }],
        }),
      /maxBatchSize/,
    );
    // 明示的に上げれば通る（自分の環境の容量を確認したうえでの操作）。
    assert.doesNotThrow(() =>
      normalizeScenarios({
        ...base,
        maxBatchSize: 20,
        scenarios: [{ id: 'big', endpoint: 'async/multiple', lineItems: 5, batchSize: 20 }],
      }),
    );
  });

  it('consecutiveFailureLimit の不正値を弾く', () => {
    const scenarios = [{ id: 'a', endpoint: 'sync/single', lineItems: 1 }];
    for (const limit of [0, -1, 1.5, undefined]) {
      assert.throws(
        () => normalizeScenarios({ ...base, consecutiveFailureLimit: limit, scenarios }),
        /consecutiveFailureLimit/,
        `consecutiveFailureLimit=${limit} が通ってしまった`,
      );
    }
  });

  it('未知の endpoint を弾く', () => {
    assert.throws(
      () => normalizeScenarios({ ...base, scenarios: [{ id: 'a', endpoint: 'sync/none', lineItems: 1 }] }),
      /未知の endpoint/,
    );
  });

  it('single に batchSize を付けたら弾く', () => {
    assert.throws(
      () =>
        normalizeScenarios({
          ...base,
          scenarios: [{ id: 'a', endpoint: 'sync/single', lineItems: 1, batchSize: 5 }],
        }),
      /batchSize は指定できません/,
    );
  });

  it('lineItems と id の不正を弾く', () => {
    assert.throws(
      () => normalizeScenarios({ ...base, scenarios: [{ id: 'a', endpoint: 'sync/single', lineItems: 0 }] }),
      /lineItems/,
    );
    assert.throws(
      () =>
        normalizeScenarios({
          ...base,
          scenarios: [
            { id: 'dup', endpoint: 'sync/single', lineItems: 1 },
            { id: 'dup', endpoint: 'sync/single', lineItems: 1 },
          ],
        }),
      /重複/,
    );
  });
});

describe('ペーシングと実行計画', () => {
  it('レート上限の利用率から最小間隔を出す', () => {
    // 30 req/分 の 80% → 24 req/分 → 2500ms
    assert.equal(intervalMsFor(30, 0.8), 2500);
    assert.equal(intervalMsFor(100, 0.8), 750);
  });

  it('生成ファイル数は 件数 × (ウォームアップ + 試行)', () => {
    const scenarios = normalizeScenarios({
      iterations: 10,
      warmupIterations: 1,
      rateLimitUtilization: 0.8,
      consecutiveFailureLimit: 3,
      maxBatchSize: 20,
      scenarios: [
        { id: 'a', endpoint: 'sync/single', lineItems: 5 },
        { id: 'b', endpoint: 'async/multiple', lineItems: 5, batchSize: 20 },
      ],
    });
    const plan = buildPlan(scenarios);
    assert.equal(plan.totalRequests, 11 + 11);
    assert.equal(plan.totalFiles, 11 + 220);
    assert.deepEqual(plan.shortRunIds, ['a', 'b']);
  });

  it('所要時間の下限は endpoint 種別ごとの間隔で決まる', () => {
    const config = {
      rateLimits: { syncPerMin: 30, asyncPerMin: 100, downloadPerMin: 100 },
      rateLimitUtilization: 0.8,
    };
    const scenarios = [
      { id: 'a', endpoint: 'sync/single', iterations: 10, warmupIterations: 0 },
      { id: 'b', endpoint: 'async/single', iterations: 10, warmupIterations: 0 },
    ];
    // sync 10 × 2500ms + async 10 × 750ms = 32.5s
    assert.equal(estimateFloorSeconds(config, scenarios), 32.5);
  });
});

describe('非同期の完了時刻の決め方', () => {
  it('最初の確認（配列末尾のファイル）を基準にする', () => {
    assert.equal(pickCompletionMs(null, 5000, false), 5000);
  });

  it('掃引で回る残りのファイルではペーシング待ちを足さない', () => {
    // 末尾が 5000ms で 200 → 残り 2 件を 750ms 間隔で確認（5750 / 6500）。
    // どちらも 404 を見ていない＝既に生成済みなので、完了時刻は 5000ms のまま。
    let completion = pickCompletionMs(null, 5000, false);
    completion = pickCompletionMs(completion, 5750, false);
    completion = pickCompletionMs(completion, 6500, false);
    assert.equal(completion, 5000);
  });

  it('掃引中に 404 を見たファイルがあればその確認時刻へ更新する', () => {
    // 最終チャンク内は最大 5 件が並行するので、末尾が最後に終わるとは限らない。
    let completion = pickCompletionMs(null, 5000, false);
    completion = pickCompletionMs(completion, 7200, true);
    assert.equal(completion, 7200);
  });
});

describe('失敗の集計', () => {
  it('分類ごとに件数を数える', () => {
    assert.deepEqual(
      countFailuresByReason([
        { reason: 'http_error' },
        { reason: 'timeout' },
        { reason: 'http_error' },
      ]),
      { http_error: 2, timeout: 1 },
    );
    assert.deepEqual(countFailuresByReason([]), {});
  });
});

describe('同梱の設定ファイル', () => {
  for (const name of ['config.default.json', 'config.smoke.json']) {
    it(`${name} は正しい JSON で、検証を通る`, async () => {
      const config = JSON.parse(await readFile(resolve(BENCHMARK_DIR, name), 'utf8'));
      const scenarios = normalizeScenarios(config);
      assert.ok(scenarios.length > 0, 'シナリオが空');
      // 4 エンドポイントを必ず 1 つ以上ずつ含む（method.md §2.1 のマトリクス）
      for (const endpoint of ENDPOINTS) {
        assert.ok(
          scenarios.some((s) => s.endpoint === endpoint),
          `${name} に ${endpoint} のシナリオが無い`,
        );
      }
      assert.ok(config.rateLimitUtilization > 0 && config.rateLimitUtilization <= 1);
      assert.equal(config.rateLimits.syncPerMin, 30);
      assert.equal(config.rateLimits.asyncPerMin, 100);
      assert.equal(config.rateLimits.downloadPerMin, 100);
    });
  }

  it('payload テンプレートは明細行テンプレートを 1 行持つ', async () => {
    const config = JSON.parse(await readFile(resolve(BENCHMARK_DIR, 'config.default.json'), 'utf8'));
    const template = JSON.parse(
      await readFile(resolve(BENCHMARK_DIR, '..', config.payload.file), 'utf8'),
    );
    assert.ok(Array.isArray(template[config.payload.lineItemsKey]));
    assert.equal(template[config.payload.lineItemsKey].length, 1);
    // totals の対象キーが実際に明細行に存在すること（キー名を変えたら気づけるように）
    assert.ok(config.payload.totals.amountKey in template[config.payload.lineItemsKey][0]);
    for (const key of ['subtotalKey', 'taxKey', 'totalKey']) {
      assert.ok(config.payload.totals[key] in template, `${config.payload.totals[key]} が payload に無い`);
    }
  });
});
