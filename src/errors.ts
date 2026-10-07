// 统一错误码与可序列化的校验错误。失败一律给出明确中文解释，不用 NaN 代替。

export type ErrorCode =
  | 'VALIDATION_ERROR' // 通用输入校验失败
  | 'TOTAL_NOT_POSITIVE_INTEGER' // 干样总质量不是正安全整数
  | 'MASS_NOT_NONNEGATIVE_INTEGER' // 某质量为负或非整数
  | 'MASS_NOT_BALANCED' // 各筛 + 底盘 与总质量不闭合
  | 'SIEVES_EMPTY' // 缺少筛级
  | 'TOO_MANY_SIEVES' // 筛级数超限
  | 'DIAMETER_INVALID' // 直径非正、非有限数
  | 'DIAMETER_NOT_STRICTLY_DECREASING' // 直径未严格递减（重复或颠倒）
  | 'MASS_TOO_LARGE' // 质量总和超限
  | 'PAN_MISSING' // 缺底盘
  | 'PERCENTILE_INVALID' // p 不是 0..100 的整数
  | 'NOT_FOUND' // 样品/版本不存在
  | 'CONFLICT' // 状态冲突（如重复提交等）
  | 'INTERNAL_ERROR';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }

  toJSON() {
    return { code: this.code, message: this.message, details: this.details ?? null };
  }
}

/** 单字段校验问题（预览导入错误时逐条返回）。 */
export interface ValidationIssue {
  code: ErrorCode;
  field: string;
  message: string;
}
