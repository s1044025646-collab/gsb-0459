import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, type AppConfig } from '../src/server.js';

let base: string;
let cleanup: () => void;
let dataDir: string;

const body = {
  totalDryMassMg: 100,
  panMassMg: 10,
  sieves: [
    { diameterMm: 2, retainedMg: 20 },
    { diameterMm: 1, retainedMg: 30 },
    { diameterMm: 0.5, retainedMg: 40 },
  ],
};

async function call(method: string, path: string, payload?: unknown): Promise<{ status: number; json: any; text: string }> {
  const init: RequestInit = { method };
  if (payload) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(payload);
  }
  const res = await fetch(`${base}${path}`, init);
  const text = await res.text();
  return { status: res.status, text, json: text ? JSON.parse(text) : null };
}

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'sieve-test-'));
  const config: AppConfig = { dataDir, port: 0, host: '127.0.0.1' };
  const started = await startServer(config);
  base = `http://127.0.0.1:${started.port}`;
  cleanup = started.close;
});

after(async () => {
  cleanup();
  await rm(dataDir, { recursive: true, force: true });
});

test('完整 API 流程：建样品→预览→提交→曲线→任意百分位→插值来源→CSV', async () => {
  const created = await call('POST', '/api/samples', { id: 's1', name: '虚构样例' });
  assert.equal(created.status, 201);

  const preview = await call('POST', '/api/sieve-versions/preview', body);
  assert.equal(preview.status, 200);
  assert.equal(preview.json.dryRun, true);
  assert.deepEqual(preview.json.report.sieves.map((r: any) => r.passingPercent), [80, 50, 10]);

  const first = await call('POST', '/api/samples/s1/versions', body);
  assert.equal(first.status, 201);
  assert.equal(first.json.versionNumber, 1);

  const again = await call('POST', '/api/samples/s1/versions', body);
  assert.equal(again.status, 200);
  assert.equal(again.json.duplicated, true);
  assert.equal(again.json.versionNumber, 1);

  const report = await call('GET', '/api/samples/s1/versions/latest/report');
  assert.equal(report.status, 200);
  assert.ok(Math.abs(report.json.report.gradation.cu - 2.5198420997897464) < 1e-12);

  const dp = await call('GET', '/api/samples/s1/versions/1/percentiles/30');
  assert.equal(dp.status, 200);
  assert.ok(Math.abs(dp.json.percentile.diameterMm - Math.sqrt(0.5)) < 1e-12);
  assert.match(dp.json.percentile.source.formula, /ln\(D30\)/);
  assert.match(dp.json.percentile.source.check, /反算通过率/);

  const csv = await call('GET', '/api/samples/s1/versions/latest/report?format=csv');
  assert.equal(csv.status, 200);
  assert.match(csv.text, /通过率/);
  assert.match(csv.text, /Cu,2\.519/);
});

test('预览导入错误返回 422 且错误码明确，不留半份数据', async () => {
  const bad = { ...body, totalDryMassMg: 101 };
  const res = await call('POST', '/api/sieve-versions/preview', bad);
  assert.equal(res.status, 422);
  assert.equal(res.json.error.issues[0].code, 'MASS_NOT_BALANCED');
  const list = await call('GET', '/api/samples');
  assert.ok(!list.json.samples.some((s: any) => s.id === 's2'));
});

test('提交坏数据被事务拒绝，样品不新增版本', async () => {
  await call('POST', '/api/samples', { id: 's3', name: '坏数据样例' });
  const bad = { totalDryMassMg: 10, panMassMg: 99, sieves: [{ diameterMm: 1, retainedMg: 0 }] };
  const res = await call('POST', '/api/samples/s3/versions', bad);
  assert.equal(res.status, 422);
  const versions = await call('GET', '/api/samples/s3/versions');
  assert.equal(versions.json.versions.length, 0);
});

test('修订数据生成新版本；旧版本继续冻结当时的总质量与筛孔', async () => {
  await call('POST', '/api/samples', { id: 's4', name: '修订样例' });
  const v1 = await call('POST', '/api/samples/s4/versions', body);
  assert.equal(v1.json.versionNumber, 1);
  const revised = {
    totalDryMassMg: 200,
    panMassMg: 20,
    sieves: [
      { diameterMm: 2, retainedMg: 40 },
      { diameterMm: 1, retainedMg: 60 },
      { diameterMm: 0.5, retainedMg: 80 },
    ],
  };
  const v2 = await call('POST', '/api/samples/s4/versions', revised);
  assert.equal(v2.status, 201);
  assert.equal(v2.json.versionNumber, 2);
  const oldReport = await call('GET', '/api/samples/s4/versions/1/report');
  assert.equal(oldReport.json.frozenInput.totalDryMassMg, 100);
  assert.equal(oldReport.json.report.totalDryMassMg, 100);
  const newReport = await call('GET', '/api/samples/s4/versions/latest/report');
  assert.equal(newReport.json.report.totalDryMassMg, 200);
  assert.deepEqual(
    oldReport.json.report.sieves.map((r: any) => r.passingPercent),
    newReport.json.report.sieves.map((r: any) => r.passingPercent),
  );
});

test('非法百分位与不存在资源返回明确错误', async () => {
  const badP = await call('GET', '/api/samples/s1/versions/latest/percentiles/50.5');
  assert.equal(badP.status, 422);
  const missing = await call('GET', '/api/samples/nope/versions/latest/report');
  assert.equal(missing.status, 404);
});
