import { ValidationError, type FieldIssue } from './errors.js';
import type { SubmissionInput, SieveInput } from './types.js';

export const LIMITS = {
  maxSieveCount: 100,
  maxTotalDryMassMg: 1_000_000_000_000,
  minPercentile: 0,
  maxPercentile: 100,
} as const;

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v);
}

export function validateSubmission(raw: unknown): SubmissionInput {
  const issues: FieldIssue[] = [];
  if (typeof raw !== 'object' || raw === null) {
    throw new ValidationError([
      { field: '$', code: 'INVALID_PAYLOAD', message: '请求体必须是 JSON 对象' },
    ]);
  }
  const obj = raw as Record<string, unknown>;
  const total = obj.totalDryMassMg;
  const pan = obj.panMassMg;
  const sievesRaw = obj.sieves;

  let totalN = 0;
  if (!isInt(total) || total <= 0) {
    issues.push({
      field: 'totalDryMassMg',
      code: 'VALIDATION_TOTAL_MASS',
      message: '干样总质量必须为正安全整数（毫克）',
    });
  } else if (total > LIMITS.maxTotalDryMassMg) {
    issues.push({
      field: 'totalDryMassMg',
      code: 'VALIDATION_MASS_TOO_LARGE',
      message: `干样总质量超过上限 ${LIMITS.maxTotalDryMassMg} mg`,
      detail: { max: LIMITS.maxTotalDryMassMg },
    });
  } else {
    totalN = total;
  }

  let panN = 0;
  if (!isInt(pan) || pan < 0) {
    issues.push({
      field: 'panMassMg',
      code: 'MISSING_PAN',
      message: '底盘质量必须显式给出且为非负整数毫克（缺底盘明确拒绝）',
    });
  } else {
    panN = pan;
  }

  const sieves: SieveInput[] = [];
  if (!Array.isArray(sievesRaw) || sievesRaw.length === 0) {
    issues.push({
      field: 'sieves',
      code: 'VALIDATION_SIEVES_EMPTY',
      message: '至少需要一个筛级，且按筛孔直径从大到小排列',
    });
  } else if (sievesRaw.length > LIMITS.maxSieveCount) {
    issues.push({
      field: 'sieves',
      code: 'VALIDATION_SIEVES_TOO_MANY',
      message: `筛级数超过上限 ${LIMITS.maxSieveCount}`,
      detail: { max: LIMITS.maxSieveCount },
    });
  } else {
    const parsed: Array<{ d: number | null; r: number | null }> = [];
    sievesRaw.forEach((s, i) => {
      const field = `sieves[${i}]`;
      if (typeof s !== 'object' || s === null) {
        issues.push({ field, code: 'INVALID_PAYLOAD', message: `${field} 必须是对象` });
        parsed.push({ d: null, r: null });
        return;
      }
      const so = s as Record<string, unknown>;
      const d = so.diameterMm;
      const r = so.retainedMg;
      let dNum: number | null = null;
      let rNum: number | null = null;
      if (typeof d !== 'number' || !Number.isFinite(d)) {
        issues.push({
          field: `${field}.diameterMm`,
          code: 'VALIDATION_DIAMETER_NOT_FINITE',
          message: `${field}.diameterMm 必须是有限数`,
        });
      } else if (d <= 0) {
        issues.push({
          field: `${field}.diameterMm`,
          code: 'VALIDATION_DIAMETER_NOT_POSITIVE',
          message: `${field}.diameterMm 必须为正（毫米），底盘不是直径为零的筛孔`,
        });
      } else {
        dNum = d;
        if (i > 0) {
          const prev = parsed[i - 1]?.d ?? null;
          if (prev !== null && d >= prev) {
            issues.push({
              field: `${field}.diameterMm`,
              code: 'VALIDATION_DIAMETER_NOT_STRICT_DECREASING',
              message: `筛孔必须严格递减：第 ${i + 1} 级直径 ${d} 不小于上一级 ${prev}（重复或颠倒顺序被拒绝）`,
              detail: { index: i, diameter: d, previous: prev },
            });
            dNum = null;
          }
        }
      }
      if (!isInt(r) || r < 0) {
        issues.push({
          field: `${field}.retainedMg`,
          code: 'VALIDATION_MASS_NEGATIVE',
          message: `${field}.retainedMg 必须为非负整数毫克`,
        });
      } else {
        rNum = r;
      }
      parsed.push({ d: dNum, r: rNum });
    });
    for (const item of parsed) {
      if (item.d !== null && item.r !== null) {
        sieves.push({ diameterMm: item.d, retainedMg: item.r });
      }
    }
  }

  if (issues.length > 0) {
    throw new ValidationError(issues);
  }

  let retainedSum = 0;
  for (const s of sieves) {
    retainedSum += s.retainedMg;
    if (!Number.isSafeInteger(retainedSum)) {
      throw new ValidationError([
        {
          field: 'sieves',
          code: 'VALIDATION_MASS_TOO_LARGE',
          message: '截留质量累加超出安全整数范围',
        },
      ]);
    }
  }
  if (!Number.isSafeInteger(retainedSum + panN)) {
    throw new ValidationError([
      { field: '$', code: 'VALIDATION_MASS_TOO_LARGE', message: '质量账目累加超出安全整数范围' },
    ]);
  }
  const accounted = retainedSum + panN;
  if (accounted !== totalN) {
    issues.push({
      field: '$',
      code: 'MASS_NOT_BALANCED',
      message:
        `质量账目不闭合：各筛截留 ${retainedSum} + 底盘 ${panN} = ${accounted} mg，` +
        `不等于干样总质量 ${totalN} mg（差额 ${totalN - accounted} mg，不做归一化或摊派底盘）`,
      detail: {
        retainedSum,
        pan: panN,
        accounted,
        total: totalN,
        difference: totalN - accounted,
      },
    });
  }
  if (issues.length > 0) {
    throw new ValidationError(issues);
  }

  return { totalDryMassMg: totalN, panMassMg: panN, sieves };
}

export function validatePercentile(raw: unknown): number {
  const p = typeof raw === 'string' ? Number(raw) : raw;
  if (typeof p !== 'number' || !Number.isInteger(p) || p < LIMITS.minPercentile || p > LIMITS.maxPercentile) {
    throw new ValidationError([
      {
        field: 'p',
        code: 'INVALID_PERCENTILE',
        message: `百分位 p 必须是 ${LIMITS.minPercentile} 到 ${LIMITS.maxPercentile} 的整数`,
      },
    ]);
  }
  return p;
}
