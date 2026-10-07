import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCurve, buildReport, gradationIndexes, percentile } from '../src/engine.js';
import { validateSubmission } from '../src/validate.js';
import { ValidationError } from '../src/errors.js';
import type { SubmissionInput } from '../src/types.js';

const sample: SubmissionInput = {
  totalDryMassMg: 100,
  panMassMg: 10,
  sieves: [
    { diameterMm: 2, retainedMg: 20 },
    { diameterMm: 1, retainedMg: 30 },
    { diameterMm: 0.5, retainedMg: 40 },
  ],
};

test('手算累计：通过质量与通过率 80/50/10，单级与累计比例分开', () => {
  const { rows } = buildCurve(sample);
  assert.deepEqual(
    rows.map((r) => [r.retainedMg, r.cumulativeRetainedMg, r.passingMassMg]),
    [
      [20, 20, 80],
      [30, 50, 50],
      [40, 90, 10],
    ],
  );
  assert.deepEqual(rows.map((r) => r.passingPercent), [80, 50, 10]);
  assert.deepEqual(rows.map((r) => round(r.singleFractionPercent)), [20, 30, 40]);
  assert.deepEqual(rows.map((r) => round(r.cumulativeFractionPercent)), [20, 50, 90]);
});

test('D10=0.5，D30=sqrt(0.5)，D60=2^(1/3)；Cu≈2.5198421，Cc≈0.7937005', () => {
  const { rows } = buildCurve(sample);
  assert.equal(percentile(10, rows).diameterMm, 0.5);
  assert.ok(Math.abs(percentile(30, rows).diameterMm! - Math.sqrt(0.5)) < 1e-12);
  assert.ok(Math.abs(percentile(60, rows).diameterMm! - 2 ** (1 / 3)) < 1e-12);
  const g = gradationIndexes(rows);
  assert.ok(Math.abs(g.cu! - 2.5198420997897464) < 1e-12);
  assert.ok(Math.abs(g.cc! - 0.7937005259840998) < 1e-12);
  assert.equal(g.blockedReasons.length, 0);
});

test('插值代回对数线段，反算通过率等于目标', () => {
  const { rows } = buildCurve(sample);
  const r = percentile(30, rows);
  assert.match(r.source!.check!, /反算通过率 = 30(\.0+)?%/);
});

test('质量同比放大：通过率与 Dp、Cu、Cc 不变', () => {
  const big: SubmissionInput = {
    totalDryMassMg: 1_000_000,
    panMassMg: 100_000,
    sieves: [
      { diameterMm: 2, retainedMg: 200_000 },
      { diameterMm: 1, retainedMg: 300_000 },
      { diameterMm: 0.5, retainedMg: 400_000 },
    ],
  };
  const a = buildReport(sample);
  const b = buildReport(big);
  assert.deepEqual(
    a.sieves.map((r) => r.passingPercent),
    b.sieves.map((r) => r.passingPercent),
  );
  assert.equal(b.gradation.cu, a.gradation.cu);
  assert.equal(b.gradation.cc, a.gradation.cc);
  assert.equal(b.percentiles[30]!.diameterMm, a.percentiles[30]!.diameterMm);
});

test('直径同比放大 k 倍：Dp 缩放 k 倍，Cu/Cc 不变', () => {
  const k = 7;
  const scaled: SubmissionInput = {
    ...sample,
    sieves: sample.sieves.map((s) => ({ diameterMm: s.diameterMm * k, retainedMg: s.retainedMg })),
  };
  const { rows: r0 } = buildCurve(sample);
  const { rows: r1 } = buildCurve(scaled);
  for (const p of [10, 30, 60]) {
    assert.ok(Math.abs(percentile(p, r1).diameterMm! - percentile(p, r0).diameterMm! * k) < 1e-9);
  }
  const g0 = gradationIndexes(r0);
  const g1 = gradationIndexes(r1);
  assert.ok(Math.abs(g1.cu! - g0.cu!) < 1e-12);
  assert.ok(Math.abs(g1.cc! - g0.cc!) < 1e-12);
});

test('零截留产生通过率平台：p 命中时返回粒径区间并标记 platform', () => {
  const input: SubmissionInput = {
    totalDryMassMg: 100,
    panMassMg: 30,
    sieves: [
      { diameterMm: 4, retainedMg: 0 },
      { diameterMm: 2, retainedMg: 0 },
      { diameterMm: 1, retainedMg: 60 },
      { diameterMm: 0.25, retainedMg: 10 },
    ],
  };
  const { rows } = buildCurve(input);
  assert.deepEqual(rows.map((r) => r.passingPercent), [100, 100, 40, 30]);
  const p100 = percentile(100, rows);
  assert.equal(p100.status, 'platform');
  assert.deepEqual(p100.range, { minDiameterMm: 2, maxDiameterMm: 4 });
  assert.equal(p100.diameterMm, null);
  const g = gradationIndexes(rows);
  assert.equal(g.cu, null);
  assert.equal(g.cc, null);
  assert.equal(g.d10.status, 'out_of_range');
  assert.ok(g.blockedReasons.some((r) => r.includes('D10')));
});

