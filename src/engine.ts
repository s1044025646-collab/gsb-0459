import { ApiError } from './errors.js';
import type {
  FrozenReport,
  GradationIndexes,
  InterpolationSource,
  PercentileResult,
  SieveRow,
  SubmissionInput,
} from './types.js';

const EPS = 1e-12;

export function round2(v: number): number {
  return Math.round((v + Number.EPSILON) * 100) / 100;
}

export function buildCurve(input: SubmissionInput): {
  rows: SieveRow[];
  observedRange: { minPassingPercent: number; maxPassingPercent: number };
} {
  const total = input.totalDryMassMg;
  let cumulative = 0;
  const rows: SieveRow[] = input.sieves.map((s, i) => {
    cumulative += s.retainedMg;
    const passingMass = total - cumulative;
    const passingPercent = (passingMass / total) * 100;
    const singleFraction = (s.retainedMg / total) * 100;
    const cumulativeFraction = (cumulative / total) * 100;
    return {
      index: i,
      diameterMm: s.diameterMm,
      retainedMg: s.retainedMg,
      cumulativeRetainedMg: cumulative,
      passingMassMg: passingMass,
      passingPercent,
      passingPercentDisplay: round2(passingPercent),
      singleFractionPercent: singleFraction,
      singleFractionPercentDisplay: round2(singleFraction),
      cumulativeFractionPercent: cumulativeFraction,
      cumulativeFractionPercentDisplay: round2(cumulativeFraction),
    };
  });
  const percents = rows.map((r) => r.passingPercent);
  return {
    rows,
    observedRange: {
      minPassingPercent: Math.min(...percents),
      maxPassingPercent: Math.max(...percents),
    },
  };
}

function pctEqual(a: number, b: number): boolean {
  return Math.abs(a - b) <= EPS;
}

export function percentile(p: number, rows: SieveRow[]): PercentileResult {
  if (!Number.isInteger(p) || p < 0 || p > 100) {
    throw new ApiError('INVALID_PERCENTILE', `百分位 ${p} 非法`, 400);
  }
  const maxObs = rows.reduce((m, r) => Math.max(m, r.passingPercent), -Infinity);
  const minObs = rows.reduce((m, r) => Math.min(m, r.passingPercent), Infinity);

  if (p > maxObs + EPS || p < minObs - EPS) {
    return {
      p,
      status: 'out_of_range',
      diameterMm: null,
      range: null,
      reason:
        `目标 D${p} 超出实测通过率范围 [${round2(minObs)}%, ${round2(maxObs)}%]：` +
        '不外推；底盘不视作直径零的筛孔，最粗筛以上与最细筛以下均无测点。',
      source: null,
    };
  }

  const exactRows = rows.filter((r) => pctEqual(r.passingPercent, p));
  if (exactRows.length > 0) {
    let groupStart = exactRows[0]!;
    let groupEnd = exactRows[0]!;
    const group: SieveRow[] = [];
    for (const r of rows) {
      if (pctEqual(r.passingPercent, p)) {
        if (group.length === 0) {
          groupStart = r;
        }
        groupEnd = r;
        group.push(r);
      } else if (group.length > 0) {
        break;
      }
    }
    const minD = groupEnd.diameterMm;
    const maxD = groupStart.diameterMm;
    if (group.length > 1) {
      return {
        p,
        status: 'platform',
        diameterMm: null,
        range: { minDiameterMm: minD, maxDiameterMm: maxD },
        reason:
          `通过率 ${p}% 为相邻 ${group.length} 个筛级的同值平台（零截留台阶）：` +
          `D${p} 为区间 [${minD}, ${maxD}] mm，标记平台歧义，不任取一端。`,
        source: {
          lower: { index: groupEnd.index, diameterMm: groupEnd.diameterMm, passingPercent: groupEnd.passingPercent },
          upper: { index: groupStart.index, diameterMm: groupStart.diameterMm, passingPercent: groupStart.passingPercent },
          weightOnLowerLnD: null,
          exact: true,
          formula: `p=${p} 同时等于筛级 ${groupStart.index + 1}..${groupEnd.index + 1} 的实测通过率，返回粒径区间。`,
          check: null,
        },
      };
    }
    const only = group[0]!;
    return {
      p,
      status: 'unique',
      diameterMm: only.diameterMm,
      range: null,
      reason: `p=${p} 恰等于第 ${only.index + 1} 个实测点，直接返回该筛孔直径，无插值。`,
      source: {
        lower: { index: only.index, diameterMm: only.diameterMm, passingPercent: only.passingPercent },
        upper: { index: only.index, diameterMm: only.diameterMm, passingPercent: only.passingPercent },
        weightOnLowerLnD: null,
        exact: true,
        formula: `D${p} = ${only.diameterMm} mm（精确观测点）`,
        check: null,
      },
    };
  }

  for (let i = 0; i < rows.length - 1; i++) {
    const upper = rows[i]!;
    const lower = rows[i + 1]!;
    if (pctEqual(upper.passingPercent, lower.passingPercent)) {
      continue;
    }
    if (p < upper.passingPercent - EPS && p > lower.passingPercent + EPS) {
      const w = (upper.passingPercent - p) / (upper.passingPercent - lower.passingPercent);
      const lnD = w * Math.log(lower.diameterMm) + (1 - w) * Math.log(upper.diameterMm);
      const d = Math.exp(lnD);
      if (!Number.isFinite(d)) {
        throw new ApiError('INVALID_PAYLOAD', '插值结果非有限数', 500);
      }
      const backCheck =
        upper.passingPercent +
        ((lower.passingPercent - upper.passingPercent) * (Math.log(d) - Math.log(upper.diameterMm))) /
          (Math.log(lower.diameterMm) - Math.log(upper.diameterMm));
      return {
        p,
        status: 'unique',
        diameterMm: d,
        range: null,
        reason:
          `p=${p} 严格落在相邻实测通过率 ${round2(upper.passingPercent)}%（D=${upper.diameterMm}mm）` +
          `与 ${round2(lower.passingPercent)}%（D=${lower.diameterMm}mm）之间，对 ln(D) 线性插值。`,
        source: {
          lower: { index: lower.index, diameterMm: lower.diameterMm, passingPercent: lower.passingPercent },
          upper: { index: upper.index, diameterMm: upper.diameterMm, passingPercent: upper.passingPercent },
          weightOnLowerLnD: w,
          exact: false,
          formula:
            `ln(D${p}) = ${w.toFixed(6)}*ln(${lower.diameterMm}) + ${(1 - w).toFixed(6)}*ln(${upper.diameterMm})；` +
            `D${p} = exp(lnD) = ${d} mm`,
          check: `将 D=${d} 代回对数线段，反算通过率 = ${round2to10(backCheck)}%（目标 ${p}，偏差 ${Math.abs(backCheck - p).toExponential(2)}）`,
        },
      };
    }
  }

  return {
    p,
    status: 'out_of_range',
    diameterMm: null,
    range: null,
    reason: '目标未被任何相邻实测通过率段覆盖（可能落入零截留平台之间），按超出观测范围处理。',
    source: null,
  };
}

