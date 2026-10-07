export type ErrorCode =
  | 'VALIDATION_TOTAL_MASS'
  | 'VALIDATION_MASS_NOT_INTEGER'
  | 'VALIDATION_MASS_TOO_LARGE'
  | 'VALIDATION_MASS_NEGATIVE'
  | 'MASS_NOT_BALANCED'
  | 'MISSING_PAN'
  | 'VALIDATION_SIEVES_EMPTY'
  | 'VALIDATION_SIEVES_TOO_MANY'
  | 'VALIDATION_DIAMETER_NOT_FINITE'
  | 'VALIDATION_DIAMETER_NOT_POSITIVE'
  | 'VALIDATION_DIAMETER_NOT_STRICT_DECREASING'
  | 'INVALID_PERCENTILE'
  | 'INVALID_PAYLOAD'
  | 'NOT_FOUND'
  | 'DUPLICATE_VERSION_KEY';

export interface FieldIssue {
  field: string;
  code: ErrorCode;
  message: string;
  detail?: Record<string, number | string>;
}

export class ValidationError extends Error {
  readonly issues: FieldIssue[];
  constructor(issues: FieldIssue[]) {
    super(issues.map((i) => i.message).join('; '));
    this.name = 'ValidationError';
    this.issues = issues;
  }
}

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly detail?: Record<string, number | string> | undefined;
  constructor(code: ErrorCode, message: string, status = 400, detail?: Record<string, number | string> | undefined) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}