test('多段平台：两处零截留分别形成区间', () => {
  const input: SubmissionInput = {
    totalDryMassMg: 100,
    panMassMg: 10,
    sieves: [
      { diameterMm: 8, retainedMg: 0 },
      { diameterMm: 4, retainedMg: 0 },
      { diameterMm: 2, retainedMg: 40 },
      { diameterMm: 1, retainedMg: 0 },
      { diameterMm: 0.5, retainedMg: 50 },
    ],
  };
  const { rows } = buildCurve(input);
  assert.deepEqual(rows.map((r) => r.passingPercent), [100, 100, 60, 60, 10]);
  assert.equal(percentile(100, rows).status, 'platform');
  const p60 = percentile(60, rows);
  assert.equal(p60.status, 'platform');
  assert.deepEqual(p60.range, { minDiameterMm: 1, maxDiameterMm: 2 });
});

test('单级筛：唯一筛级，平台与超范围行为正确', () => {
  const input: SubmissionInput = {
    totalDryMassMg: 10,
    panMassMg: 3,
    sieves: [{ diameterMm: 1, retainedMg: 7 }],
  };
  const { rows, observedRange } = buildCurve(input);
  assert.equal(rows[0]!.passingPercent, 30);
  assert.deepEqual(observedRange, { minPassingPercent: 30, maxPassingPercent: 30 });
  assert.equal(percentile(30, rows).status, 'unique');
  assert.equal(percentile(30, rows).diameterMm, 1);
  assert.equal(percentile(29, rows).status, 'out_of_range');
  assert.equal(percentile(31, rows).status, 'out_of_range');
  assert.equal(gradationIndexes(rows).cu, null);
});

test('目标超出观测范围：最粗筛以上与最细筛以下均不外推', () => {
  const { rows } = buildCurve(sample);
  const hi = percentile(81, rows);
  const lo = percentile(9, rows);
  assert.equal(hi.status, 'out_of_range');
  assert.equal(lo.status, 'out_of_range');
  assert.match(hi.reason, /不外推/);
});

test('显示舍入不影响平台判定：不同通过率不被误并', () => {
  const input: SubmissionInput = {
    totalDryMassMg: 1000,
    panMassMg: 334,
    sieves: [
      { diameterMm: 2, retainedMg: 333 },
      { diameterMm: 1, retainedMg: 333 },
    ],
  };
  const { rows } = buildCurve(input);
  assert.equal(rows[0]!.passingPercentDisplay, 66.7);
  assert.equal(rows[1]!.passingPercentDisplay, 33.4);
  assert.notEqual(rows[0]!.passingPercent, rows[1]!.passingPercent);
  assert.equal(percentile(66, rows).status, 'unique');
  assert.equal(percentile(34, rows).status, 'unique');
  assert.equal(percentile(66, rows).source!.exact, false);
});

test('校验：缺质量、缺底盘、重复/颠倒直径、非整数质量均拒绝且不归一化', () => {
  assert.throws(
    () => validateSubmission({ ...sample, totalDryMassMg: 101 }),
    (e: unknown) => e instanceof ValidationError && e.issues.some((i) => i.code === 'MASS_NOT_BALANCED'),
  );
  assert.throws(
    () =>
      validateSubmission({
        totalDryMassMg: 100,
        sieves: [{ diameterMm: 1, retainedMg: 100 }],
      }),
    (e: unknown) => e instanceof ValidationError && e.issues.some((i) => i.code === 'MISSING_PAN'),
  );
  assert.throws(
    () =>
      validateSubmission({
        totalDryMassMg: 100,
        panMassMg: 0,
        sieves: [
          { diameterMm: 1, retainedMg: 50 },
          { diameterMm: 1, retainedMg: 50 },
        ],
      }),
    (e: unknown) =>
      e instanceof ValidationError && e.issues.some((i) => i.code === 'VALIDATION_DIAMETER_NOT_STRICT_DECREASING'),
  );
  assert.throws(
    () =>
      validateSubmission({
        totalDryMassMg: 100,
        panMassMg: 0,
        sieves: [
          { diameterMm: 0.5, retainedMg: 50 },
          { diameterMm: 1, retainedMg: 50 },
        ],
      }),
    (e: unknown) =>
      e instanceof ValidationError && e.issues.some((i) => i.code === 'VALIDATION_DIAMETER_NOT_STRICT_DECREASING'),
  );
  assert.throws(
    () =>
      validateSubmission({
        totalDryMassMg: 100,
        panMassMg: 0.5,
        sieves: [{ diameterMm: 1, retainedMg: 99.5 }],
      }),
    ValidationError,
  );
});

test('p=0 与 p=100 边界同样遵守观测范围约定', () => {
  const { rows } = buildCurve(sample);
  assert.equal(percentile(0, rows).status, 'out_of_range');
  assert.equal(percentile(100, rows).status, 'out_of_range');
});

function round(v: number): number {
  return Math.round(v * 1e12) / 1e12;
}
