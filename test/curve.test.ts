import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReport, buildRows, percentile, computeCoefficients } from '../src/curve.js';
import { validateInput } from '../src/validation.js';
import { SieveAnalysisInput } from '../src/types.js';

const known: SieveAnalysisInput = {
  dryTotalMg: 100,
  panMg: 10,
  sieves: [
    { diameterMm: 2, retainedMg: 20 },
    { diameterMm: 1, retainedMg: 30 },
    { diameterMm: 0.5, retainedMg: 40 },
  ],
};

test('手算累计：通过率 80/50/10', () => {
  const rows = buildRows(known);
  assert.deepEqual(
    rows.map((r) => r.passingMg),
    [80, 50, 10],
  );
  assert.deepEqual(
    rows.map((r) => r.percentPassing),
    [80, 50, 10],
  );
  assert.deepEqual(
    rows.map((r) => r.cumulativeRetainedMg),
    [20, 50, 90],
  );
  assert.deepEqual(
    rows.map((r) => r.retainedMg),
    [20, 30, 40],
  );
});

test('单级比例与累计比例不同', () => {
  const rows = buildRows(known);
  assert.ok(Math.abs(rows[1].fractionRetained - 0.3) < 1e-12);
  assert.ok(Math.abs(rows[1].cumulativeFractionRetained - 0.5) < 1e-12);
});

test('D10/D30/D60 参考值与 Cu/Cc', () => {
  const c = computeCoefficients(buildRows(known), 100);
  assert.ok(c.d10?.kind === 'unique' && Math.abs(c.d10.diameterMm! - 0.5) < 1e-12);
  assert.ok(Math.abs(c.d30!.diameterMm! - Math.sqrt(0.5)) < 1e-12);
  assert.ok(Math.abs(c.d60!.diameterMm! - 2 ** (1 / 3)) < 1e-12);
  assert.ok(Math.abs(c.Cu! - 2.5198420997897464) < 1e-9);
  assert.ok(Math.abs(c.Cc! - 0.7937005259840998) < 1e-9);
});

test('D30 为对数插值且代回目标比例', () => {
  const rows = buildRows(known);
  const r = percentile(rows, 30, 100);
  assert.equal(r.kind, 'unique');
  const { coarse, fine, weight } = r.source!;
  const back = coarse!.percentPassing + weight! * (fine!.percentPassing - coarse!.percentPassing);
  assert.ok(Math.abs(back - 30) < 1e-9);
  // 不等于直径线性平均
  const linear = (coarse!.diameterMm + fine!.diameterMm) / 2;
  assert.ok(Math.abs(r.diameterMm! - linear) > 1e-9);
});

test('质量同比放大结果不变', () => {
  const scaled: SieveAnalysisInput = {
    dryTotalMg: 1000,
    panMg: 100,
    sieves: known.sieves.map((s) => ({ diameterMm: s.diameterMm, retainedMg: s.retainedMg * 10 })),
  };
  const a = buildReport(known);
  const b = buildReport(scaled);
  for (const p of [10, 30, 60]) {
    assert.ok(Math.abs(a.percentiles[p].diameterMm! - b.percentiles[p].diameterMm!) < 1e-12);
  }
  assert.ok(Math.abs(a.coefficients.Cu! - b.coefficients.Cu!) < 1e-12);
  assert.ok(Math.abs(a.coefficients.Cc! - b.coefficients.Cc!) < 1e-12);
});

test('直径同比放大只缩放粒径，Cu/Cc 不变', () => {
  const scaled: SieveAnalysisInput = {
    dryTotalMg: 100,
    panMg: 10,
    sieves: known.sieves.map((s) => ({ diameterMm: s.diameterMm * 10, retainedMg: s.retainedMg })),
  };
  const a = buildReport(known);
  const b = buildReport(scaled);
  for (const p of [10, 30, 60]) {
    assert.ok(Math.abs(a.percentiles[p].diameterMm! * 10 - b.percentiles[p].diameterMm!) < 1e-9);
  }
  assert.ok(Math.abs(a.coefficients.Cu! - b.coefficients.Cu!) < 1e-9);
  assert.ok(Math.abs(a.coefficients.Cc! - b.coefficients.Cc!) < 1e-9);
});

