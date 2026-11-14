/**
 * Cloudflare Worker 入口。
 *
 * - /api/* 交给 src/app.ts（字幕 API + 健康检查）
 * - 其它请求交给静态资源（public/index.html 网页）
 * - Cron Trigger：每天清理 D1 里过期的缓存 / 锁
 */

import { handleApi } from './app';
import { configureBiliClient, createBiliClient } from './bili';
import { createD1Store } from './store';
import type { Env } from './types';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;

    if (path.startsWith('/api/')) {
      configureBiliClient(env.BILI_TRANSPORT);
      return handleApi(request, {
        authKey: env.AES_KEY,
        store: createD1Store(env.DB),
        bili: createBiliClient(),
      });
    }

    // 静态资源（public/ 目录）：index.html / app.js / style.css
    return env.ASSETS.fetch(request);
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    try {
      const store = createD1Store(env.DB);
      await store.ensureSchema();
      const removed = await store.cleanup();
      console.log(`[cleanup] 已清理 ${removed} 行过期数据`);
    } catch (error) {
      console.error('[cleanup] 清理失败', error);
    }
  },
} satisfies ExportedHandler<Env>;
