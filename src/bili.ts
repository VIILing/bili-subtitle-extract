/**
 * B 站字幕抓取（匿名、无 Cookie、无 WBI 签名）。
 *
 * 只用到 3 个请求（详见 bili-toolkit 的实测结论）：
 *   1. GET x/web-interface/view?bvid=...        -> aid / 标题 / 分 P 列表（cid 在其中）
 *   2. GET x/v2/dm/view?oid=<cid>&type=1        -> 字幕轨列表（含限时 subtitle_url）
 *   3. GET <subtitle_url>                       -> 字幕 JSON（body: [{from,to,content}, ...]）
 *
 * 注意：
 * - subtitle_url 返回的是 http:// 协议且带 auth_key（限时签名），必须升级到 https 且现取现用；
 * - 不要把带 auth_key 的 URL 写进 D1 缓存；缓存只存轨道元信息，下载时重新取 URL。
 */

import { ApiError, biliCodeError } from './errors';
import type { BiliHealth, Cue, TrackInfo, VideoInfo, VideoMeta } from './types';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const COMMON_HEADERS: Record<string, string> = {
  'User-Agent': USER_AGENT,
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  Referer: 'https://www.bilibili.com/',
};

const VIEW_URL = 'https://api.bilibili.com/x/web-interface/view';
const DM_VIEW_URL = 'https://api.bilibili.com/x/v2/dm/view';
const NAV_URL = 'https://api.bilibili.com/x/web-interface/nav';

/** 默认轨道优先级：人工中文字幕 > AI 中文字幕 > 英文 > 其它 */
export const PREFERRED_LANGS = [
  'zh-Hans',
  'zh-CN',
  'zh',
  'zh-Hant',
  'zh-HK',
  'ai-zh',
  'en-US',
  'en',
  'ai-en',
];

/** 语言别名：网页端传 `zh` / `en` 这类简称时也能命中真实轨道（lan 如 zh-CN / en-US） */
const LANG_ALIASES: Record<string, string[]> = {
  zh: ['zh-Hans', 'zh-CN', 'zh', 'zh-Hant', 'zh-HK', 'ai-zh'],
  cn: ['zh-Hans', 'zh-CN'],
  en: ['en-US', 'en', 'ai-en'],
  ja: ['ja', 'ai-ja'],
  jp: ['ja', 'ai-ja'],
  ko: ['ko', 'ai-ko'],
};

/** 缓存里只保存这些字段，不保存 subtitle_url */
export const META_TTL_MS = 24 * 60 * 60 * 1000;

export interface ResolvedMeta {
  meta: VideoMeta;
  /** lan -> 字幕 JSON 的 https URL（只在本请求内存中使用） */
  urls: Map<string, string>;
}

export interface BiliClient {
  resolveMeta(bvid: string, page: number): Promise<ResolvedMeta>;
  fetchTrackUrl(cid: number, lan: string): Promise<string>;
  downloadCues(url: string): Promise<Cue[]>;
  health(): Promise<BiliHealth>;
}

/** `http://` / `//` 统一升级到 https（实测 https 可正常下载） */
export function normalizeSubtitleUrl(url: string): string {
  if (!url) return '';
  if (url.startsWith('//')) return `https:${url}`;
  if (url.startsWith('http://')) return `https://${url.slice('http://'.length)}`;
  return url;
}

interface BiliResponse<T> {
  code: number;
  message?: string;
  data: T;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') {
      throw new ApiError(504, 'BILI_TIMEOUT', `请求 B 站超时（${timeoutMs}ms）`);
    }
    throw new ApiError(502, 'BILI_NETWORK', `无法连接 B 站：${(error as Error)?.message ?? '网络错误'}`);
  } finally {
    clearTimeout(timer);
  }
}

/** GET 一个 B 站 JSON 接口，返回 data；code 非白名单时抛 ApiError */
async function biliGet<T>(
  url: string,
  params: Record<string, string | number> | undefined,
  allowCodes: number[] = [0],
): Promise<T> {
  const target = new URL(url);
  if (params) {
    for (const [key, value] of Object.entries(params)) target.searchParams.set(key, String(value));
  }

  const response = await fetchWithTimeout(target.toString(), { headers: COMMON_HEADERS, redirect: 'follow' }, 15000);
  if (response.status === 412) {
    throw new ApiError(
      502,
      'BILI_RISK_CONTROL',
      'B 站风控拦截（HTTP 412）。Cloudflare 出口 IP 可能被 B 站限制，可在 /api/health 查看详情。',
    );
  }
  if (!response.ok) {
    throw new ApiError(502, 'BILI_HTTP', `B 站接口返回 HTTP ${response.status}`);
  }

  let payload: BiliResponse<T>;
  try {
    payload = (await response.json()) as BiliResponse<T>;
  } catch {
    throw new ApiError(502, 'BILI_PARSE', 'B 站接口返回的不是 JSON（可能被风控或接口已变更）');
  }

  const code = Number(payload?.code);
  if (!allowCodes.includes(code)) throw biliCodeError(code, payload?.message);
  return payload.data;
}

