import type { FrozenReport } from './types.js';

function csvCell(v: string | number): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function reportToCsv(report: FrozenReport): string {
  const lines: string[] = [];
  lines.push('# 筛分曲线报告（CSV）');
  lines.push(`# 干样总质量_mg,${report.totalDryMassMg}`);
  lines.push(`# 底盘质量_mg,${report.panMassMg}`);
  lines.push(`# 实测通过率范围_%,${report.observedRange.minPassingPercent},${report.observedRange.maxPassingPercent}`);
  lines.push(
    [
      '序号',
      '筛孔直径_mm',
      '单级截留_mg',
      '累计截留_mg',
      '通过质量_mg',
      '通过率_%',
      '通过率显示_四舍五入两位',
      '单级比例_%',
      '累计比例_%',
    ].map(csvCell).join(','),
  );
  for (const r of report.sieves) {
    lines.push(
      [
        r.index + 1,
        r.diameterMm,
        r.retainedMg,
        r.cumulativeRetainedMg,
        r.passingMassMg,
        r.passingPercent,
        r.passingPercentDisplay,
        r.singleFractionPercentDisplay,
        r.cumulativeFractionPercentDisplay,
      ]
        .map(csvCell)
        .join(','),
    );
  }
  lines.push('');
  lines.push(['百分位', '状态', '粒径_mm', '区间最小_mm', '区间最大_mm', '说明'].map(csvCell).join(','));
  for (const key of Object.keys(report.percentiles).sort((a, b) => Number(a) - Number(b))) {
    const pr = report.percentiles[Number(key)]!;
    lines.push(
      [
        pr.p,
        pr.status,
        pr.diameterMm ?? '',
        pr.range?.minDiameterMm ?? '',
        pr.range?.maxDiameterMm ?? '',
        pr.reason,
      ]
        .map(csvCell)
        .join(','),
    );
  }
  lines.push('');
  lines.push(`Cu,${report.gradation.cu ?? ''}`);
  lines.push(`Cc,${report.gradation.cc ?? ''}`);
  for (const reason of report.gradation.blockedReasons) {
    lines.push(`指标不可用原因,${csvCell(reason)}`);
  }
  return lines.join('\r\n') + '\r\n';
}
