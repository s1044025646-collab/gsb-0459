// 纯计算：累计质量、通过百分比、对数粒径插值与级配指标。无副作用、无 I/O。

import {
  CurveReport,
  GradationCoefficients,
  InterpolationSource,
  PercentileResult,
  SieveAnalysisInput,
  SieveReportRow,
} from './types.js';
import { assertValid, validatePercentile } from './validation.js';

function round2(x: number): number {
  // 仅用于展示；判断与插值从不使用该舍入值。
  return Math.round((x + Number.EPSILON) * 100) / 100;
}

/**
 * 计算各级累计截留与通过百分比。
 * 筛孔按从粗到细（直径严格递减）输入。
 */
export function buildRows(input: SieveAnalysisInput): SieveReportRow[] {
  assertValid(input);
  const total = input.dryTotalMg;
  let cumulative = 0;

  return input.sieves.map((s) => {
    cumulative += s.retainedMg; // 整数累计，不产生浮点误差
    const passing = total - cumulative;
    const percentPassing = (passing / total) * 100; // 未舍入质量比例
    return {
      diameterMm: s.diameterMm,
      retainedMg: s.retainedMg,
      cumulativeRetainedMg: cumulative,
      fractionRetained: s.retainedMg / total,
      cumulativeFractionRetained: cumulative / total,
      passingMg: passing,
      percentPassing,
      percentPassingDisplay: round2(percentPassing),
    };
  });
}

/**
 * 查询通过率为 p% 时的粒径 Dp。
 *
 * 约定：筛从粗到细，通过率随直径减小而单调不增。
 * - p 精确等于某观测点：唯一粒径；
 * - 多个相邻筛级通过率相同且都等于 p：返回最小到最大筛孔的平台区间；
 * - p 严格落在相邻两个不同通过率之间：对 ln(直径) 线性插值后取指数；
 * - 超出观测范围（含最细筛以下、最粗筛以上）：out-of-range，绝不外推。
 */
export function percentile(rows: SieveReportRow[], p: number, dryTotalMg: number): PercentileResult {
  validatePercentile(p);
  const targetMass = (p / 100) * dryTotalMg;

  // 用整数通过质量比较，规避显示舍入导致的伪相等。
  const passingAt = (r: SieveReportRow) => r.passingMg;

  // 1) 精确命中一个或多个相邻观测点（通过质量相等即平台）。
  const hits = rows.filter((r) => passingAt(r) === targetMass);
  if (hits.length > 0) {
    if (hits.length === 1) {
      return {
        p,
        kind: 'unique',
        diameterMm: hits[0].diameterMm,
        intervalMm: null,
        source: {
          method: 'exact-point',
          coarse: { diameterMm: hits[0].diameterMm, percentPassing: hits[0].percentPassing },
          fine: { diameterMm: hits[0].diameterMm, percentPassing: hits[0].percentPassing },
        },
        reason: null,
      };
    }
    // 相邻同通过率：平台歧义，直径从最小（最细）到最大（最粗）。
    const diameters = hits.map((h) => h.diameterMm);
    const dMin = Math.min(...diameters);
    const dMax = Math.max(...diameters);
    return {
      p,
      kind: 'plateau',
      diameterMm: null,
      intervalMm: [dMin, dMax],
      source: {
        method: 'plateau',
        coarse: { diameterMm: dMax, percentPassing: hits[hits.length - 1].percentPassing },
        fine: { diameterMm: dMin, percentPassing: hits[0].percentPassing },
      },
      reason: `通过率 ${p}% 在 ${dMin} 至 ${dMax} 毫米的相邻筛级上相同（零截留平台），D${p} 不唯一。`,
    };
  }

  // 2) 找相邻观测点对（粗 i，细 i+1），目标质量严格位于两者之间。
  for (let i = 0; i < rows.length - 1; i++) {
    const coarse = rows[i];
    const fine = rows[i + 1];
    const mC = coarse.passingMg;
    const mF = fine.passingMg;
    // 单调不增：mC >= mF。严格介于二者之间才可插值；相等为平台（已在上面处理命中）。
    if (targetMass < mC && targetMass > mF) {
      // 按通过百分比（等价于通过质量）线性权重插值对数直径。
      const w = (mC - targetMass) / (mC - mF); // 0 在粗端，1 在细端
      const lnD = (1 - w) * Math.log(coarse.diameterMm) + w * Math.log(fine.diameterMm);
      const diameter = Math.exp(lnD);
      const source: InterpolationSource = {
        method: 'log-interpolation',
        coarse: { diameterMm: coarse.diameterMm, percentPassing: coarse.percentPassing },
        fine: { diameterMm: fine.diameterMm, percentPassing: fine.percentPassing },
        weight: w,
      };
      return { p, kind: 'unique', diameterMm: diameter, intervalMm: null, source, reason: null };
    }
  }

  // 3) 超出观测范围。最粗筛通过率为其上界，最细筛通过率为其下界。
  const top = rows[0];
  const bottom = rows[rows.length - 1];
  let reason: string;
  if (p > top.percentPassing) {
    reason = `目标 ${p}% 高于最粗筛实测通过率 ${top.percentPassing}%（${top.diameterMm} 毫米），其上无测点，不外推。`;
  } else if (p < bottom.percentPassing) {
    reason = `目标 ${p}% 低于最细筛实测通过率 ${bottom.percentPassing}%（${bottom.diameterMm} 毫米）；底盘不是直径零的筛孔，其下无测点，不外推。`;
  } else {
    reason = `目标 ${p}% 无法由实测通过率确定（可能落在零截留平台内）。`;
  }
  return { p, kind: 'out-of-range', diameterMm: null, intervalMm: null, source: { method: 'none' }, reason };
}

