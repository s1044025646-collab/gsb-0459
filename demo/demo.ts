import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../src/db.js';
import { buildReport, buildCurve, percentile } from '../src/engine.js';
import { validateSubmission } from '../src/validate.js';
import { ValidationError } from '../src/errors.js';
import { reportToCsv } from '../src/exporters.js';

const demoDir = join(process.cwd(), 'data', 'demo');
rmSync(demoDir, { recursive: true, force: true });
mkdirSync(demoDir, { recursive: true });
const dbPath = join(demoDir, 'sieve.db');

function heading(t: string): void {
  console.log('\n' + '='.repeat(72));
  console.log(t);
  console.log('='.repeat(72));
}

heading('1) 标准虚构样例：100 mg，筛孔 2/1/0.5 mm，截留 20/30/40，底盘 10');
const standard = {
  totalDryMassMg: 100,
  panMassMg: 10,
  sieves: [
    { diameterMm: 2, retainedMg: 20 },
    { diameterMm: 1, retainedMg: 30 },
    { diameterMm: 0.5, retainedMg: 40 },
  ],
};
const report = buildReport(validateSubmission(standard));
console.table(
  report.sieves.map((r) => ({
    筛孔_mm: r.diameterMm,
    单级截留_mg: r.retainedMg,
    累计截留_mg: r.cumulativeRetainedMg,
    通过质量_mg: r.passingMassMg,
    通过率_精确: r.passingPercent,
    通过率_两位: r.passingPercentDisplay,
    单级比例_pct: r.singleFractionPercentDisplay,
    累计比例_pct: r.cumulativeFractionPercentDisplay,
  })),
);
console.log('D10 =', report.percentiles[10]!.diameterMm);
console.log('D30 =', report.percentiles[30]!.diameterMm, '|', report.percentiles[30]!.source!.check);
console.log('D60 =', report.percentiles[60]!.diameterMm, '|', report.percentiles[60]!.source!.check);
console.log('Cu  =', report.gradation.cu, ' Cc =', report.gradation.cc);
writeFileSync(join(demoDir, 'standard_report.json'), JSON.stringify(report, null, 2), 'utf8');
writeFileSync(join(demoDir, 'standard_report.csv'), reportToCsv(report), 'utf8');
console.log('已导出 data/demo/standard_report.json 与 .csv');

heading('2) 零截留平台：最粗两级无截留，D100 为区间 [2,4] mm（平台歧义）');
const platform = {
  totalDryMassMg: 100,
  panMassMg: 30,
  sieves: [
    { diameterMm: 4, retainedMg: 0 },
    { diameterMm: 2, retainedMg: 0 },
    { diameterMm: 1, retainedMg: 60 },
    { diameterMm: 0.25, retainedMg: 10 },
  ],
};
const platformReport = buildReport(validateSubmission(platform));
const { rows: platformRows } = buildCurve(validateSubmission(platform));
const d100 = percentile(100, platformRows);
console.log('D100 状态:', d100.status, '区间:', d100.range);
console.log('说明:', d100.reason);
console.log('Cu/Cc =', platformReport.gradation.cu, '/', platformReport.gradation.cc);
console.log('指标不可用原因:', platformReport.gradation.blockedReasons);

heading('3) 缺质量：截留+底盘 != 总质量，拒绝且不归一化、不摊派底盘');
try {
  validateSubmission({ ...standard, totalDryMassMg: 101 });
} catch (e) {
  if (e instanceof ValidationError) {
    for (const issue of e.issues) {
      console.log(`[${issue.code}] ${issue.message}`);
    }
  }
}

heading('4) 目标超出观测范围：标准样例 D81 / D9 / D100 / D0 均不外推');
{
  const { rows } = buildCurve(validateSubmission(standard));
  for (const p of [81, 9, 100, 0]) {
    const res = percentile(p, rows);
    console.log(`D${p}: ${res.status} - ${res.reason}`);
  }
}

heading('5) SQLite 持久化：幂等提交不增版本，修订生成新版本，旧报告冻结');
const store = new Store(dbPath);
store.createSample('demo-sample', '演示样品');
const first = store.submitVersion('demo-sample', 'v-a', validateSubmission(standard));
const again = store.submitVersion('demo-sample', 'v-b', validateSubmission(standard));
console.log('首次提交版本:', first.version.version, '| 重复提交版本:', again.version.version, '| duplicated =', again.duplicated);
const revised = {
  totalDryMassMg: 200,
  panMassMg: 20,
  sieves: [
    { diameterMm: 2, retainedMg: 40 },
    { diameterMm: 1, retainedMg: 60 },
    { diameterMm: 0.5, retainedMg: 80 },
  ],
};
const third = store.submitVersion('demo-sample', 'v-c', validateSubmission(revised));
console.log('修订后版本:', third.version.version);
store.close();

heading('6) 模拟重启：重新打开同一个数据库文件查询旧版本');
const reopened = new Store(dbPath);
const oldV = reopened.getVersion('demo-sample', 1);
const latestV = reopened.getVersion('demo-sample', 'latest');
const oldReport = JSON.parse(oldV.report) as { totalDryMassMg: number; sieves: Array<{ passingPercent: number }> };
const latestReport = JSON.parse(latestV.report) as {
  totalDryMassMg: number;
  sieves: Array<{ passingPercent: number }>;
};
console.log('旧版本总质量:', oldReport.totalDryMassMg, '| 新版本总质量:', latestReport.totalDryMassMg);
const d30 = reopened.computePercentile('demo-sample', 1, 30);
console.log('重启后查询 v1 的 D30 =', d30.result.diameterMm, '状态:', d30.result.status);
console.log('通过率曲线两版一致（质量同比放大不变性）:');
console.log('  v1:', oldReport.sieves.map((x) => x.passingPercent).join(', '));
console.log('  v2:', latestReport.sieves.map((x) => x.passingPercent).join(', '));
reopened.close();
console.log('\n演示完成。数据位于 data/demo/。');
