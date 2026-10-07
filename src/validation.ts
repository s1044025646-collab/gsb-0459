// 输入校验：严格的质量账目与筛孔顺序检查。不做归一化，不摊平缺失质量。

import { AppError, ValidationIssue } from './errors.js';
import { SieveAnalysisInput } from './types.js';

/** 筛级数上限。 */
export const MAX_SIEVES = 64;
/** 单个/合计质量上限（毫克，安全整数范围内，防止滥用）。 */
export const MAX_TOTAL_MG = Number.MAX_SAFE_INTEGER;

function isNonNegInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}

/**
 * 校验原始输入，返回逐条问题列表。列表为空即通过。
 * 注意：质量闭合采用精确整数求和，绝不偷偷归一化或把差额摊给底盘。
 */
export function validateInput(input: Partial<SieveAnalysisInput>): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  const total = input.dryTotalMg;
  if (typeof total !== 'number' || !Number.isSafeInteger(total) || total <= 0) {
    issues.push({
      code: 'TOTAL_NOT_POSITIVE_INTEGER',
      field: 'dryTotalMg',
      message: '干样总质量必须为正的安全整数（毫克）。',
    });
  } else if (total > MAX_TOTAL_MG) {
    issues.push({
      code: 'MASS_TOO_LARGE',
      field: 'dryTotalMg',
      message: `干样总质量超过上限 ${MAX_TOTAL_MG} 毫克。`,
    });
  }

  if (!Array.isArray(input.sieves)) {
    issues.push({ code: 'SIEVES_EMPTY', field: 'sieves', message: 'sieves 必须为数组。' });
    return issues;
  }

  if (input.sieves.length === 0) {
    issues.push({ code: 'SIEVES_EMPTY', field: 'sieves', message: '至少需要一级筛。' });
  }
  if (input.sieves.length > MAX_SIEVES) {
    issues.push({
      code: 'TOO_MANY_SIEVES',
      field: 'sieves',
      message: `筛级数不得超过 ${MAX_SIEVES}。`,
    });
  }

  // 底盘必须显式提供（字段存在），不允许缺失后由系统补零。
  if (input.panMg === undefined || input.panMg === null) {
    issues.push({ code: 'PAN_MISSING', field: 'panMg', message: '必须显式提供底盘质量。' });
  } else if (!isNonNegInt(input.panMg)) {
    issues.push({
      code: 'MASS_NOT_NONNEGATIVE_INTEGER',
      field: 'panMg',
      message: '底盘质量必须为非负整数（毫克）。',
    });
  }

  let sum = typeof input.panMg === 'number' && Number.isSafeInteger(input.panMg) ? input.panMg : 0;

  let prevDiameter = Number.POSITIVE_INFINITY;
  input.sieves.forEach((s, i) => {
    const field = `sieves[${i}]`;
    const d = s?.diameterMm;
    const m = s?.retainedMg;

    if (typeof d !== 'number' || !Number.isFinite(d) || d <= 0) {
      issues.push({
        code: 'DIAMETER_INVALID',
        field: `${field}.diameterMm`,
        message: '筛孔直径必须为正的有限数（毫米）。',
      });
      } else if (!(d < prevDiameter)) {
      // 严格递减：重复（相等）与颠倒顺序都在此被拒绝。
      issues.push({
        code: 'DIAMETER_NOT_STRICTLY_DECREASING',
        field: `${field}.diameterMm`,
        message: `第 ${i + 1} 级直径 ${d} 必须严格小于上一级 ${prevDiameter}（不允许重复或颠倒）。`,
      });
    }
    if (Number.isFinite(d) && d > 0) prevDiameter = d;

    if (!isNonNegInt(m)) {
      issues.push({
        code: 'MASS_NOT_NONNEGATIVE_INTEGER',
        field: `${field}.retainedMg`,
        message: '筛上截留质量必须为非负整数（毫克）。',
      });
    } else {
      sum += m;
    }
  });

  // 质量闭合：全部筛上质量 + 底盘 必须精确等于干样总质量。
  const allMassValid =
    typeof total === 'number' &&
    Number.isSafeInteger(total) &&
    (typeof input.panMg === 'number' ? Number.isSafeInteger(input.panMg) && input.panMg >= 0 : false) &&
    input.sieves.every((s) => isNonNegInt(s?.retainedMg));
  if (allMassValid && sum !== total) {
    const diff = (total as number) - sum;
    issues.push({
      code: 'MASS_NOT_BALANCED',
      field: 'dryTotalMg',
      message:
        diff > 0
          ? `质量账目不闭合：各筛与底盘之和（${sum} 毫克）比干样总质量少 ${diff} 毫克，缺失质量不会被摊给底盘。`
          : `质量账目不闭合：各筛与底盘之和（${sum} 毫克）比干样总质量多 ${-diff} 毫克。`,
    });
  }

  return issues;
}

/** 校验，失败则抛出首个 AppError（提交路径使用）。 */
export function assertValid(input: Partial<SieveAnalysisInput>): asserts input is SieveAnalysisInput {
  const issues = validateInput(input);
  if (issues.length > 0) {
    throw new AppError(issues[0].code, issues[0].message, { issues });
  }
}

/** 校验 p：仅接受 0..100 的整数。 */
export function validatePercentile(p: unknown): asserts p is number {
  if (typeof p !== 'number' || !Number.isInteger(p) || p < 0 || p > 100) {
    throw new AppError('PERCENTILE_INVALID', '百分位 p 必须为 0 到 100 之间的整数。', { got: p });
  }
}
