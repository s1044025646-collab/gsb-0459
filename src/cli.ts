// 命令行界面：建样、预览、提交、查曲线、查百分位、导出、演示。

import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { Store } from './db.js';
import { SieveService } from './service.js';
import { AppError } from './errors.js';
import { SieveAnalysisInput } from './types.js';
import { runDemo } from './demo.js';

function parseArgs(argv: string[]): { cmd: string; positional: string[]; flags: Record<string, string> } {
  const [cmd, ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = rest[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = 'true';
      }
    } else {
      positional.push(a);
    }
  }
  return { cmd: cmd ?? 'help', positional, flags };
}

const HELP = `
筛分累计通过曲线与粒径区间核验 CLI

用法:
  node dist/src/cli.js init-sample [--name 名称]
  node dist/src/cli.js preview --input 输入.json
  node dist/src/cli.js submit --sample 1 --input 输入.json [--targets 10,30,60]
  node dist/src/cli.js curve --sample 1 [--version 1]
  node dist/src/cli.js percentile --sample 1 --p 30 [--version 1]
  node dist/src/cli.js export --sample 1 [--version 1] --format json|csv [--out 文件]
  node dist/src/cli.js versions --sample 1
  node dist/src/cli.js demo
  node dist/src/cli.js help

输入 JSON 结构:
  {"dryTotalMg":100,"panMg":10,
   "sieves":[{"diameterMm":2,"retainedMg":20}, ...]}   // 直径从大到小

环境变量: SIEVE_DATA_DIR（数据目录，默认 ./data）
`;

function loadService(): { service: SieveService; store: Store } {
  const dataDir = process.env.SIEVE_DATA_DIR ?? join(process.cwd(), 'data');
  const store = new Store(join(dataDir, 'sieve.db'));
  return { service: new SieveService(store), store };
}

function loadInput(path: string): SieveAnalysisInput {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  return raw as SieveAnalysisInput;
}

function print(obj: unknown) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

export async function main(argv: string[]): Promise<number> {
  const { cmd, positional, flags } = parseArgs(argv);

  if (cmd === 'help' || cmd === undefined) {
    process.stdout.write(HELP + '\n');
    return 0;
  }

  if (cmd === 'demo') {
    const { service, store } = loadService();
    try {
      await runDemo(service, (line) => process.stdout.write(line + '\n'));
    } finally {
      store.close();
    }
    return 0;
  }

  const { service, store } = loadService();
  try {
    switch (cmd) {
      case 'init-sample': {
        print(service.createSample(flags.name ?? null));
        break;
      }
      case 'preview': {
        if (!flags.input) throw new AppError('VALIDATION_ERROR', 'preview 需要 --input 输入.json');
        print(service.preview(loadInput(flags.input)));
        break;
      }
      case 'submit': {
        const sampleId = Number(flags.sample);
        if (!Number.isInteger(sampleId)) throw new AppError('VALIDATION_ERROR', 'submit 需要 --sample 编号');
        if (!flags.input) throw new AppError('VALIDATION_ERROR', 'submit 需要 --input 输入.json');
        const targets = flags.targets ? flags.targets.split(',').map((x) => Number(x.trim())) : [];
        const result = service.submit(sampleId, loadInput(flags.input), targets);
        print({ created: result.created, version: result.version.version });
        break;
      }
      case 'curve': {
        const id = requiredId(flags.sample);
        print(service.getReport(id, flags.version ? Number(flags.version) : undefined).report);
        break;
      }
      case 'percentile': {
        const id = requiredId(flags.sample);
        if (flags.p === undefined) throw new AppError('VALIDATION_ERROR', 'percentile 需要 --p 0..100 整数');
        print(service.queryPercentile(id, Number(flags.p), flags.version ? Number(flags.version) : undefined));
        break;
      }
      case 'versions': {
        print(service.listVersions(requiredId(flags.sample)).map((v) => ({
          version: v.version,
          inputHash: v.input_hash,
          dryTotalMg: v.dry_total_mg,
          panMg: v.pan_mg,
          createdAt: v.created_at,
        })));
        break;
      }
      case 'export': {
        const id = requiredId(flags.sample);
        const format = flags.format === 'csv' ? 'csv' : 'json';
        const { content } = service.export(id, format, flags.version ? Number(flags.version) : undefined);
        if (flags.out) writeFileSync(flags.out, content, 'utf8');
        else process.stdout.write(content + '\n');
        break;
      }
      default:
        process.stdout.write(HELP + '\n');
        return 2;
    }
    return 0;
  } catch (err) {
    if (err instanceof AppError) {
      process.stderr.write(JSON.stringify(err.toJSON(), null, 2) + '\n');
      return 1;
    }
    process.stderr.write(String(err) + '\n');
    return 1;
  } finally {
    store.close();
  }
}

function requiredId(v: string | undefined): number {
  const id = Number(v);
  if (!Number.isInteger(id)) throw new AppError('VALIDATION_ERROR', '需要 --sample 样品编号');
  return id;
}

main(process.argv.slice(2)).then((code) => process.exit(code));
