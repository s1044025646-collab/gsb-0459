import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { ApiError } from './errors.js';
import { buildReport, percentile } from './engine.js';
import type { FrozenReport, SubmissionInput } from './types.js';

export interface SampleRow {
  id: string;
  name: string;
  created_at: string;
}

export interface VersionRow {
  id: string;
  sample_id: string;
  version: number;
  input_hash: string;
  total_dry_mass_mg: number;
  pan_mass_mg: number;
  sieve_count: number;
  payload: string;
  report: string;
  created_at: string;
}

export function canonicalHash(input: SubmissionInput): string {
  const canonical = JSON.stringify({
    t: input.totalDryMassMg,
    p: input.panMassMg,
    s: input.sieves.map((s) => [s.diameterMm, s.retainedMg]),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export class Store {
  readonly db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS samples (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS versions (
        id TEXT PRIMARY KEY,
        sample_id TEXT NOT NULL REFERENCES samples(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        input_hash TEXT NOT NULL,
        total_dry_mass_mg INTEGER NOT NULL,
        pan_mass_mg INTEGER NOT NULL,
        sieve_count INTEGER NOT NULL,
        payload TEXT NOT NULL,
        report TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(sample_id, version),
        UNIQUE(sample_id, input_hash)
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  createSample(id: string, name: string): SampleRow {
    const stmt = this.db.prepare('INSERT INTO samples (id, name) VALUES (?, ?)');
    stmt.run(id, name);
    return this.getSampleOrThrow(id);
  }

  getSample(id: string): SampleRow | undefined {
    const row = this.db.prepare('SELECT * FROM samples WHERE id = ?').get(id) as SampleRow | undefined;
    return row;
  }

  getSampleOrThrow(id: string): SampleRow {
    const row = this.getSample(id);
    if (!row) {
      throw new ApiError('NOT_FOUND', `样品 ${id} 不存在`, 404);
    }
    return row;
  }

  listSamples(): SampleRow[] {
    return this.db.prepare('SELECT * FROM samples ORDER BY created_at, id').all() as unknown as SampleRow[];
  }

  listVersions(sampleId: string): VersionRow[] {
    this.getSampleOrThrow(sampleId);
    return this.db
      .prepare('SELECT * FROM versions WHERE sample_id = ? ORDER BY version')
      .all(sampleId) as unknown as VersionRow[];
  }

  getVersion(sampleId: string, version: number | 'latest'): VersionRow {
    this.getSampleOrThrow(sampleId);
    const row =
      version === 'latest'
        ? (this.db
            .prepare('SELECT * FROM versions WHERE sample_id = ? ORDER BY version DESC LIMIT 1')
            .get(sampleId) as VersionRow | undefined)
        : (this.db
            .prepare('SELECT * FROM versions WHERE sample_id = ? AND version = ?')
            .get(sampleId, version) as VersionRow | undefined);
    if (!row) {
      throw new ApiError(
        'NOT_FOUND',
        version === 'latest' ? `样品 ${sampleId} 尚无筛分版本` : `样品 ${sampleId} 版本 ${version} 不存在`,
        404,
      );
    }
    return row;
  }

  submitVersion(sampleId: string, id: string, input: SubmissionInput): { version: VersionRow; duplicated: boolean } {
    this.getSampleOrThrow(sampleId);
    const hash = canonicalHash(input);
    const existing = this.db
      .prepare('SELECT * FROM versions WHERE sample_id = ? AND input_hash = ?')
      .get(sampleId, hash) as VersionRow | undefined;
    if (existing) {
      return { version: existing, duplicated: true };
    }
    const report = buildReport(input);
    let nextVersion = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const max = this.db
        .prepare('SELECT COALESCE(MAX(version), 0) AS m FROM versions WHERE sample_id = ?')
        .get(sampleId) as { m: number };
      nextVersion = max.m + 1;
      this.db
        .prepare(
          `INSERT INTO versions
             (id, sample_id, version, input_hash, total_dry_mass_mg, pan_mass_mg, sieve_count, payload, report)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          sampleId,
          nextVersion,
          hash,
          input.totalDryMassMg,
          input.panMassMg,
          input.sieves.length,
          JSON.stringify(input),
          JSON.stringify(report),
        );
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return { version: this.getVersion(sampleId, nextVersion), duplicated: false };
  }

  computePercentile(sampleId: string, version: number | 'latest', p: number): {
    version: VersionRow;
    result: FrozenReport['percentiles'][number];
  } {
    const v = this.getVersion(sampleId, version);
    const report = JSON.parse(v.report) as FrozenReport;
    if (!report.percentiles[p]) {
      report.percentiles[p] = percentile(p, report.sieves);
    }
    return { version: v, result: report.percentiles[p]! };
  }
}
