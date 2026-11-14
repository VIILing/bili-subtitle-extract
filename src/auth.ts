/**
 * AES-GCM + 时间戳 鉴权（网页端与 Worker 共用同一套算法）。
 *
 * 设计：
 *   key       = SHA-256(UTF-8(口令))                -> AES-256-GCM
 *   iv        = 随机 12 字节
 *   plaintext = JSON {"b":"BV...","t":<unix 秒>}
 *   token     = base64url(iv || ciphertext)          （GCM 密文自带 16 字节 tag）
 *
 * 校验：
 *   1. 能解密（否则 key 不对 / token 被篡改）
 *   2. 明文里的 b 与请求的 bvid 一致
 *   3. |now - t| <= 60 秒
 *
 * 说明：加密算法在浏览器（public/app.js）里有一份等价的实现，两边必须保持同步；
 * 测试见 test/auth.test.ts。
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** 时间窗：请求时间戳与服务器时间相差超过 60 秒即视为过期 */
export const TOKEN_WINDOW_SECONDS = 60;

const IV_BYTES = 12;
const MAX_TOKEN_LENGTH = 512;

export interface TokenPayload {
  /** bvid */
  b: string;
  /** unix 秒 */
  t: number;
}

export type VerifyResult =
  | { ok: true; payload: TokenPayload }
  | { ok: false; reason: 'malformed' | 'decrypt' | 'bvid' | 'expired' };

/** 用口令派生 AES-256-GCM 密钥 */
export async function deriveKey(passphrase: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(passphrase));
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlToBytes(text: string): Uint8Array {
  const normalized = text.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** 生成 token（Worker 的测试 / 本地调试脚本用；浏览器端在 public/app.js 里实现） */
export async function createToken(
  passphrase: string,
  bvid: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<string> {
  const key = await deriveKey(passphrase);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const payload = encoder.encode(JSON.stringify({ b: bvid, t: nowSeconds } satisfies TokenPayload));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, payload));
  const combined = new Uint8Array(iv.length + cipher.length);
  combined.set(iv, 0);
  combined.set(cipher, iv.length);
  return bytesToBase64Url(combined);
}

/** 校验 token（解密 + bvid 绑定 + 60 秒时间窗） */
export async function verifyToken(
  passphrase: string,
  token: string,
  bvid: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<VerifyResult> {
  if (!token || token.length > MAX_TOKEN_LENGTH) return { ok: false, reason: 'malformed' };

  let raw: Uint8Array;
  try {
    raw = base64UrlToBytes(token);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (raw.length <= IV_BYTES) return { ok: false, reason: 'malformed' };

  const iv = raw.subarray(0, IV_BYTES);
  const cipher = raw.subarray(IV_BYTES);
  const key = await deriveKey(passphrase);

  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher);
  } catch {
    return { ok: false, reason: 'decrypt' };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(decoder.decode(plain));
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  if (
    typeof payload !== 'object' ||
    payload === null ||
    typeof (payload as TokenPayload).b !== 'string' ||
    typeof (payload as TokenPayload).t !== 'number' ||
    !Number.isFinite((payload as TokenPayload).t)
  ) {
    return { ok: false, reason: 'malformed' };
  }

  const parsed = payload as TokenPayload;
  if (parsed.b !== bvid) return { ok: false, reason: 'bvid' };
  if (Math.abs(nowSeconds - parsed.t) > TOKEN_WINDOW_SECONDS) return { ok: false, reason: 'expired' };

  return { ok: true, payload: parsed };
}

/** 把校验失败原因翻译成用户能看懂的中文提示 */
export function authFailureMessage(reason: 'malformed' | 'decrypt' | 'bvid' | 'expired'): string {
  switch (reason) {
    case 'decrypt':
      return '验签失败：AES 密钥不正确';
    case 'bvid':
      return '验签失败：token 与请求的 BVID 不匹配';
    case 'expired':
      return `验签失败：请求已过期（时间窗 ${TOKEN_WINDOW_SECONDS} 秒），请检查本机时间是否准确`;
    default:
      return '验签失败：token 格式不正确';
  }
}
