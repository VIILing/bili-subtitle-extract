/**
 * 全局共享类型。
 *
 * 说明：本项目不使用 Durable Objects / KV，只用 D1 存缓存 + 锁（见 src/store.ts）。
 */

/** 一条字幕 cue：`[起始秒, 结束秒, 文本]`（秒保留 3 位小数） */
export type Cue = [number, number, string];

/** 一条字幕轨的元信息（不含带 auth_key 的下载 URL） */
export interface TrackInfo {
  lan: string;
  lan_doc: string;
  is_ai: boolean;
}

export interface VideoPage {
  page: number;
  part: string;
  duration: number;
}

export interface VideoInfo {
  bvid: string;
  aid: number;
  title: string;
  owner_name: string;
  owner_mid: number;
  duration: number;
  cover: string;
  pubdate: number;
  /** 本次请求的分 P 序号（从 1 开始） */
  page: number;
  /** 总分 P 数 */
  page_count: number;
  /** 本次请求分 P 的 cid（字幕接口用 cid，不是 aid） */
  cid: number;
  /** 最多保留前 100 个分 P 的简要信息 */
  pages: VideoPage[];
}

/** 存进 D1 video_meta 表的视频元信息缓存 */
export interface VideoMeta {
  v: 1;
  video: VideoInfo;
  tracks: TrackInfo[];
  /** 请求 lang=auto 时默认选中的轨道 */
  default_lan: string | null;
  fetched_at: number;
  expires_at: number;
}

/** B 站连通性探测结果（用于 /api/health） */
export interface BiliHealth {
  ok: boolean;
  http_status: number;
  code: number | null;
  message: string;
  ms: number;
}

/** Cloudflare Worker 绑定 */
export interface Env {
  /** D1 数据库（wrangler.jsonc 中 binding=DB，部署时自动创建） */
  DB: D1Database;
  /** 静态资源绑定（public/ 目录） */
  ASSETS: Fetcher;
  /** 共享口令：网页端输入，Worker 侧用同一个值派生 AES 密钥（Cloudflare Secret，不要入库） */
  AES_KEY?: string;
}
