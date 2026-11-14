/**
 * API 层（可注入依赖，方便单测）。
 *
 * 路由：
 *   POST /api/subtitles   提取字幕（AES-GCM 验签 -> D1 缓存 -> 抢锁 -> 抓取 -> 写缓存）
 *   GET  /api/health      B 站连通性探测（用来判断 Cloudflare 出口是否被 412 风控）
 *   OPTIONS *             CORS 预检
 */

import { authFailureMessage, verifyToken } from './auth';
import { pickTrack, probeBili } from './bili';
import type { BiliClient } from './bili';
import { ApiError } from './errors';
import { metaCacheKey, subtitleCacheKey } from './store';
import type { SubtitleStore } from './store';
import type { Cue, TrackInfo, VideoMeta } from './types';

const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization',
  'access-control-max-age': '86400',
};

const JSON_HEADERS: Record<string, string> = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  ...CORS_HEADERS,
};

export interface AppDeps {
  /** Worker Secret：AES_KEY（未配置时 API 直接报错，方便部署后自检） */
  authKey?: string;
  store: SubtitleStore;
  bili: BiliClient;
  now?: () => number;
}

export function jsonResponse(data: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...extraHeaders } });
}

function nowOf(deps: AppDeps): number {
  return (deps.now ?? Date.now)();
}

function timeOf(deps: AppDeps): string {
  return new Date(nowOf(deps)).toISOString();
}

export function normalizeBvid(input: unknown): string {
  if (typeof input !== 'string' || !input.trim()) {
    throw new ApiError(400, 'INVALID_BVID', '请提供 BVID（例如 BV1GJ411x7h7，也支持视频链接）');
  }
  const matched = input.trim().match(/BV[0-9A-Za-z]{10}/);
  if (!matched) {
    throw new ApiError(400, 'INVALID_BVID', '无法识别 BVID（示例：BV1GJ411x7h7）');
  }
  return matched[0];
}

function normalizePage(input: unknown): number {
  if (input === undefined || input === null || input === '') return 1;
  const page = Number(input);
  if (!Number.isInteger(page) || page < 1 || page > 100) {
    throw new ApiError(400, 'INVALID_PAGE', '分 P 必须是 1~100 的整数');
  }
  return page;
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await request.text();
  } catch {
    throw new ApiError(400, 'INVALID_REQUEST', '读取请求体失败');
  }
  if (raw.length > 8192) throw new ApiError(413, 'PAYLOAD_TOO_LARGE', '请求体过大');
  if (!raw) throw new ApiError(400, 'INVALID_REQUEST', '请求体不能为空');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ApiError(400, 'INVALID_REQUEST', '请求体必须是合法的 JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ApiError(400, 'INVALID_REQUEST', '请求体必须是 JSON 对象');
  }
  return parsed as Record<string, unknown>;
}

function extractToken(body: Record<string, unknown>, request: Request): string {
  if (typeof body.token === 'string' && body.token) return body.token;
  const authorization = request.headers.get('authorization') ?? '';
  const bearer = authorization.replace(/^Bearer\s+/i, '').trim();
  if (bearer) return bearer;
  throw new ApiError(401, 'AUTH_FAILED', '缺少 token（AES 加密的 BVID+时间）');
}

interface SubtitleData {
  video: VideoMeta['video'];
  tracks: TrackInfo[];
  track: TrackInfo;
  cues: Cue[];
  cue_count: number;
  cached_at?: number;
}

function buildData(meta: VideoMeta, track: TrackInfo, cues: Cue[], cachedAt?: number): SubtitleData {
  const data: SubtitleData = {
    video: meta.video,
    tracks: meta.tracks,
    track,
    cues,
    cue_count: cues.length,
  };
  if (cachedAt !== undefined) data.cached_at = cachedAt;
  return data;
}

