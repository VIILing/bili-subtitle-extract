/**
 * D1 存储层：字幕缓存 + 视频元信息缓存 + 抓取锁。
 *
 * 为什么用 D1 而不是 KV / DO：
 * - KV 免费额度写入仅 1000 次/天，一次提取就要 2~3 次写，极易超限；
 * - D1 免费额度 10 万行写/天、500 万行读/天、5GB 存储，且部署时 wrangler 可自动创建绑定；
 * - 需要强一致的只有"锁"，D1 单主库 + 单语句原子 UPSERT 就能保证（缓存读到旧值无害）。
 *
 * 缓存键（用户约定的 BVID + 字幕轨名）：
 *   subtitle   : `${bvid}-p${page}-${lan}`   e.g. BV1GJ411x7h7-p1-zh-CN
 *   video_meta : `${bvid}-p${page}-meta`
 *   fetch_lock : 与 subtitle 相同键，expires_at 到期自动失效（120s）
 *
 * 行大小上限 2MB（D1 限制），字幕 cues 一般是几十~几百 KB，正常不会超。
 */

import type { Cue, VideoMeta } from './types';

/** 字幕缓存 1 天 */
export const SUBTITLE_TTL_MS = 24 * 60 * 60 * 1000;
/** 视频元信息缓存 1 天 */
export const META_TTL_MS = 24 * 60 * 60 * 1000;
/** 抓取锁 120 秒（覆盖一次 B 站抓取；Worker 崩溃时靠过期自愈） */
export const LOCK_TTL_MS = 120 * 1000;

export function subtitleCacheKey(bvid: string, page: number, lan: string): string {
  return `${bvid}-p${page}-${lan}`;
}

export function metaCacheKey(bvid: string, page: number): string {
  return `${bvid}-p${page}-meta`;
}

export interface CachedCues {
  cues: Cue[];
  cached_at: number;
}

export interface LockResult {
  acquired: boolean;
  /** 抢锁失败时建议的等待秒数 */
  retry_after_seconds: number;
}

export interface SubtitleStore {
  ensureSchema(): Promise<void>;
  getMeta(key: string): Promise<VideoMeta | null>;
  putMeta(key: string, meta: VideoMeta): Promise<void>;
  getCues(key: string): Promise<CachedCues | null>;
  putCues(key: string, cues: Cue[]): Promise<void>;
  /** 原子抢锁：只有第一个请求能拿到；过期锁可被接管 */
  acquireLock(key: string): Promise<LockResult>;
  releaseLock(key: string): Promise<void>;
  /** 清理过期行，返回删除行数合计（定时任务用） */
  cleanup(): Promise<number>;
}

// 注意：不要用 db.exec() 一次性执行多行 SQL（本地 D1 会按行拆分成多条语句导致
// "incomplete input"）。这里按单条语句逐条 prepare().run()，只在每个 isolate 首次执行。
const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS video_meta (
    cache_key  TEXT PRIMARY KEY,
    payload    TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS subtitle (
    cache_key  TEXT PRIMARY KEY,
    payload    TEXT NOT NULL,
    cached_at  INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS fetch_lock (
    cache_key  TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
  )`,
];

/**
 * D1 实现。
 * 注意：schema 用 CREATE TABLE IF NOT EXISTS 懒初始化（Git 部署无法在构建阶段跑 migration），
 * 每个 isolate 只检查一次，开销可忽略。
 */
export function createD1Store(db: D1Database, now: () => number = Date.now): SubtitleStore {
  let schemaReady: Promise<void> | null = null;

  function ensureSchema(): Promise<void> {
    if (!schemaReady) {
      schemaReady = (async () => {
        const row = await db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'subtitle'")
          .first<{ name: string }>();
        if (!row) {
          for (const statement of SCHEMA_STATEMENTS) await db.prepare(statement).run();
        }
      })().catch((error) => {
        schemaReady = null; // 初始化失败不要永久缓存失败结果
        throw error;
      });
    }
    return schemaReady;
  }

  return {
    ensureSchema,

    async getMeta(key) {
      const row = await db
        .prepare('SELECT payload, expires_at FROM video_meta WHERE cache_key = ?')
        .bind(key)
        .first<{ payload: string; expires_at: number }>();
      if (!row) return null;
      if (Number(row.expires_at) <= now()) {
        await db.prepare('DELETE FROM video_meta WHERE cache_key = ?').bind(key).run();
        return null;
      }
      try {
        return JSON.parse(row.payload) as VideoMeta;
      } catch {
        return null;
      }
    },

    async putMeta(key, meta) {
      await db
        .prepare(
          `INSERT INTO video_meta (cache_key, payload, expires_at) VALUES (?, ?, ?)
           ON CONFLICT(cache_key) DO UPDATE SET payload = excluded.payload, expires_at = excluded.expires_at`,
        )
        .bind(key, JSON.stringify(meta), meta.expires_at)
        .run();
    },

    async getCues(key) {
      const row = await db
        .prepare('SELECT payload, cached_at, expires_at FROM subtitle WHERE cache_key = ?')
        .bind(key)
        .first<{ payload: string; cached_at: number; expires_at: number }>();
      if (!row) return null;
      if (Number(row.expires_at) <= now()) {
        await db.prepare('DELETE FROM subtitle WHERE cache_key = ?').bind(key).run();
        return null;
      }
      try {
        return { cues: JSON.parse(row.payload) as Cue[], cached_at: Number(row.cached_at) };
      } catch {
        return null;
      }
    },

    async putCues(key, cues) {
      const ts = now();
      await db
        .prepare(
          `INSERT INTO subtitle (cache_key, payload, cached_at, expires_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(cache_key) DO UPDATE SET payload = excluded.payload,
             cached_at = excluded.cached_at, expires_at = excluded.expires_at`,
        )
        .bind(key, JSON.stringify(cues), ts, ts + SUBTITLE_TTL_MS)
        .run();
    },

    async acquireLock(key) {
      const ts = now();
      const expiresAt = ts + LOCK_TTL_MS;
      // 单语句原子抢锁：锁不存在 -> 插入；锁已过期 -> 接管；锁未过期 -> 不更新（changes=0）
      const result = await db
        .prepare(
          `INSERT INTO fetch_lock (cache_key, expires_at) VALUES (?, ?)
           ON CONFLICT(cache_key) DO UPDATE SET expires_at = excluded.expires_at
           WHERE fetch_lock.expires_at <= ?`,
        )
        .bind(key, expiresAt, ts)
        .run();

      if (Number(result?.meta?.changes ?? 0) > 0) {
        return { acquired: true, retry_after_seconds: 0 };
      }

      const row = await db
        .prepare('SELECT expires_at FROM fetch_lock WHERE cache_key = ?')
        .bind(key)
        .first<{ expires_at: number }>();
      const retryAfter = row ? Math.max(1, Math.ceil((Number(row.expires_at) - ts) / 1000)) : 2;
      return { acquired: false, retry_after_seconds: retryAfter };
    },

    async releaseLock(key) {
      await db.prepare('DELETE FROM fetch_lock WHERE cache_key = ?').bind(key).run();
    },

    async cleanup() {
      const ts = now();
      let removed = 0;
      for (const table of ['subtitle', 'video_meta', 'fetch_lock']) {
        const result = await db.prepare(`DELETE FROM ${table} WHERE expires_at <= ?`).bind(ts).run();
        removed += Number(result?.meta?.changes ?? 0);
      }
      return removed;
    },
  };
}
