import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  PREFERRED_LANGS,
  configureBiliClient,
  createBiliClient,
  normalizeSubtitleUrl,
  pickTrack,
} from '../src/bili';
import { ApiError } from '../src/errors';
import { makeMeta } from './helpers';

const BVID = 'BV1GJ411x7h7';

const VIEW_OK = {
  code: 0,
  message: 'OK',
  data: {
    bvid: BVID,
    aid: 80433022,
    title: '测试视频',
    pic: 'http://i0.hdslb.com/cover.jpg',
    duration: 220,
    pubdate: 1700000000,
    owner: { mid: 100, name: 'UP 主' },
    pages: [
      { cid: 111, page: 1, part: 'P1', duration: 100 },
      { cid: 222, page: 2, part: 'P2', duration: 120 },
    ],
  },
};

const DM_OK = {
  code: 0,
  message: 'OK',
  data: {
    subtitle: {
      subtitles: [
        {
          lan: 'zh-CN',
          lan_doc: '中文（中国）',
          subtitle_url: 'http://aisubtitle.hdslb.com/zh-CN.json?auth_key=1',
          ai_status: 0,
        },
        {
          lan: 'zh-Hans',
          lan_doc: '中文（简体）',
          subtitle_url: '//aisubtitle.hdslb.com/zh-Hans.json?auth_key=2',
          ai_status: 0,
        },
        {
          lan: 'en-US',
          lan_doc: 'English',
          subtitle_url: 'http://aisubtitle.hdslb.com/en-US.json?auth_key=3',
          ai_status: 1,
        },
      ],
    },
  },
};

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('normalizeSubtitleUrl', () => {
  it('把 http / // 统一升级为 https', () => {
    expect(normalizeSubtitleUrl('http://aisubtitle.hdslb.com/a.json')).toBe(
      'https://aisubtitle.hdslb.com/a.json',
    );
    expect(normalizeSubtitleUrl('//aisubtitle.hdslb.com/a.json')).toBe(
      'https://aisubtitle.hdslb.com/a.json',
    );
    expect(normalizeSubtitleUrl('https://i0.hdslb.com/a.json')).toBe('https://i0.hdslb.com/a.json');
    expect(normalizeSubtitleUrl('')).toBe('');
  });
});

describe('pickTrack', () => {
  const tracks = makeMeta().tracks; // zh-Hans, en-US

  it('auto 按 PREFERRED_LANGS 优先', () => {
    expect(pickTrack(tracks, 'auto').lan).toBe('zh-Hans');
    expect(PREFERRED_LANGS.indexOf('zh-Hans')).toBeLessThan(PREFERRED_LANGS.indexOf('en-US'));
  });

  it('精确匹配 lan（忽略大小写）', () => {
    expect(pickTrack(tracks, 'en-US').lan).toBe('en-US');
    expect(pickTrack(tracks, 'EN-us').lan).toBe('en-US');
  });

  it('别名 zh / en 能命中真实轨道', () => {
    expect(pickTrack(tracks, 'zh').lan).toBe('zh-Hans');
    expect(pickTrack(tracks, 'en').lan).toBe('en-US');
  });

  it('找不到时报 TRACK_NOT_FOUND', () => {
    try {
      pickTrack(tracks, 'fr');
      throw new Error('应该抛出 ApiError');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe('TRACK_NOT_FOUND');
      expect((error as ApiError).status).toBe(400);
    }
  });

  it('没有字幕轨时报 NO_SUBTITLE_TRACK', () => {
    try {
      pickTrack([], 'auto');
      throw new Error('应该抛出 ApiError');
    } catch (error) {
      expect((error as ApiError).code).toBe('NO_SUBTITLE_TRACK');
    }
  });
});

