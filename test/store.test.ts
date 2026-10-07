import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import { Store } from '../src/db.js';
import { SieveService } from '../src/service.js';
import { SieveAnalysisInput } from '../src/types.js';

const input: SieveAnalysisInput = {
  dryTotalMg: 100,
  panMg: 10,
  sieves: [
    { diameterMm: 2, retainedMg: 20 },
    { diameterMm: 1, retainedMg: 30 },
    { diameterMm: 0.5, retainedMg: 40 },
  ],
};

test('提交、幂等、修订新版本与重启后冻结查询', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sieve-'));
  const dbPath = join(dir, 'sieve.db');

  let store = new Store(dbPath);
  let svc = new SieveService(store);
  const sample = svc.createSample('持久化');

  const first = svc.submit(sample.id, input);
  assert.equal(first.created, true);
  assert.equal(first.version.version, 1);

  const dup = svc.submit(sample.id, input);
  assert.equal(dup.created, false);
  assert.equal(dup.version.version, 1);
  assert.equal(svc.listVersions(sample.id).length, 1);

  const revised: SieveAnalysisInput = {
    dryTotalMg: 100,
    panMg: 20,
    sieves: [
      { diameterMm: 2, retainedMg: 10 },
      { diameterMm: 1, retainedMg: 30 },
      { diameterMm: 0.5, retainedMg: 40 },
    ],
  };
  const v2 = svc.submit(sample.id, revised);
  assert.equal(v2.created, true);
  assert.equal(v2.version.version, 2);

  // 校验失败不留下半成品
  assert.throws(() =>
    svc.submit(sample.id, { ...input, panMg: 0 }), // 合计 90 != 100
  );
  assert.equal(svc.listVersions(sample.id).length, 2);

  const oldD30 = svc.queryPercentile(sample.id, 30, 1).diameterMm;
  store.close();

  // 模拟重启
  store = new Store(dbPath);
  svc = new SieveService(store);
  const restarted = svc.queryPercentile(sample.id, 30, 1);
  assert.ok(Math.abs((restarted.diameterMm as number) - (oldD30 as number)) < 1e-12);
  assert.equal(svc.getReport(sample.id, 1).report.dryTotalMg, 100);
  assert.equal(svc.getReport(sample.id, 2).report.panMg, 20);

  const exp = svc.export(sample.id, 'csv', 1).content;
  assert.ok(exp.startsWith('diameter_mm,retained_mg'));
  assert.ok(exp.includes('\n2,20,20'));

  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('预览返回逐条错误且不落库', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sieve-'));
  const store = new Store(join(dir, 'sieve.db'));
  const svc = new SieveService(store);
  const sample = svc.createSample('x');
  const preview = svc.preview({ ...input, panMg: 3 });
  assert.equal(preview.ok, false);
  assert.equal(preview.report, null);
  assert.ok(preview.issues.length > 0);
  assert.equal(svc.listVersions(sample.id).length, 0);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

after(() => {
  // 确保退出
});
