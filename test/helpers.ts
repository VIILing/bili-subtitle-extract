/**
 * 单测公共工具：内存版 Store + 假 BiliClient + Request 构造器。
 * 只用于 test/，不会被 Wrangler 打包。
 */

import type { BiliClient, ResolvedMeta } from '../src/bili';
import { LOCK_TTL_MS, META_TTL_MS } from '../src/store';
import type { CachedCues, LockResult, SubtitleStore } from '../src/store';
import type { Cue, TrackInfo, VideoMeta } from '../src/types';

export const TEST_KEY = 'unit-test-passphrase';
export const TEST_BVID = 'BV1GJ411x7h7';

const DEFAULT_TRACKS: TrackInfo[] = [
  { lan: 'zh-Hans', lan_doc: '中文（简体）', is_ai: false },
  { lan: 'en-US', lan_doc: 'English', is_ai: false },
];

export function makeMeta(overrides: Partial<VideoMeta> = {}): VideoMeta {
  const now = Date.now();
  const tracks = overrides.tracks ?? DEFAULT_TRACKS;
  return {
    v: 1,
    video: {
      bvid: TEST_BVID,
      aid: 80433022,
      title: '测试视频',
      owner_name: 'UP 主',
      owner_mid: 1,
      duration: 100,
      cover: '',
      pubdate: 0,
      page: 1,
      page_count: 1,
      cid: 137649199,
      pages: [{ page: 1, part: 'P1', duration: 100 }],
    },
    tracks,
    default_lan: tracks[0]?.lan ?? null,
    fetched_at: now,
    expires_at: now + META_TTL_MS,
    ...overrides,
  };
}

export function makeResolvedMeta(meta: VideoMeta = makeMeta()): ResolvedMeta {
  const urls = new Map<string, string>(
    meta.tracks.map((track) => [track.lan, `https://aisubtitle.hdslb.com/${track.lan}.json?auth_key=1`]),
  );
  return { meta, urls };
}

export class FakeStore implements SubtitleStore {
  readonly metas = new Map<string, VideoMeta>();
  readonly cues = new Map<string, CachedCues>();
  readonly locks = new Map<string, number>();
  readonly calls: string[] = [];

  constructor(readonly now: () => number = Date.now) {}

  async ensureSchema(): Promise<void> {
    this.calls.push('ensureSchema');
  }

  async getMeta(key: string): Promise<VideoMeta | null> {
    this.calls.push('getMeta');
    const meta = this.metas.get(key);
    if (!meta) return null;
    if (meta.expires_at <= this.now()) {
      this.metas.delete(key);
      return null;
    }
    return meta;
  }

  async putMeta(key: string, meta: VideoMeta): Promise<void> {
    this.calls.push('putMeta');
    this.metas.set(key, meta);
  }

  async getCues(key: string): Promise<CachedCues | null> {
    this.calls.push('getCues');
    return this.cues.get(key) ?? null;
  }

  async putCues(key: string, cues: Cue[]): Promise<void> {
    this.calls.push('putCues');
    this.cues.set(key, { cues, cached_at: this.now() });
  }

  async acquireLock(key: string): Promise<LockResult> {
    this.calls.push('acquireLock');
    const ts = this.now();
    const expiresAt = this.locks.get(key);
    if (expiresAt !== undefined && expiresAt > ts) {
      return { acquired: false, retry_after_seconds: Math.max(1, Math.ceil((expiresAt - ts) / 1000)) };
    }
    this.locks.set(key, ts + LOCK_TTL_MS);
    return { acquired: true, retry_after_seconds: 0 };
  }

  async releaseLock(key: string): Promise<void> {
    this.calls.push('releaseLock');
    this.locks.delete(key);
  }

  async cleanup(): Promise<number> {
    this.calls.push('cleanup');
    return 0;
  }
}

export function makeBili(overrides: Partial<BiliClient> = {}): BiliClient & { calls: string[] } {
  const calls: string[] = [];
  const bili = {
    calls,
    async resolveMeta(bvid: string, page: number): Promise<ResolvedMeta> {
      calls.push('resolveMeta');
      if (overrides.resolveMeta) return overrides.resolveMeta(bvid, page);
      const meta = makeMeta();
      meta.video.bvid = bvid;
      meta.video.page = page;
      return makeResolvedMeta(meta);
    },
    async fetchTrackUrl(cid: number, lan: string): Promise<string> {
      calls.push(`fetchTrackUrl:${lan}`);
      if (overrides.fetchTrackUrl) return overrides.fetchTrackUrl(cid, lan);
      return `https://aisubtitle.hdslb.com/refreshed-${lan}.json?auth_key=2`;
    },
    async downloadCues(url: string): Promise<Cue[]> {
      calls.push('downloadCues');
      if (overrides.downloadCues) return overrides.downloadCues(url);
      return [[0.12, 5.12, '你好']];
    },
    async health() {
      calls.push('health');
      if (overrides.health) return overrides.health();
      return { ok: true, http_status: 200, code: -101, message: '', ms: 1 };
    },
  };
  return bili as BiliClient & { calls: string[] };
}

export function makeRequest(path: string, body?: unknown, method = 'POST'): Request {
  return new Request(`https://example.com${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
