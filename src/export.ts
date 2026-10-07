// JSON / CSV 导出。CSV 仅含筛级行；底盘不计入筛孔行。

import { CurveReport } from './types.js';

export function toJSON(report: CurveReport, meta?: Record<string, unknown>): string {
  return JSON.stringify(meta ? { ...meta, report } : report, null, 2);
}

export function toCSV(report: CurveReport): string {
  const header = [
    'diameter_mm',
    'retained_mg',
    'cumulative_retained_mg',
    'fraction_retained',
    'cumulative_fraction_retained',
    'passing_mg',
    'percent_passing_raw',
    'percent_passing_display',
  ];
  const lines = [header.join(',')];
  for (const r of report.rows) {
    lines.push(
      [
        r.diameterMm,
        r.retainedMg,
        r.cumulativeRetainedMg,
        r.fractionRetained,
        r.cumulativeFractionRetained,
        r.passingMg,
        r.percentPassing,
        r.percentPassingDisplay,
      ].join(','),
    );
  }
  return lines.join('\n');
}
