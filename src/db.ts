// SQLite 持久化：样品、版本、原始质量、冻结报告。使用 Node 内置 node:sqlite。
// 修订生成新版本；旧报告继续引用当时的总质量与筛孔。重复提交不增加版本。

import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { AppError } from './errors.js';
import { CurveReport, SieveAnalysisInput } from './types.js';
import { assertValid } from './validation.js';

export interface SampleRecord {
  id: number;
  name: string | null;
  created_at: string;
}

export interface VersionRecord {
  id: number;
  sample_id: number;
  version: number;
  input_hash: string;
  dry_total_mg: number;
  pan_mg: number;
  sieves_json: string;
  report_json: string;
  created_at: string;
}

/** 计算输入的规范化哈希，用于幂等去重（重复提交不增加版本）。 */
export function hashInput(input: SieveAnalysisInput): string {
  const canonical = JSON.stringify({
    t: input.dryTotalMg,
    p: input.panMg,
    s: input.sieves.map((s) => [s.diameterMm, s.retainedMg]),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export class Store {
  readonly db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS samples (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sample_id INTEGER NOT NULL REFERENCES samples(id),
        version INTEGER NOT NULL,
        input_hash TEXT NOT NULL,
        dry_total_mg INTEGER NOT NULL,
        pan_mg INTEGER NOT NULL,
        sieves_json TEXT NOT NULL,
        report_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(sample_id, input_hash),
        UNIQUE(sample_id, version)
      );
    `);
  }

  close() {
    this.db.close();
  }

  createSample(name?: string | null): SampleRecord {
    const stmt = this.db.prepare('INSERT INTO samples (name) VALUES (?)');
    const info = stmt.run(name ?? null);
    return this.getSampleOrThrow(Number(info.lastInsertRowid));
  }

  getSampleOrThrow(id: number): SampleRecord {
    const row = this.db.prepare('SELECT * FROM samples WHERE id = ?').get(id) as
      | SampleRecord
      | undefined;
    if (!row) throw new AppError('NOT_FOUND', `样品 ${id} 不存在。`);
    return row;
  }

  listSamples(): SampleRecord[] {
    return this.db.prepare('SELECT * FROM samples ORDER BY id').all() as unknown as SampleRecord[];
  }

  listVersions(sampleId: number): VersionRecord[] {
    this.getSampleOrThrow(sampleId);
    return this.db
      .prepare('SELECT * FROM versions WHERE sample_id = ? ORDER BY version')
      .all(sampleId) as unknown as VersionRecord[];
  }

  /**
   * 提交一个筛分版本（事务内完成校验 + 冻结）。
   * - 相同输入哈希已存在：幂等返回既有版本，不新增版本号；
   * - 校验失败：抛错，不留下任何半成品曲线（事务回滚）。
   */
  submitVersion(
    sampleId: number,
    input: SieveAnalysisInput,
    report: CurveReport,
  ): { version: VersionRecord; created: boolean } {
    this.getSampleOrThrow(sampleId);
    assertValid(input);
    const hash = hashInput(input);

    const existing = this.db
      .prepare('SELECT * FROM versions WHERE sample_id = ? AND input_hash = ?')
      .get(sampleId, hash) as VersionRecord | undefined;
    if (existing) return { version: existing, created: false };

    const insertStmt = this.db.prepare(
      `INSERT INTO versions
       (sample_id, version, input_hash, dry_total_mg, pan_mg, sieves_json, report_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const maxRow = this.db
        .prepare('SELECT COALESCE(MAX(version), 0) AS v FROM versions WHERE sample_id = ?')
        .get(sampleId) as unknown as { v: number };
      const nextVersion = maxRow.v + 1;
      const info = insertStmt.run(
        sampleId,
        nextVersion,
        hash,
        input.dryTotalMg,
        input.panMg,
        JSON.stringify(input.sieves),
        JSON.stringify(report),
      );
      const created = this.db.prepare('SELECT * FROM versions WHERE id = ?').get(
        Number(info.lastInsertRowid),
      ) as unknown as VersionRecord;
      this.db.exec('COMMIT');
      return { version: created, created: true };
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  getVersion(sampleId: number, version: number): VersionRecord {
    const row = this.db
      .prepare('SELECT * FROM versions WHERE sample_id = ? AND version = ?')
      .get(sampleId, version) as VersionRecord | undefined;
    if (!row) throw new AppError('NOT_FOUND', `样品 ${sampleId} 的版本 ${version} 不存在。`);
    return row;
  }

  /** 缺省版本号时返回最新版本。 */
  getLatestVersion(sampleId: number): VersionRecord {
    this.getSampleOrThrow(sampleId);
    const row = this.db
      .prepare('SELECT * FROM versions WHERE sample_id = ? ORDER BY version DESC LIMIT 1')
      .get(sampleId) as VersionRecord | undefined;
    if (!row) throw new AppError('NOT_FOUND', `样品 ${sampleId} 尚无已提交版本。`);
    return row;
  }

  parseReport(v: VersionRecord): CurveReport {
    return JSON.parse(v.report_json) as CurveReport;
  }

  parseSieves(v: VersionRecord): SieveAnalysisInput['sieves'] {
    return JSON.parse(v.sieves_json) as SieveAnalysisInput['sieves'];
  }
}
