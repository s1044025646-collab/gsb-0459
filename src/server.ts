import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Store } from './db.js';
import { ApiError, ValidationError } from './errors.js';
import { validatePercentile, validateSubmission } from './validate.js';
import { buildReport } from './engine.js';
import { reportToCsv } from './exporters.js';
import type { FrozenReport, SubmissionInput } from './types.js';

export interface AppConfig {
  dataDir: string;
  port: number | 0;
  host: string;
}

function readJson(req: IncomingMessage, maxBytes = 1_000_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new ApiError('INVALID_PAYLOAD', `请求体超过 ${maxBytes} 字节限制`, 413));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
      } catch {
        reject(new ApiError('INVALID_PAYLOAD', '请求体不是合法 JSON', 400));
      }
    });
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(body));
}

function parseVersion(seg: string): number | 'latest' {
  if (seg === 'latest' || seg === '') {
    return 'latest';
  }
  const n = Number(seg);
  if (!Number.isInteger(n) || n <= 0) {
    throw new ApiError('NOT_FOUND', `版本号必须是正整数或 latest，收到 "${seg}"`, 400);
  }
  return n;
}

export function createApp(store: Store) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = req.method ?? 'GET';
    try {
      if (path === '/health' && method === 'GET') {
        send(res, 200, { ok: true, service: 'sieve-analysis', time: new Date().toISOString() });
        return;
      }

      if (path === '/api/samples' && method === 'GET') {
        send(res, 200, { samples: store.listSamples() });
        return;
      }

      if (path === '/api/samples' && method === 'POST') {
        const body = (await readJson(req)) as { name?: unknown; id?: unknown };
        const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : '未命名样品';
        const id = typeof body.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(body.id) ? body.id : `smp_${randomUUID()}`;
        try {
          const sample = store.createSample(id, name);
          send(res, 201, { sample });
        } catch (e) {
          const msg = (e as Error).message;
          throw new ApiError('INVALID_PAYLOAD', `建立样品失败：${msg}（id 可能重复）`, 409);
        }
        return;
      }

      const previewMatch = /^\/api\/sieve-versions\/preview$/.exec(path);
      if (previewMatch && method === 'POST') {
        const raw = await readJson(req);
        const input = validateSubmission(raw);
        const report = buildReport(input);
        send(res, 200, { ok: true, dryRun: true, report });
        return;
      }

      const submitMatch = /^\/api\/samples\/([^/]+)\/versions$/.exec(path);
      if (submitMatch && method === 'POST') {
        const sampleId = decodeURIComponent(submitMatch[1]!);
        store.getSampleOrThrow(sampleId);
        const raw = await readJson(req);
        const input: SubmissionInput = validateSubmission(raw);
        const result = store.submitVersion(sampleId, `ver_${randomUUID()}`, input);
        send(res, result.duplicated ? 200 : 201, {
          duplicated: result.duplicated,
          sampleId,
          versionNumber: result.version.version,
          versionId: result.version.id,
          report: JSON.parse(result.version.report) as FrozenReport,
        });
        return;
      }

      const versionsMatch = /^\/api\/samples\/([^/]+)\/versions$/.exec(path);
      if (versionsMatch && method === 'GET') {
        const sampleId = decodeURIComponent(versionsMatch[1]!);
        const rows = store.listVersions(sampleId).map((v) => ({
          version: v.version,
          versionId: v.id,
          inputHash: v.input_hash,
          totalDryMassMg: v.total_dry_mass_mg,
          panMassMg: v.pan_mass_mg,
          sieveCount: v.sieve_count,
          createdAt: v.created_at,
        }));
        send(res, 200, { sampleId, versions: rows });
        return;
      }

      const reportMatch = /^\/api\/samples\/([^/]+)\/versions\/([^/]+)\/report$/.exec(path);
      if (reportMatch && method === 'GET') {
        const sampleId = decodeURIComponent(reportMatch[1]!);
        const version = parseVersion(reportMatch[2]!);
        const v = store.getVersion(sampleId, version);
        const format = url.searchParams.get('format');
        const report = JSON.parse(v.report) as FrozenReport;
        if (format === 'csv') {
          send(res, 200, reportToCsv(report), {
            'content-type': 'text/csv; charset=utf-8',
            'content-disposition': `attachment; filename="report_${sampleId}_v${v.version}.csv"`,
          });
          return;
        }
        send(res, 200, {
          sampleId,
          version: v.version,
          versionId: v.id,
          createdAt: v.created_at,
          frozenInput: JSON.parse(v.payload) as SubmissionInput,
          report,
        });
        return;
      }

      const pctMatch = /^\/api\/samples\/([^/]+)\/versions\/([^/]+)\/percentiles\/([^/]+)$/.exec(path);
      if (pctMatch && method === 'GET') {
        const sampleId = decodeURIComponent(pctMatch[1]!);
        const version = parseVersion(pctMatch[2]!);
        const p = validatePercentile(decodeURIComponent(pctMatch[3]!));
        const { version: v, result } = store.computePercentile(sampleId, version, p);
        send(res, 200, { sampleId, version: v.version, percentile: result });
        return;
      }

      send(res, 404, { error: { code: 'NOT_FOUND', message: `无此路由：${method} ${path}` } });
    } catch (e) {
      if (e instanceof ValidationError) {
        send(res, 422, { error: { code: 'VALIDATION_FAILED', message: e.message, issues: e.issues } });
        return;
      }
      if (e instanceof ApiError) {
        send(res, e.status, { error: { code: e.code, message: e.message, detail: e.detail } });
        return;
      }
      const err = e as Error;
      send(res, 500, { error: { code: 'INTERNAL', message: err.message } });
    }
  };
}

export function startServer(config: AppConfig): Promise<{ server: Server; port: number; close: () => void }> {
  const store = new Store(join(config.dataDir, 'sieve.db'));
  const server: Server = createServer(createApp(store));
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(config.port, config.host, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : config.port;
      resolve({
        server,
        port,
        close: () => {
          server.close();
          store.close();
        },
      });
    });
  });
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === entrypoint) {
  const portEnv = process.env.PORT ? Number(process.env.PORT) : 0;
  const port = Number.isInteger(portEnv) && portEnv >= 0 && portEnv <= 65535 ? portEnv : 0;
  const host = process.env.HOST ?? '127.0.0.1';
  const dataDir = process.env.DATA_DIR ?? join(process.cwd(), 'data');
  startServer({ dataDir, port, host }).then(({ port: actual }) => {
    console.log(`筛分分析后端已启动: http://${host}:${actual}`);
    console.log(`数据目录: ${dataDir}`);
  });
}