function pickDefaultLan(tracks: TrackInfo[]): string | null {
  for (const wanted of PREFERRED_LANGS) {
    const found = tracks.find((track) => track.lan === wanted);
    if (found) return found.lan;
  }
  return tracks[0]?.lan ?? null;
}

/** 按请求的 lang 选一条轨道；lang=auto 时按 PREFERRED_LANGS 优先 */
export function pickTrack(tracks: TrackInfo[], requested: string): TrackInfo {
  if (!tracks.length) {
    throw new ApiError(404, 'NO_SUBTITLE_TRACK', '该视频没有外挂字幕轨（CC 字幕 / AI 字幕）');
  }

  const lang = (requested || 'auto').trim();
  if (lang === 'auto' || !lang) {
    const defaultLan = pickDefaultLan(tracks);
    return tracks.find((track) => track.lan === defaultLan) ?? tracks[0];
  }

  const lower = lang.toLowerCase();
  const exact = tracks.find((track) => track.lan.toLowerCase() === lower);
  if (exact) return exact;

  for (const candidate of LANG_ALIASES[lower] ?? []) {
    const matched = tracks.find((track) => track.lan === candidate);
    if (matched) return matched;
  }

  // 前缀兜底：zh-Hans-CN 这类变体
  const prefix = tracks.find((track) => track.lan.toLowerCase().startsWith(lower));
  if (prefix) return prefix;

  throw new ApiError(
    400,
    'TRACK_NOT_FOUND',
    `没有找到语言为「${lang}」的字幕轨，可用：${tracks.map((track) => track.lan).join(', ')}`,
    { available: tracks.map((track) => ({ lan: track.lan, lan_doc: track.lan_doc })) },
  );
}

/** 解析 BVID -> 视频信息 + 字幕轨列表（不写缓存，缓存由 store 层负责） */
async function resolveMeta(bvid: string, page: number): Promise<ResolvedMeta> {
  const view = await biliGet<{
    bvid?: string;
    aid?: number;
    title?: string;
    pic?: string;
    duration?: number;
    pubdate?: number;
    cid?: number;
    owner?: { mid?: number; name?: string };
    pages?: Array<{ cid?: number; page?: number; part?: string; duration?: number }>;
  }>(VIEW_URL, { bvid });

  const allPages = Array.isArray(view?.pages) ? view.pages : [];
  if (!allPages.length) {
    throw new ApiError(404, 'VIDEO_NOT_FOUND', '视频不存在或没有可用的分 P');
  }
  if (!Number.isInteger(page) || page < 1 || page > allPages.length) {
    throw new ApiError(400, 'INVALID_PAGE', `分 P 超出范围（该视频共 ${allPages.length} P）`);
  }

  const current = allPages[page - 1];
  const cid = Number(current?.cid ?? view?.cid);
  if (!cid) {
    throw new ApiError(502, 'BILI_ERROR', 'B 站返回的视频信息缺少 cid');
  }

  const dm = await biliGet<{ subtitle?: { subtitles?: Array<Record<string, unknown>> } }>(DM_VIEW_URL, {
    oid: cid,
    type: 1,
  });

  const rawTracks = Array.isArray(dm?.subtitle?.subtitles) ? dm.subtitle!.subtitles! : [];
  const tracks: TrackInfo[] = [];
  const urls = new Map<string, string>();
  for (const raw of rawTracks) {
    const lan = String(raw?.lan ?? '');
    if (!lan) continue;
    if (urls.has(lan)) continue; // 去重，保留第一条
    const url = normalizeSubtitleUrl(String(raw?.subtitle_url ?? ''));
    if (!url) continue;
    tracks.push({
      lan,
      lan_doc: String(raw?.lan_doc ?? ''),
      is_ai: Number(raw?.ai_status ?? 0) > 0 || lan.startsWith('ai-'),
    });
    urls.set(lan, url);
  }

  const now = Date.now();
  const pages = allPages.slice(0, 100).map((item, index) => ({
    page: Number(item?.page ?? index + 1),
    part: String(item?.part ?? ''),
    duration: Number(item?.duration ?? 0),
  }));

  const video: VideoInfo = {
    bvid: String(view?.bvid ?? bvid),
    aid: Number(view?.aid ?? 0),
    title: String(view?.title ?? ''),
    owner_name: String(view?.owner?.name ?? ''),
    owner_mid: Number(view?.owner?.mid ?? 0),
    duration: Number(view?.duration ?? 0),
    cover: String(view?.pic ?? ''),
    pubdate: Number(view?.pubdate ?? 0),
    page,
    page_count: allPages.length,
    cid,
    pages,
  };

  return {
    meta: {
      v: 1,
      video,
      tracks,
      default_lan: pickDefaultLan(tracks),
      fetched_at: now,
      expires_at: now + META_TTL_MS,
    },
    urls,
  };
}

