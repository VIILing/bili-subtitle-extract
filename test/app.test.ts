import { describe, expect, it } from 'vitest';

import { handleApi } from '../src/app';
import { createToken } from '../src/auth';
import { ApiError } from '../src/errors';
import { metaCacheKey, subtitleCacheKey } from '../src/store';
import { FakeStore, TEST_BVID, TEST_KEY, makeBili, makeMeta, makeRequest } from './helpers';

const NOW = 1794600000000;
const NOW_SEC = Math.floor(NOW / 1000);
const now = () => NOW;

async function tokenFor(bvid = TEST_BVID, offsetSeconds = 0): Promise<string> {
  return createToken(TEST_KEY, bvid, NOW_SEC + offsetSeconds);
}

function deps(
  store: FakeStore,
  bili = makeBili(),
): { authKey: string; store: FakeStore; bili: ReturnType<typeof makeBili>; now: () => number } {
  return { authKey: TEST_KEY, store, bili, now };
}

async function readJson(response: Response): Promise<Record<string, any>> {
  return (await response.json()) as Record<string, any>;
}

describe('POST /api/subtitles', () => {
  it('缓存命中：直接返回，不请求 B 站', async () => {
    const store = new FakeStore(now);
    const meta = makeMeta();
    store.metas.set(metaCacheKey(TEST_BVID, 1), meta);
    store.cues.set(subtitleCacheKey(TEST_BVID, 1, 'zh-Hans'), {
      cues: [[0, 1, '缓存内容']],
      cached_at: NOW - 5000,
    });
    const bili = makeBili();

    const response = await handleApi(
      makeRequest('/api/subtitles', { token: await tokenFor(), bvid: TEST_BVID }),
      deps(store, bili),
    );
    const json = await readJson(response);

    expect(response.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.cached).toBe(true);
    expect(json.data.cues).toEqual([[0, 1, '缓存内容']]);
    expect(json.data.track.lan).toBe('zh-Hans');
    expect(bili.calls).not.toContain('resolveMeta');
    expect(bili.calls).not.toContain('downloadCues');
    expect(store.locks.size).toBe(0);
  });

  it('缓存未命中：抓取 -> 写缓存 -> 释放锁', async () => {
    const store = new FakeStore(now);
    const bili = makeBili();

    const response = await handleApi(
      makeRequest('/api/subtitles', { token: await tokenFor(), bvid: TEST_BVID }),
      deps(store, bili),
    );
    const json = await readJson(response);

    expect(response.status).toBe(200);
    expect(json.cached).toBe(false);
    expect(json.data.track.lan).toBe('zh-Hans');
    expect(bili.calls).toContain('resolveMeta');
    expect(bili.calls).toContain('downloadCues');
    expect(bili.calls).not.toContain('fetchTrackUrl:zh-Hans'); // 元信息刚请求过，URL 在内存里
    expect(store.metas.has(metaCacheKey(TEST_BVID, 1))).toBe(true);
    expect(store.cues.has(subtitleCacheKey(TEST_BVID, 1, 'zh-Hans'))).toBe(true);
    expect(store.locks.size).toBe(0);
  });

  it('锁被占用：返回 429 CACHING，不请求 B 站', async () => {
    const store = new FakeStore(now);
    store.metas.set(metaCacheKey(TEST_BVID, 1), makeMeta());
    store.locks.set(subtitleCacheKey(TEST_BVID, 1, 'zh-Hans'), NOW + 60_000);
    const bili = makeBili();

    const response = await handleApi(
      makeRequest('/api/subtitles', { token: await tokenFor(), bvid: TEST_BVID }),
      deps(store, bili),
    );
    const json = await readJson(response);

    expect(response.status).toBe(429);
    expect(json.code).toBe('CACHING');
    expect(json.retry_after_seconds).toBeGreaterThan(0);
    expect(bili.calls).not.toContain('resolveMeta');
    expect(bili.calls).not.toContain('downloadCues');
  });

  it('token 过期：401 AUTH_FAILED', async () => {
    const store = new FakeStore(now);
    const response = await handleApi(
      makeRequest('/api/subtitles', {
        token: await tokenFor(TEST_BVID, -120),
        bvid: TEST_BVID,
      }),
      deps(store),
    );
    const json = await readJson(response);
    expect(response.status).toBe(401);
    expect(json.code).toBe('AUTH_FAILED');
    expect(json.message).toContain('过期');
  });

  it('密钥错误：401', async () => {
    const store = new FakeStore(now);
    const token = await createToken('wrong-key', TEST_BVID, NOW_SEC);
    const response = await handleApi(
      makeRequest('/api/subtitles', { token, bvid: TEST_BVID }),
      deps(store),
    );
    const json = await readJson(response);
    expect(response.status).toBe(401);
    expect(json.message).toContain('密钥');
  });

  it('token 与 bvid 不匹配：401', async () => {
    const store = new FakeStore(now);
    const token = await tokenFor('BV1xx411c7mD');
    const response = await handleApi(
      makeRequest('/api/subtitles', { token, bvid: TEST_BVID }),
      deps(store),
    );
    expect(response.status).toBe(401);
  });

  it('BVID 非法：400', async () => {
    const store = new FakeStore(now);
    const response = await handleApi(
      makeRequest('/api/subtitles', { token: await tokenFor(), bvid: 'not-a-bvid' }),
      deps(store),
    );
    const json = await readJson(response);
    expect(response.status).toBe(400);
    expect(json.code).toBe('INVALID_BVID');
  });

  it('没有字幕轨：200 + empty', async () => {
    const store = new FakeStore(now);
    const emptyMeta = makeMeta({ tracks: [], default_lan: null });
    const bili = makeBili({ resolveMeta: async () => ({ meta: emptyMeta, urls: new Map() }) });

    const response = await handleApi(
      makeRequest('/api/subtitles', { token: await tokenFor(), bvid: TEST_BVID }),
      deps(store, bili),
    );
    const json = await readJson(response);

    expect(response.status).toBe(200);
    expect(json.empty).toBe(true);
    expect(json.data.tracks).toEqual([]);
    expect(json.data.cues).toEqual([]);
    expect(store.metas.has(metaCacheKey(TEST_BVID, 1))).toBe(true);
  });

  it('字幕 auth_key 过期：自动刷新 URL 再试一次', async () => {
    const store = new FakeStore(now);
    let attempts = 0;
    const bili = makeBili({
      downloadCues: async () => {
        attempts += 1;
        if (attempts === 1) throw new ApiError(403, 'SUBTITLE_EXPIRED', 'auth_key 过期');
        return [[0, 1, '重试成功']];
      },
    });

    const response = await handleApi(
      makeRequest('/api/subtitles', { token: await tokenFor(), bvid: TEST_BVID }),
      deps(store, bili),
    );
    const json = await readJson(response);

    expect(response.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.data.cues).toEqual([[0, 1, '重试成功']]);
    expect(bili.calls).toContain('fetchTrackUrl:zh-Hans');
    expect(bili.calls.filter((call) => call === 'downloadCues')).toHaveLength(2);
  });

  it('服务端未配置 AES_KEY：500 SERVER_NOT_CONFIGURED', async () => {
    const store = new FakeStore(now);
    const response = await handleApi(makeRequest('/api/subtitles', { bvid: TEST_BVID }), {
      authKey: undefined,
      store,
      bili: makeBili(),
      now,
    });
    const json = await readJson(response);
    expect(response.status).toBe(500);
    expect(json.code).toBe('SERVER_NOT_CONFIGURED');
    expect(json.message).toContain('AES_KEY');
  });

  it('请求体非法 JSON：400', async () => {
    const store = new FakeStore(now);
    const request = new Request('https://example.com/api/subtitles', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{bad json',
    });
    const response = await handleApi(request, deps(store));
    const json = await readJson(response);
    expect(response.status).toBe(400);
    expect(json.code).toBe('INVALID_REQUEST');
  });
});

describe('GET /api/health 与路由', () => {
  it('health 返回 B 站探测结果与配置状态', async () => {
    const store = new FakeStore(now);
    const response = await handleApi(makeRequest('/api/health', undefined, 'GET'), deps(store));
    const json = await readJson(response);

    expect(response.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.config.aes_key_configured).toBe(true);
    expect(json.bilibili.ok).toBe(true);
    expect(json.bilibili.code).toBe(-101);
  });

  it('OPTIONS 返回 CORS 预检', async () => {
    const response = await handleApi(makeRequest('/api/subtitles', undefined, 'OPTIONS'), deps(new FakeStore(now)));
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('未知接口返回 404', async () => {
    const response = await handleApi(makeRequest('/api/unknown', undefined, 'GET'), deps(new FakeStore(now)));
    const json = await readJson(response);
    expect(response.status).toBe(404);
    expect(json.code).toBe('NOT_FOUND');
  });
});
