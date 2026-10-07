// 公共类型定义：筛分服务的输入、计算结果与百分位查询结果。

/** 单级筛输入：筛孔直径（毫米，从大到小排列）与该筛上截留质量（整数毫克）。 */
export interface SieveInput {
  /** 筛孔直径，毫米，必须为正有限数。 */
  diameterMm: number;
  /** 该筛上截留质量，整数毫克，非负。 */
  retainedMg: number;
}

/** 样品筛分原始输入。 */
export interface SieveAnalysisInput {
  /** 干样总质量，整数毫克，正安全整数。 */
  dryTotalMg: number;
  /** 各级筛（从粗到细），至少 1 级。 */
  sieves: SieveInput[];
  /** 底盘质量，整数毫克，非负。 */
  panMg: number;
  /** 可选样品名称。 */
  name?: string;
}

/** 单级筛计算报告行。 */
export interface SieveReportRow {
  /** 筛孔直径（毫米）。 */
  diameterMm: number;
  /** 本筛单级截留质量（毫克，整数）。 */
  retainedMg: number;
  /** 累计截留质量：本筛及所有更粗筛之和（毫克，整数）。 */
  cumulativeRetainedMg: number;
  /** 单级截留比例（未舍入，0..1）。 */
  fractionRetained: number;
  /** 累计截留比例（未舍入，0..1）。 */
  cumulativeFractionRetained: number;
  /** 通过质量 = 总质量 - 累计截留（毫克，整数）。 */
  passingMg: number;
  /** 通过百分比（未舍入，0..100），判断平台与插值一律使用此值。 */
  percentPassing: number;
  /** 显示用通过百分比（四舍五入两位小数），仅用于展示。 */
  percentPassingDisplay: number;
}

/** 百分位结果类型。 */
export type PercentileKind =
  | 'unique' // 唯一粒径（观测点精确命中或线段内对数插值）
  | 'plateau' // 平台歧义：多个相邻筛级通过率相同且等于 p
  | 'out-of-range'; // 超出实际观测通过率范围，不外推

/** 单个 p 百分位查询结果。 */
export interface PercentileResult {
  /** 目标百分位（0..100 的整数）。 */
  p: number;
  kind: PercentileKind;
  /** kind=unique 时的粒径（毫米，正有限数）；否则为 null。 */
  diameterMm: number | null;
  /** kind=plateau 时的歧义粒径区间 [最小, 最大]（毫米）；否则为 null。 */
  intervalMm: [number, number] | null;
  /** 插值/命中的来源说明，便于审计。 */
  source: InterpolationSource | null;
  /** kind=out-of-range 时的中文原因。 */
  reason: string | null;
}

/** 插值来源审计信息。 */
export interface InterpolationSource {
  /** 判定方式：精确命中观测点 / 相邻观测点间对数插值 / 平台区间。 */
  method: 'exact-point' | 'log-interpolation' | 'plateau' | 'none';
  /** 较粗筛孔（毫米）与其实测通过百分比。 */
  coarse?: { diameterMm: number; percentPassing: number };
  /** 较细筛孔（毫米）与其实测通过百分比。 */
  fine?: { diameterMm: number; percentPassing: number };
  /** 对数插值权重 w：ln(D)=(1-w)*ln(Dc)+w*ln(Df)，通过率从粗到细下降。 */
  weight?: number;
}

/** 级配指标。 */
export interface GradationCoefficients {
  Cu: number | null;
  Cc: number | null;
  /** 为 null 的原因列表（缺失或歧义）。 */
  reasons: string[];
  d10: PercentileResult | null;
  d30: PercentileResult | null;
  d60: PercentileResult | null;
}

/** 冻结计算报告。 */
export interface CurveReport {
  dryTotalMg: number;
  panMg: number;
  rows: SieveReportRow[];
  percentiles: Record<number, PercentileResult>;
  coefficients: GradationCoefficients;
}
