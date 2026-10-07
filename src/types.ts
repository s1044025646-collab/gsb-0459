export interface SieveInput {
  diameterMm: number;
  retainedMg: number;
}

export interface SubmissionInput {
  totalDryMassMg: number;
  panMassMg: number;
  sieves: SieveInput[];
}

export interface SieveRow {
  index: number;
  diameterMm: number;
  retainedMg: number;
  cumulativeRetainedMg: number;
  passingMassMg: number;
  passingPercent: number;
  passingPercentDisplay: number;
  singleFractionPercent: number;
  singleFractionPercentDisplay: number;
  cumulativeFractionPercent: number;
  cumulativeFractionPercentDisplay: number;
}

export type PercentileStatus = 'unique' | 'platform' | 'out_of_range';

export interface InterpolationSource {
  lower: { index: number; diameterMm: number; passingPercent: number } | null;
  upper: { index: number; diameterMm: number; passingPercent: number } | null;
  weightOnLowerLnD: number | null;
  exact: boolean;
  formula: string;
  check: string | null;
}

export interface PercentileResult {
 p: number;
  status: PercentileStatus;
  diameterMm: number | null;
  range: { minDiameterMm: number; maxDiameterMm: number } | null;
  reason: string;
  source: InterpolationSource | null;
}

export interface GradationIndexes {
  d10: PercentileResult;
  d30: PercentileResult;
  d60: PercentileResult;
  cu: number | null;
  cc: number | null;
  blockedReasons: string[];
}

export interface FrozenReport {
  totalDryMassMg: number;
  panMassMg: number;
  sieveCount: number;
  sieves: SieveRow[];
  percentiles: Record<number, PercentileResult>;
  gradation: GradationIndexes;
  observedRange: { minPassingPercent: number; maxPassingPercent: number };
}
