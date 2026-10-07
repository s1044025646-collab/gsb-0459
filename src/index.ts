// 服务启动入口：项目内 data 目录、可配置端口（默认空闲端口）。

import { join } from 'node:path';
import { Store } from './db.js';
import { SieveService } from './service.js';
import { createApp, pickFreePort } from './server.js';

export interface StartOptions {
  dataDir?: string;
  port?: number;
}

export async function startServer(opts: StartOptions = {}) {
  const dataDir = opts.dataDir ?? process.env.SIEVE_DATA_DIR ?? join(process.cwd(), 'data');
  const store = new Store(join(dataDir, 'sieve.db'));
  const service = new SieveService(store);
  const app = createApp(service);

  const port = opts.port ?? (process.env.PORT ? Number(process.env.PORT) : await pickFreePort());
  await new Promise<void>((resolve) => app.listen(port, '127.0.0.1', resolve));
  return { app, port, store, service };
}

const isMain = (() => {
  try {
    return process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
  } catch {
    return false;
  }
})();

if (isMain) {
  startServer()
    .then(({ port }) => {
      // eslint-disable-next-line no-console
      console.log(`筛分曲线服务已启动: http://127.0.0.1:${port}`);
      console.log('可用环境变量: PORT（固定端口）, SIEVE_DATA_DIR（数据目录，默认 ./data）');
    })
    .catch((err) => {
      console.error('启动失败:', err);
      process.exit(1);
    });
}
