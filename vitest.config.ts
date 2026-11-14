import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // 单测运行在 Node 里，没有 workerd 的 cloudflare:sockets；用 mock 替代
      'cloudflare:sockets': new URL('./test/mocks/cloudflare-sockets.ts', import.meta.url).pathname,
    },
  },
});
