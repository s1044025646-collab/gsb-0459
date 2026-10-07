// 服务编排：把校验、计算、存储组合成可被 API 与 CLI 复用的操作。

import { Store, VersionRecord } from './db.js';
import { AppError } from './errors.js';
import { buildReport } from './curve.js';
import { percentile } from './curve.js';
import { toCSV, toJSON } from './export.js';
import { CurveReport, PercentileResult, SieveAnalysisInput } from './types.js';
import { validateInput } from './validation.js';

export interface PreviewResult {
  ok: boolean;
  issues: ReturnType<typeof validateInput>;
  report: CurveReport | null;
}

export class SieveService {
  constructor(private store: Store) {}

  /** 预览：返回逐条导入错误；若无错误则给出不落库的试算报告。 */
  preview(input: Partial<SieveAnalysisInput>): PreviewResult {
    const issues = validateInput(input);
    if (issues.length > 0) return { ok: false, issues, report: null };
    return { ok: true, issues: [], report: buildReport(input as SieveAnalysisInput) };
  }

  createSample(name?: string) {
    return this.store.createSample(name ?? null);
  }

  listSamples() {
    return this.store.listSamples();
  }

  listVersions(sampleId: number) {
    return this.store.listVersions(sampleId);
  }

  /** 提交版本：失败抛错（不产生半成品）；重复输入幂等返回旧版本。 */
  submit(sampleId: number, input: SieveAnalysisInput, targets: number[] = []) {
    const report = buildReport(input, targets);
    return this.store.submitVersion(sampleId, input, report);
  }

  getReport(sampleId: number, version?: number): { version: VersionRecord; report: CurveReport } {
    const v =
      version === undefined ? this.store.getLatestVersion(sampleId) : this.store.getVersion(sampleId, version);
    return { version: v, report: this.store.parseReport(v) };
  }

  /** 在已冻结报告上查询任意允许百分位（用该版本当时的总质量与筛级重算，保证口径一致）。 */
  queryPercentile(sampleId: number, p: number, version?: number): PercentileResult {
    const { report } = this.getReport(sampleId, version);
    return percentile(report.rows, p, report.dryTotalMg);
  }

  export(sampleId: number, format: 'json' | 'csv', version?: number): { content: string; contentType: string } {
    const { version: v, report } = this.getReport(sampleId, version);
    if (format === 'csv') return { content: toCSV(report), contentType: 'text/csv; charset=utf-8' };
    return {
      content: toJSON(report, {
        sampleId,
        version: v.version,
        dryTotalMg: report.dryTotalMg,
        panMg: report.panMg,
      }),
      contentType: 'application/json; charset=utf-8',
    };
  }
}

export function errorResponse(err: unknown): { status: number; body: unknown } {
  if (err instanceof AppError) {
    const status =
      err.code === 'NOT_FOUND' ? 404 : err.code === 'CONFLICT' ? 409 : 400;
    return { status, body: { error: err.toJSON() } };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { status: 500, body: { error: { code: 'INTERNAL_ERROR', message, details: null } } };
}