function round2to10(v: number): number {
  return Math.round((v + Number.EPSILON) * 1e10) / 1e10;
}

export function gradationIndexes(rows: SieveRow[]): GradationIndexes {
  const d10 = percentile(10, rows);
  const d30 = percentile(30, rows);
  const d60 = percentile(60, rows);
  const blockedReasons: string[] = [];
  const collect = (name: string, r: PercentileResult): number | null => {
    if (r.status === 'out_of_range') {
      blockedReasons.push(`${name} 超出实测通过率范围，无法确定唯一粒径`);
      return null;
    }
    if (r.status === 'platform') {
      blockedReasons.push(
        `${name} 落在通过率平台 ${r.range ? `[${r.range.minDiameterMm}, ${r.range.maxDiameterMm}] mm` : ''}，存在歧义`,
      );
      return null;
    }
    if (r.diameterMm === null || r.diameterMm <= 0 || !Number.isFinite(r.diameterMm)) {
      blockedReasons.push(`${name} 不是正的有限粒径`);
      return null;
    }
    return r.diameterMm;
  };
  const v10 = collect('D10', d10);
  const v30 = collect('D30', d30);
  const v60 = collect('D60', d60);
  let cu: number | null = null;
  let cc: number | null = null;
  if (v10 !== null && v30 !== null && v60 !== null) {
    cu = v60 / v10;
    cc = (v30 * v30) / (v10 * v60);
    if (!Number.isFinite(cu) || !Number.isFinite(cc)) {
      throw new ApiError('INVALID_PAYLOAD', '级配指标计算得到非有限数', 500);
    }
  }
  return { d10, d30, d60, cu, cc, blockedReasons };
}

export function buildReport(input: SubmissionInput, percentileTargets: number[] = []): FrozenReport {
  const { rows, observedRange } = buildCurve(input);
  const percentiles: Record<number, PercentileResult> = {};
  for (const target of [10, 30, 60, ...percentileTargets]) {
    if (!(target in percentiles)) {
      percentiles[target] = percentile(target, rows);
    }
  }
  const gradation = gradationIndexes(rows);
  percentiles[10] = gradation.d10;
  percentiles[30] = gradation.d30;
  percentiles[60] = gradation.d60;
  return {
    totalDryMassMg: input.totalDryMassMg,
    panMassMg: input.panMassMg,
    sieveCount: rows.length,
    sieves: rows,
    percentiles,
    gradation,
    observedRange,
  };
}
