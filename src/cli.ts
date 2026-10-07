#!/usr/bin/env node
import { join } from 'node:path';
import { Store } from './db.js';
import { ApiError, ValidationError } from './errors.js';
import { validatePercentile, validateSubmission } from './validate.js';
import { buildReport, percentile } from './engine.js';
import { reportToCsv } from './exporters.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { SubmissionInput } from './types.js';

function usage(): void {
  console.log(`筛分累计通过曲线 CLI（仅本地虚构实验数据）

用法:
  node src/cli.ts <命令> [选项]

全局选项:
  --data-dir <目录>     数据目录（默认 ./data）

命令:
  sample-create --id <样品ID> --name <名称>
  sample-list
  version-list --sample <样品ID>
  preview --json <文件>                       预览导入并校验，不写库
  submit --sample <样品ID> --json <文件>       提交筛分版本（重复输入不新增版本）
  report --sample <样品ID> [--version <n|latest>] [--csv] [--out <文件>]
  dp --sample <样品ID> --p <0..100整数> [--version <n|latest>]
  help

JSON 输入格式:
  {
    "totalDryMassMg": 100,
    "panMassMg": 10,
    "sieves": [
      { "diameterMm": 2,   "retainedMg": 20 },
      { "diameterMm": 1,   "retainedMg": 30 },
      { "diameterMm": 0.5, "retainedMg": 40 }
    ]
  }
`);
}

function parseArgs(argv: string[]): { positional: string[]; flags: Map<string, string>; dataDir: string } {
  const flags = new Map<string, string>();
  const positional: string[] = [];
  let dataDir = join(process.cwd(), 'data');
  const booleanFlags = new Set(['csv']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (key === 'data-dir') {
        dataDir = argv[++i]!;
      } else if (booleanFlags.has(key)) {
        flags.set(key, '1');
      } else {
        flags.set(key, argv[++i] ?? '');
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags, dataDir };
}

function readJsonInput(path: string): SubmissionInput {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  return validateSubmission(raw);
}

function printError(e: unknown): never {
  if (e instanceof ValidationError) {
    console.error('校验失败（VALIDATION_FAILED）：');
    for (const issue of e.issues) {
      console.error(`  - [${issue.code}] ${issue.field}: ${issue.message}`);
      if (issue.detail) {
        console.error(`      detail: ${JSON.stringify(issue.detail)}`);
      }
    }
    process.exitCode = 422;
    return undefined as never;
  }
  if (e instanceof ApiError) {
    console.error(`错误 [${e.code}] (HTTP ${e.status}): ${e.message}`);
    process.exitCode = e.status;
    return undefined as never;
  }
  console.error('错误:', (e as Error).message);
  process.exitCode = 1;
  return undefined as never;
}

function main(): void {
  const { positional, flags, dataDir } = parseArgs(process.argv.slice(2));
  const cmd = positional[0] ?? 'help';
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    usage();
    return;
  }
  const store = new Store(join(dataDir, 'sieve.db'));
  try {
    switch (cmd) {
      case 'sample-create': {
        const id = flags.get('id') ?? `smp_${randomUUID()}`;
        const name = flags.get('name') ?? '未命名样品';
        const sample = store.createSample(id, name);
        console.log(JSON.stringify(sample, null, 2));
        break;
      }
      case 'sample-list': {
        console.log(JSON.stringify(store.listSamples(), null, 2));
        break;
      }
      case 'version-list': {
        const sample = must(flags, 'sample');
        const rows = store.listVersions(sample).map((v) => ({
          version: v.version,
          versionId: v.id,
          inputHash: v.input_hash,
          totalDryMassMg: v.total_dry_mass_mg,
          panMassMg: v.pan_mass_mg,
          sieveCount: v.sieve_count,
          createdAt: v.created_at,
        }));
        console.log(JSON.stringify(rows, null, 2));
        break;
      }
      case 'preview': {
        const input = readJsonInput(must(flags, 'json'));
        const report = buildReport(input);
        console.log(JSON.stringify({ dryRun: true, report }, null, 2));
        break;
      }
      case 'submit': {
        const sample = must(flags, 'sample');
        const input = readJsonInput(must(flags, 'json'));
        const { version, duplicated } = store.submitVersion(sample, `ver_${randomUUID()}`, input);
        console.log(
          JSON.stringify(
            {
              duplicated,
              sampleId: sample,
              versionNumber: version.version,
              report: JSON.parse(version.report),
            },
            null,
            2,
          ),
        );
        break;
      }
      case 'report': {
        const sample = must(flags, 'sample');
        const version = parseVer(flags.get('version') ?? 'latest');
        const v = store.getVersion(sample, version);
        const report = JSON.parse(v.report);
        if (flags.has('csv')) {
          const csv = reportToCsv(report);
          const out = flags.get('out');
          if (out) {
            writeFileSync(out, csv, 'utf8');
            console.error(`CSV 已写入 ${out}`);
          } else {
            process.stdout.write(csv);
          }
        } else {
          const out = flags.get('out');
          const payload = JSON.stringify({ sampleId: sample, version: v.version, report }, null, 2);
          if (out) {
            writeFileSync(out, payload, 'utf8');
            console.error(`JSON 已写入 ${out}`);
          } else {
            console.log(payload);
          }
        }
        break;
      }
      case 'dp': {
        const sample = must(flags, 'sample');
        const p = validatePercentile(must(flags, 'p'));
        const version = parseVer(flags.get('version') ?? 'latest');
        const v = store.getVersion(sample, version);
        const report = JSON.parse(v.report);
        const result = report.percentiles[p] ?? percentile(p, report.sieves);
        console.log(JSON.stringify({ sampleId: sample, version: v.version, percentile: result }, null, 2));
        break;
      }
      default:
        console.error(`未知命令: ${cmd}`);
        usage();
        process.exitCode = 2;
    }
  } catch (e) {
    printError(e);
  } finally {
    store.close();
  }
}

function must(flags: Map<string, string>, key: string): string {
  const v = flags.get(key);
  if (v === undefined || v === '') {
    throw new ApiError('INVALID_PAYLOAD', `缺少必需参数 --${key}`, 400);
  }
  return v;
}

function parseVer(s: string): number | 'latest' {
  if (s === 'latest') {
    return 'latest';
  }
  const n = Number(s);
  if (!Number.isInteger(n) || n <= 0) {
    throw new ApiError('NOT_FOUND', `--version 必须是正整数或 latest，收到 "${s}"`, 400);
  }
  return n;
}

main();
