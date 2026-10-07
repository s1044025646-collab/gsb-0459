// 端到端演示：写入虚构实验记录，展示曲线、平台、缺质量拒绝、超范围与缩放不变性，
// 并对插值结果代回对数线段核验目标比例。仅用于本地演示，不连接任何仪器。

import { SieveService } from './service.js';
import { SieveAnalysisInput } from './types.js';
import { validateInput } from './validation.js';

function h(line = '') {
  return '\n===== ' + line + ' =====';
}

export async function runDemo(service: SieveService, out: (s: string) => void) {
  out(h('1. 建立样品'));
  const sample = service.createSample('演示土样');
  out(`样品 #${sample.id} 已建立`);

  // 已知样例：总质量 100mg，筛孔 2/1/0.5mm，截留 20/30/40，底盘 10。
  const known: SieveAnalysisInput = {
    dryTotalMg: 100,
    panMg: 10,
    sieves: [
      { diameterMm: 2, retainedMg: 20 },
      { diameterMm: 1, retainedMg: 30 },
      { diameterMm: 0.5, retainedMg: 40 },
    ],
  };

  out(h('2. 预览导入（不落库）'));
  const preview = service.preview(known);
  out(`预览 ok=${preview.ok}`);
  for (const r of preview.report!.rows) {
    out(
      `D=${r.diameterMm}mm 单级截留=${r.retainedMg}mg 累计截留=${r.cumulativeRetainedMg}mg ` +
        `通过=${r.passingMg}mg 通过率=${r.percentPassingDisplay}% (原始 ${r.percentPassing})`,
    );
  }

  out(h('3. 提交版本并计算 D10/D30/D60、Cu、Cc'));
  const submitted = service.submit(sample.id, known, [10, 30, 60]);
  const report = service.getReport(sample.id).report;
  for (const p of [10, 30, 60]) {
    const r = report.percentiles[p];
    out(`D${p} kind=${r.kind} 粒径=${r.diameterMm}`);
  }
  out(`Cu=${report.coefficients.Cu}（= D60/D10）`);
  out(`Cc=${report.coefficients.Cc}`);
  out('参考值: D10=0.5, D30=sqrt(0.5)≈0.7071068, D60=2^(1/3)≈1.2599211');
  out('参考值: Cu≈2.5198421, Cc≈0.7937005');

  out(h('4. 插值代回对数线段核验 D30'));
  const d30 = service.queryPercentile(sample.id, 30);
  if (d30.source?.weight !== undefined && d30.source.coarse && d30.source.fine) {
    const { coarse, fine, weight } = d30.source;
    const backP =
      coarse.percentPassing + weight! * (fine.percentPassing - coarse.percentPassing);
    out(`权重 w=${weight}, 代回通过率=${backP}% (目标 30%)，粒径=${d30.diameterMm}`);
    out(`对数核验: exp((1-w)lnDc + w lnDf)=${d30.diameterMm}`);
  }

  out(h('5. 零截留导致的平台'));
  const plateauSample = service.createSample('平台样例');
  // 在 1mm 与 0.5mm 之间插入 0.75mm 且零截留 -> 两筛通过率相同。
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
  const pr = service.submit(plateauSample.id, plateau);
  const p50 = service.queryPercentile(plateauSample.id, 50, pr.version.version);
  out(`D50 kind=${p50.kind} 区间=${JSON.stringify(p50.intervalMm)} 原因=${p50.reason}`);

  out(h('6. 缺质量被拒绝（不摊给底盘）'));
  const missing: SieveAnalysisInput = { ...known, panMg: 5 }; // 合计 95 != 100
  const issues = validateInput(missing);
  out(`校验问题数=${issues.length}: [${issues[0]?.code}] ${issues[0]?.message}`);
  let rejected = false;
  try {
    service.submit(plateauSample.id, missing);
  } catch {
    rejected = true;
  }
  out(`提交被拒绝=${rejected}；该样品版本数=${service.listVersions(plateauSample.id).length}（无半成品）`);

  out(h('7. 目标超出观测范围（不外推、底盘不为零）'));
  const below = service.queryPercentile(sample.id, 5);
  const above = service.queryPercentile(sample.id, 90);
  out(`D5  kind=${below.kind}: ${below.reason}`);
  out(`D90 kind=${above.kind}: ${above.reason}`);

  out(h('8. 质量同比放大 -> 通过率与粒径不变'));
  const scaled: SieveAnalysisInput = {
    dryTotalMg: 1000,
    panMg: 100,
    sieves: known.sieves.map((s) => ({ diameterMm: s.diameterMm, retainedMg: s.retainedMg * 10 })),
  };
  const s2 = service.createSample('质量放大10倍');
  const v2 = service.submit(s2.id, scaled);
  const d30scaled = service.queryPercentile(s2.id, 30, v2.version.version);
  out(`放大后 D30=${d30scaled.diameterMm}（应等于 ${d30.diameterMm}）`);

  out(h('9. 直径同比放大 -> 粒径等比缩放，Cu/Cc 不变'));
  const dscaled: SieveAnalysisInput = {
    dryTotalMg: 100,
    panMg: 10,
    sieves: known.sieves.map((s) => ({ diameterMm: s.diameterMm * 10, retainedMg: s.retainedMg })),
  };
  const s3 = service.createSample('直径放大10倍');
  const v3 = service.submit(s3.id, dscaled);
  const r3 = service.getReport(s3.id, v3.version.version).report;
  out(`放大后 D60=${r3.coefficients.d60?.diameterMm}（应≈${report.coefficients.d60?.diameterMm! * 10}）`);
  out(`放大后 Cu=${r3.coefficients.Cu} Cc=${r3.coefficients.Cc}（应分别≈${report.coefficients.Cu}, ${report.coefficients.Cc}）`);

  out(h('10. 修订生成新版本，旧报告冻结'));
  const revised: SieveAnalysisInput = {
    dryTotalMg: 100,
    panMg: 20,
    sieves: [
      { diameterMm: 2, retainedMg: 10 },
      { diameterMm: 1, retainedMg: 30 },
      { diameterMm: 0.5, retainedMg: 40 },
    ],
  };
  const vRev = service.submit(sample.id, revised);
  out(`新版本号=${vRev.version.version} created=${vRev.created}`);
  const again = service.submit(sample.id, revised);
  out(`重复提交 created=${again.created} 版本仍=${again.version.version}（幂等不增版本）`);
  const oldReport = service.getReport(sample.id, 1).report;
  out(`旧版本 v1 总质量=${oldReport.dryTotalMg} 通过率首行=${oldReport.rows[0].percentPassingDisplay}%（仍引用当时数据）`);
  out(`最新版本 v${vRev.version.version} 通过率首行=${service.getReport(sample.id).report.rows[0].percentPassingDisplay}%`);

  out(h('11. 单级筛'));
  const s4 = service.createSample('单级筛');
  service.submit(s4.id, { dryTotalMg: 100, panMg: 30, sieves: [{ diameterMm: 1, retainedMg: 70 }] });
  out(`单级筛通过率=${service.getReport(s4.id).report.rows[0].percentPassingDisplay}%`);
  out(`单级筛 D30=${JSON.stringify(service.queryPercentile(s4.id, 30))}（唯一观测点）`);
  out(`单级筛 D50=${JSON.stringify(service.queryPercentile(s4.id, 50))}（超出观测范围）`);

  out(h('演示完成'));
}