/** 重新取某个轨道的限时下载 URL（缓存里没有 URL，缓存命中后换轨/重试时用） */
async function fetchTrackUrl(cid: number, lan: string): Promise<string> {
  const dm = await biliGet<{ subtitle?: { subtitles?: Array<Record<string, unknown>> } }>(DM_VIEW_URL, {
    oid: cid,
    type: 1,
  });
  const rawTracks = Array.isArray(dm?.subtitle?.subtitles) ? dm.subtitle!.subtitles! : [];
  const matched =
    rawTracks.find((raw) => String(raw?.lan ?? '') === lan) ??
    rawTracks.find((raw) => String(raw?.lan ?? '').toLowerCase() === lan.toLowerCase());

  const url = normalizeSubtitleUrl(String(matched?.subtitle_url ?? ''));
  if (!url) {
    throw new ApiError(404, 'TRACK_NOT_FOUND', `重新获取字幕轨 ${lan} 失败（轨道可能已被移除）`);
  }
  return url;
}

/** 下载并解析一条字幕 JSON，返回紧凑 cues */
async function downloadCues(url: string): Promise<Cue[]> {
  const response = await fetchWithTimeout(url, { headers: COMMON_HEADERS, redirect: 'follow' }, 20000);
  if (response.status === 403) {
    throw new ApiError(403, 'SUBTITLE_EXPIRED', '字幕链接已过期（auth_key 失效），需要重新获取');
  }
  if (!response.ok) {
    throw new ApiError(502, 'SUBTITLE_HTTP', `字幕文件下载失败：HTTP ${response.status}`);
  }

  let payload: { body?: Array<Record<string, unknown>> };
  try {
    payload = (await response.json()) as { body?: Array<Record<string, unknown>> };
  } catch {
    throw new ApiError(502, 'SUBTITLE_PARSE', '字幕文件不是合法 JSON（auth_key 可能失效）');
  }

  const body = Array.isArray(payload?.body) ? payload.body : [];
  const cues: Cue[] = [];
  for (const item of body) {
    const from = Number(item?.from);
    const to = Number(item?.to);
    const content = String(item?.content ?? '');
    if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
    cues.push([Math.round(from * 1000) / 1000, Math.round(to * 1000) / 1000, content]);
  }
  return cues;
}

/** 探测 B 站连通性（nav 接口匿名访问返回 -101，只要不是 412 就算通） */
async function health(): Promise<BiliHealth> {
  const started = Date.now();
  try {
    const response = await fetchWithTimeout(NAV_URL, { headers: COMMON_HEADERS, redirect: 'follow' }, 10000);
    let code: number | null = null;
    let message = '';
    try {
      const payload = (await response.json()) as { code?: number; message?: string };
      code = Number(payload?.code);
      message = String(payload?.message ?? '');
    } catch {
      message = '响应不是 JSON';
    }
    return {
      ok: response.status === 200 && (code === 0 || code === -101),
      http_status: response.status,
      code,
      message,
      ms: Date.now() - started,
    };
  } catch (error) {
    return {
      ok: false,
      http_status: 0,
      code: null,
      message: (error as Error)?.message ?? '网络错误',
      ms: Date.now() - started,
    };
  }
}

/** 生产环境实现：使用全局 fetch（Worker / Node 18+ 均可） */
export function createBiliClient(): BiliClient {
  return { resolveMeta, fetchTrackUrl, downloadCues, health };
}