async function handleSubtitles(request: Request, deps: AppDeps): Promise<Response> {
  const nowMs = nowOf(deps);
  const nowSec = Math.floor(nowMs / 1000);

  if (!deps.authKey) {
    throw new ApiError(
      500,
      'SERVER_NOT_CONFIGURED',
      '服务端未配置 AES_KEY。请在 Cloudflare 控制台 Workers -> 该 Worker -> Settings -> Variables and Secrets 添加 Secret：AES_KEY',
    );
  }

  const body = await readJsonBody(request);
  const bvid = normalizeBvid(body.bvid);
  const page = normalizePage(body.page);
  const requestedLang = typeof body.lang === 'string' ? body.lang.trim() : '';
  const token = extractToken(body, request);

  const verified = await verifyToken(deps.authKey, token, bvid, nowSec);
  if (!verified.ok) throw new ApiError(401, 'AUTH_FAILED', authFailureMessage(verified.reason));

  await deps.store.ensureSchema();

  // 1) 视频元信息（含字幕轨列表）：D1 命中则完全跳过 view / dm/view
  const metaKey = metaCacheKey(bvid, page);
  let meta = await deps.store.getMeta(metaKey);
  let freshUrls: Map<string, string> | null = null;
  if (!meta) {
    const resolved = await deps.bili.resolveMeta(bvid, page);
    meta = resolved.meta;
    freshUrls = resolved.urls;
    await deps.store.putMeta(metaKey, meta);
  }

  // 2) 没有字幕轨：返回 200 + empty，让网页提示而不是报错
  if (!meta.tracks.length) {
    return jsonResponse({
      ok: true,
      cached: false,
      empty: true,
      server_time: timeOf(deps),
      message: '该视频没有外挂字幕轨（CC 字幕 / AI 字幕）',
      data: { video: meta.video, tracks: [], track: null, cues: [], cue_count: 0 },
    });
  }

  // 3) 选轨 + 查字幕缓存（键 = BVID + 分P + 轨道名）
  const track = pickTrack(meta.tracks, requestedLang);
  const cacheKey = subtitleCacheKey(bvid, page, track.lan);
  const cached = await deps.store.getCues(cacheKey);
  if (cached) {
    return jsonResponse({
      ok: true,
      cached: true,
      server_time: timeOf(deps),
      cache_key: cacheKey,
      data: buildData(meta, track, cached.cues, cached.cached_at),
    });
  }

  // 4) 抢锁：D1 单语句原子 UPSERT，抢不到说明别的请求正在抓
  const lock = await deps.store.acquireLock(cacheKey);
  if (!lock.acquired) {
    return jsonResponse(
      {
        ok: false,
        code: 'CACHING',
        message: '该字幕正在抓取中，请稍后再试',
        retry_after_seconds: lock.retry_after_seconds,
        server_time: timeOf(deps),
      },
      429,
      { 'retry-after': String(lock.retry_after_seconds) },
    );
  }

  try {
    let url = freshUrls?.get(track.lan);
    let cues: Cue[];
    try {
      if (!url) url = await deps.bili.fetchTrackUrl(meta.video.cid, track.lan);
      cues = await deps.bili.downloadCues(url);
    } catch (error) {
      // auth_key 可能在元信息缓存期间过期：重新取一次 URL 再试
      if (error instanceof ApiError && error.code === 'SUBTITLE_EXPIRED') {
        const fresh = await deps.bili.fetchTrackUrl(meta.video.cid, track.lan);
        cues = await deps.bili.downloadCues(fresh);
      } else {
        throw error;
      }
    }

    await deps.store.putCues(cacheKey, cues);
    return jsonResponse({
      ok: true,
      cached: false,
      server_time: timeOf(deps),
      cache_key: cacheKey,
      data: buildData(meta, track, cues),
    });
  } finally {
    // 失败也要释放锁；释放失败就等 120s 自动过期
    try {
      await deps.store.releaseLock(cacheKey);
    } catch (error) {
      console.warn('[subtitles] 释放锁失败', error);
    }
  }
}

async function handleHealth(deps: AppDeps, request: Request): Promise<Response> {
  const bilibili = await deps.bili.health();
  const params = new URL(request.url).searchParams;
  const payload: Record<string, unknown> = {
    ok: true,
    server_time: timeOf(deps),
    config: { aes_key_configured: Boolean(deps.authKey) },
    bilibili,
  };

  // 诊断模式：GET /api/health?probe=1&bvid=BV...&cid=...
  if (params.get('probe')) {
    const bvidParam = params.get('bvid') ?? 'BV1GJ411x7h7';
    const cidParam = Number(params.get('cid') ?? 0);
    const bvid = bvidParam.match(/BV[0-9A-Za-z]{10}/)?.[0] ?? 'BV1GJ411x7h7';
    payload.probe = await probeBili(bvid, Number.isFinite(cidParam) && cidParam > 0 ? cidParam : undefined);
  }

  return jsonResponse(payload);
}

/** API 总入口（index.ts 只负责路由到 /api/*） */
export async function handleApi(request: Request, deps: AppDeps): Promise<Response> {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const path = new URL(request.url).pathname;

  try {
    if (path === '/api/subtitles' && request.method === 'POST') {
      return await handleSubtitles(request, deps);
    }
    if (path === '/api/health' && request.method === 'GET') {
      return await handleHealth(deps, request);
    }
    return jsonResponse({ ok: false, code: 'NOT_FOUND', message: '接口不存在', server_time: timeOf(deps) }, 404);
  } catch (error) {
    if (error instanceof ApiError) {
      return jsonResponse(
        {
          ok: false,
          code: error.code,
          message: error.message,
          details: error.details,
          server_time: timeOf(deps),
        },
        error.status,
      );
    }
    console.error('[api] 未捕获异常', error);
    return jsonResponse(
      { ok: false, code: 'INTERNAL', message: '服务器内部错误', server_time: timeOf(deps) },
      500,
    );
  }
}
