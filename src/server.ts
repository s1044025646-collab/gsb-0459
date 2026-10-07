// 纯 HTTP API（无第三方框架）。默认选择空闲端口，可用 PORT 环境变量固定。

import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { SieveService, errorResponse } from './service.js';
import { AppError } from './errors.js';

interface Route {
  method: string;
  pattern: RegExp;
  handle: (req: IncomingMessage, res: ServerResponse, groups: Record<string, string>, url: URL) => void;
}

function readJson(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 1_000_000) reject(new AppError('VALIDATION_ERROR', '请求体过大（上限 1MB）。'));
      chunks.push(c);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      }catch {
        reject(new AppError('VALIDATION_ERROR', '请求体不是合法 JSON。'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(text);
}

export function createApp(service: SieveService): Server {
  const routes: Route[] = [
    {
      method: 'GET',
      pattern: /^\/api\/health$/,
      handle: (_req, res) => sendJson(res, 200, { ok: true }),
    },
    {
      method: 'GET',
      pattern: /^\/api\/samples$/,
      handle: (_req, res) => sendJson(res, 200, { samples: service.listSamples() }),
    },
    {
      method: 'POST',
      pattern: /^\/api\/samples$/,
      handle: async (req, res) => {
        const body = await readJson(req);
        const sample = service.createSample(typeof body?.name === 'string' ? body.name : null);
        sendJson(res, 201, { sample });
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/preview$/,
      handle: async (req, res) => {
        const body = await readJson(req);
        const result = service.preview(body);
        sendJson(res, result.ok ? 200 : 422, result);
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/samples\/(?<id>\d+)\/versions$/,
      handle: (_req, res, g) =>
        sendJson(res, 200, { versions: service.listVersions(Number(g.id)) }),
    },
    {
      method: 'POST',
      pattern: /^\/api\/samples\/(?<id>\d+)\/versions$/,
      handle: async (req, res, g) => {
        const body = await readJson(req);
        const targets = Array.isArray(body?.targets) ? body.targets.map(Number) : [];
        const { version, created } = service.submit(Number(g.id), body, targets);
        sendJson(res, created ? 201 : 200, {
          created,
          version: version.version,
          inputHash: version.input_hash,
          report: JSON.parse(version.report_json),
        });
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/samples\/(?<id>\d+)\/curve$/,
      handle: (_req, res, g, url) => {
        const v = url.searchParams.get('version');
        const { version: ver, report } = service.getReport(Number(g.id), v ? Number(v) : undefined);
        sendJson(res, 200, { version: ver.version, report });
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/samples\/(?<id>\d+)\/percentile\/(?<p>\d+)$/,
      handle: (_req, res, g, url) => {
        const v = url.searchParams.get('version');
        const result = service.queryPercentile(Number(g.id), Number(g.p), v ? Number(v) : undefined);
        sendJson(res, 200, result);
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/samples\/(?<id>\d+)\/export$/,
      handle: (_req, res, g, url) => {
        const v = url.searchParams.get('version');
        const format = url.searchParams.get('format') === 'csv' ? 'csv' : 'json';
        const { content, contentType } = service.export(Number(g.id), format, v ? Number(v) : undefined);
        res.writeHead(200, { 'content-type': contentType });
        res.end(content);
      },
    },
  ];

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      for (const route of routes) {
        if (route.method !== req.method) continue;
        const m = route.pattern.exec(url.pathname);
        if (!m) continue;
        await route.handle(req, res, m.groups ?? {}, url);
        return;
      }
      sendJson(res, 404, { error: { code: 'NOT_FOUND', message: '未找到对应 API 路由。', details: null } });
    } catch (err) {
      const { status, body } = errorResponse(err);
      sendJson(res, status, body);
    }
  });
}

/** 返回一个系统选定的空闲端口。 */
export function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error('无法获取空闲端口')));
      }
    });
    srv.on('error', reject);
  });
}