describe('resolveMeta', () => {
  it('解析 view + dm/view，升级 URL，默认轨优先 zh-Hans', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(VIEW_OK))
      .mockResolvedValueOnce(jsonResponse(DM_OK));
    vi.stubGlobal('fetch', fetchMock);

    const bili = createBiliClient();
    const { meta, urls } = await bili.resolveMeta(BVID, 1);

    expect(meta.video.cid).toBe(111);
    expect(meta.video.page).toBe(1);
    expect(meta.video.page_count).toBe(2);
    expect(meta.video.owner_name).toBe('UP 主');
    expect(meta.tracks.map((track) => track.lan)).toEqual(['zh-CN', 'zh-Hans', 'en-US']);
    expect(meta.tracks.find((track) => track.lan === 'en-US')?.is_ai).toBe(true);
    expect(meta.default_lan).toBe('zh-Hans');
    expect(urls.get('zh-Hans')).toBe('https://aisubtitle.hdslb.com/zh-Hans.json?auth_key=2');

    const firstUrl = String(fetchMock.mock.calls[0][0]);
    const secondUrl = String(fetchMock.mock.calls[1][0]);
    expect(firstUrl).toContain('/x/web-interface/view');
    expect(firstUrl).toContain(`bvid=${BVID}`);
    expect(secondUrl).toContain('/x/v2/dm/view');
    expect(secondUrl).toContain('oid=111');
    expect(secondUrl).toContain('type=1');
  });

  it('第 2 P 使用对应 cid', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(VIEW_OK))
      .mockResolvedValueOnce(jsonResponse(DM_OK));
    vi.stubGlobal('fetch', fetchMock);

    const { meta } = await createBiliClient().resolveMeta(BVID, 2);
    expect(meta.video.cid).toBe(222);
    expect(meta.video.page).toBe(2);
    expect(String(fetchMock.mock.calls[1][0])).toContain('oid=222');
  });

  it('分 P 超范围报 INVALID_PAGE', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse(VIEW_OK)));
    await expect(createBiliClient().resolveMeta(BVID, 9)).rejects.toMatchObject({
      code: 'INVALID_PAGE',
      status: 400,
    });
  });

  it('fetch 模式 HTTP 412 映射为 BILI_RISK_CONTROL', async () => {
    configureBiliClient('fetch'); // 单元测试环境没有 cloudflare:sockets，显式只用 fetch
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('blocked', { status: 412 })));
    await expect(createBiliClient().resolveMeta(BVID, 1)).rejects.toMatchObject({
      code: 'BILI_RISK_CONTROL',
      status: 502,
    });
    configureBiliClient('auto');
  });

  it('B 站 code=-404 映射为 VIDEO_NOT_FOUND', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(jsonResponse({ code: -404, message: '啥都木有' })),
    );
    await expect(createBiliClient().resolveMeta(BVID, 1)).rejects.toMatchObject({
      code: 'VIDEO_NOT_FOUND',
      status: 404,
    });
  });

  it('没有字幕轨时 tracks 为空', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(VIEW_OK))
        .mockResolvedValueOnce(jsonResponse({ code: 0, data: { subtitle: { subtitles: [] } } })),
    );
    const { meta, urls } = await createBiliClient().resolveMeta(BVID, 1);
    expect(meta.tracks).toEqual([]);
    expect(urls.size).toBe(0);
    expect(meta.default_lan).toBeNull();
  });
});

describe('downloadCues / fetchTrackUrl', () => {
  it('解析 body 为紧凑 cues 并保留 3 位小数', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        jsonResponse({
          body: [
            { from: 0.1234, to: 1.23456, content: '你好' },
            { from: 2, to: 3.5, content: '世界' },
            { from: 'bad', to: 1, content: '跳过' },
          ],
        }),
      ),
    );
    const cues = await createBiliClient().downloadCues('https://aisubtitle.hdslb.com/a.json');
    expect(cues).toEqual([
      [0.123, 1.235, '你好'],
      [2, 3.5, '世界'],
    ]);
  });

  it('字幕链接 403 报 SUBTITLE_EXPIRED', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('forbidden', { status: 403 })));
    await expect(
      createBiliClient().downloadCues('https://aisubtitle.hdslb.com/expired.json'),
    ).rejects.toMatchObject({ code: 'SUBTITLE_EXPIRED', status: 403 });
  });

  it('fetchTrackUrl 从 dm/view 重新取 URL', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse(DM_OK)));
    const url = await createBiliClient().fetchTrackUrl(111, 'en-US');
    expect(url).toBe('https://aisubtitle.hdslb.com/en-US.json?auth_key=3');
  });
});