/** 计算 D10/D30/D60 与 Cu、Cc；任一非唯一正粒径则指标为 null 并列原因。 */
export function computeCoefficients(
  rows: SieveReportRow[],
  dryTotalMg: number,
): GradationCoefficients {
  const d10 = percentile(rows, 10, dryTotalMg);
  const d30 = percentile(rows, 30, dryTotalMg);
  const d60 = percentile(rows, 60, dryTotalMg);
  const reasons: string[] = [];

  for (const [name, r] of [
    ['D10', d10],
    ['D30', d30],
    ['D60', d60],
  ] as const) {
    if (r.kind !== 'unique' || r.diameterMm === null || !(r.diameterMm > 0)) {
      reasons.push(
        r.kind === 'plateau'
          ? `${name} 为平台歧义区间，非唯一粒径。`
          : `${name} 超出观测通过率范围，无法确定。`,
      );
    }
  }

  if (reasons.length > 0) {
    return { Cu: null, Cc: null, reasons, d10, d30, d60 };
  }

  const a = d10.diameterMm as number;
  const b = d30.diameterMm as number;
  const c = d60.diameterMm as number;
  const Cu = c / a;
  const Cc = (b * b) / (a * c);
  return { Cu, Cc, reasons: [], d10, d30, d60 };
}

/** 生成完整冻结报告（默认含 D10/D30/D60 记录，便于审计）。 */
export function buildReport(input: SieveAnalysisInput, percentileTargets: number[] = []): CurveReport {
  assertValid(input);
  const rows = buildRows(input);
  const targets = Array.from(new Set([...percentileTargets, 10, 30, 60])).sort((a, b) => a - b);
  const percentiles: Record<number, PercentileResult> = {};
  for (const p of targets) percentiles[p] = percentile(rows, p, input.dryTotalMg);
  return {
    dryTotalMg: input.dryTotalMg,
    panMg: input.panMg,
    rows,
    percentiles,
    coefficients: computeCoefficients(rows, input.dryTotalMg),
  };
}