test('零截留产生平台区间', () => {
  const plateau: SieveAnalysisInput = {
    dryTotalMg: 100,
    panMg: 10,
    sieves: [
      { diameterMm: 2, retainedMg: 20 },
      { diameterMm: 1, retainedMg: 30 },
      { diameterMm: 0.75, retainedMg: 0 },
      { diameterMm: 0.5, retainedMg: 40 },
    ],
  };
  const r = percentile(buildRows(plateau), 50, 100);
  assert.equal(r.kind, 'plateau');
  assert.deepEqual(r.intervalMm, [0.75, 1]);
});

test('超出观测范围不外推', () => {
  const rows = buildRows(known);
  assert.equal(percentile(rows, 5, 100).kind, 'out-of-range');
  assert.equal(percentile(rows, 90, 100).kind, 'out-of-range');
});

test('单级筛', () => {
  const single: SieveAnalysisInput = {
    dryTotalMg: 100,
    panMg: 30,
    sieves: [{ diameterMm: 1, retainedMg: 70 }],
  };
  const rows = buildRows(single);
  assert.equal(rows[0].percentPassing, 30);
  assert.equal(percentile(rows, 30, 100).kind, 'unique');
  assert.equal(percentile(rows, 70, 100).kind, 'out-of-range');
  assert.equal(percentile(rows, 50, 100).kind, 'out-of-range');
  // 单级筛 Cu/Cc 缺失
  const c = computeCoefficients(rows, 100);
  assert.equal(c.Cu, null);
  assert.equal(c.Cc, null);
  assert.ok(c.reasons.length >= 1);
});

test('质量不闭合被拒绝', () => {
  const bad = { ...known, panMg: 5 };
  const issues = validateInput(bad);
  assert.ok(issues.some((i) => i.code === 'MASS_NOT_BALANCED'));
});

test('缺底盘被拒绝', () => {
  const bad = { dryTotalMg: 100, sieves: known.sieves } as unknown as SieveAnalysisInput;
  assert.ok(validateInput(bad).some((i) => i.code === 'PAN_MISSING'));
});

test('重复与颠倒直径被拒绝', () => {
  const dup = {
    ...known,
    sieves: [
      { diameterMm: 2, retainedMg: 10 },
      { diameterMm: 2, retainedMg: 30 },
      { diameterMm: 0.5, retainedMg: 40 },
    ],
    panMg: 20,
  };
  assert.ok(validateInput(dup).some((i) => i.code === 'DIAMETER_NOT_STRICTLY_DECREASING'));
  const rev = {
    ...known,
    sieves: [
      { diameterMm: 1, retainedMg: 20 },
      { diameterMm: 2, retainedMg: 30 },
      { diameterMm: 0.5, retainedMg: 40 },
    ],
  };
  assert.ok(validateInput(rev).some((i) => i.code === 'DIAMETER_NOT_STRICTLY_DECREASING'));
});

test('p 仅接受 0..100 整数', () => {
  const rows = buildRows(known);
  assert.throws(() => percentile(rows, 30.5, 100));
  assert.throws(() => percentile(rows, -1, 100));
  assert.throws(() => percentile(rows, 101, 100));
});

test('边界平台：全零截留 D100 区间', () => {
  const allZero: SieveAnalysisInput = {
    dryTotalMg: 100,
    panMg: 100,
    sieves: [
      { diameterMm: 2, retainedMg: 0 },
      { diameterMm: 1, retainedMg: 0 },
    ],
  };
  const rows = buildRows(allZero);
  const r = percentile(rows, 100, 100);
  assert.equal(r.kind, 'plateau');
  assert.deepEqual(r.intervalMm, [1, 2]);
});
