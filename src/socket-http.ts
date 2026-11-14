/**
 * 极简 HTTPS 客户端：用 cloudflare:sockets 直接建立 TLS 连接，自行拼 HTTP/1.1 请求。
 *
 * 为什么需要它：Cloudflare Worker 用 fetch() 出站时，CF 会强制附加 `cf-connecting-ip`、
 * `cf-ipcountry`、`cf-worker` 等请求头，B 站 WAF 会因此返回 HTTP 412。走原始 TCP + TLS
 * 时这些头完全由我们自己控制，可以绕过该问题（api.bilibili.com 不解析 CF 专有头）。
 *
 * 支持：GET、重定向、Content-Length / chunked、gzip/deflate 解压、超时、大小上限。
 */

import { connect } from 'cloudflare:sockets';

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_REDIRECTS = 3;

export interface SimpleHttpResponse {
  status: number;
  headers: Record<string, string>;
  text: string;
}

function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function findHeaderEnd(bytes: Uint8Array): number {
  for (let i = 0; i + 3 < bytes.length; i += 1) {
    if (bytes[i] === 13 && bytes[i + 1] === 10 && bytes[i + 2] === 13 && bytes[i + 3] === 10) return i;
  }
  return -1;
}

function findCrlf(bytes: Uint8Array, start: number): number {
  for (let i = start; i + 1 < bytes.length; i += 1) {
    if (bytes[i] === 13 && bytes[i + 1] === 10) return i;
  }
  return -1;
}

function decodeChunked(body: Uint8Array): Uint8Array {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  while (offset < body.length) {
    const lineEnd = findCrlf(body, offset);
    if (lineEnd < 0) break;
    const sizeLine = new TextDecoder().decode(body.subarray(offset, lineEnd)).split(';')[0].trim();
    const size = Number.parseInt(sizeLine, 16);
    if (!Number.isFinite(size) || size <= 0) break;
    const dataStart = lineEnd + 2;
    const dataEnd = Math.min(dataStart + size, body.length);
    chunks.push(body.subarray(dataStart, dataEnd));
    offset = dataEnd + 2; // 跳过数据后的 CRLF
  }
  return concatChunks(chunks, chunks.reduce((sum, chunk) => sum + chunk.length, 0));
}

async function decompress(bytes: Uint8Array, encoding: string | undefined): Promise<Uint8Array> {
  if (!encoding) return bytes;
  const value = encoding.toLowerCase();
  const candidates: Array<'gzip' | 'deflate'> = [];
  if (value.includes('gzip')) candidates.push('gzip');
  else if (value.includes('deflate')) candidates.push('deflate', 'gzip');

  for (const format of candidates) {
    try {
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch {
      // 尝试下一种解压格式
    }
  }
  return bytes;
}

function encodeRequest(url: URL, headers: Record<string, string>): Uint8Array {
  const host = url.port ? `${url.hostname}:${url.port}` : url.hostname;
  const lines = [`GET ${url.pathname}${url.search} HTTP/1.1`, `Host: ${host}`];
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (lower === 'host' || lower === 'connection') continue;
    lines.push(`${key}: ${value}`);
  }
  lines.push('Connection: close', '', '');
  return new TextEncoder().encode(lines.join('\r\n'));
}

function parseResponse(bytes: Uint8Array): { status: number; headers: Record<string, string>; body: Uint8Array } {
  const headerEnd = findHeaderEnd(bytes);
  if (headerEnd < 0) throw new Error('响应头不完整');

  const headerText = new TextDecoder().decode(bytes.subarray(0, headerEnd));
  const lines = headerText.split('\r\n');
  const statusMatch = lines[0]?.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/);
  if (!statusMatch) throw new Error(`无法解析状态行：${lines[0] ?? ''}`);

  const headers: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const index = line.indexOf(':');
    if (index > 0) headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
  }

  let body = bytes.subarray(headerEnd + 4);
  const transferEncoding = (headers['transfer-encoding'] ?? '').toLowerCase();
  if (transferEncoding.includes('chunked')) {
    body = decodeChunked(body);
  } else if (headers['content-length']) {
    const length = Number.parseInt(headers['content-length'], 10);
    if (Number.isFinite(length) && length >= 0 && length < body.length) body = body.subarray(0, length);
  }

  return { status: Number(statusMatch[1]), headers, body };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(new Error(`TCP/TLS 请求超时（${timeoutMs}ms）`));
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

async function socketGetOnce(url: URL, headers: Record<string, string>, timeoutMs: number): Promise<{
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}> {
  const isTls = url.protocol === 'https:';
  const port = url.port ? Number(url.port) : isTls ? 443 : 80;
  const socket = connect(
    { hostname: url.hostname, port },
    { secureTransport: isTls ? 'on' : 'off', allowHalfOpen: true },
  );

  try {
    await socket.opened;
    const writer = socket.writable.getWriter();
    await writer.write(encodeRequest(url, headers));

    const reader = socket.readable.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;

    const readAll = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          chunks.push(value);
          total += value.length;
          if (total > MAX_BODY_BYTES) throw new Error('响应体过大');
        }
      }
    })();

    await withTimeout(readAll, timeoutMs, () => {
      try {
        socket.close();
      } catch {
        /* ignore */
      }
    });

    try {
      reader.releaseLock();
      writer.releaseLock();
    } catch {
      /* ignore */
    }
    socket.close();

    return parseResponse(concatChunks(chunks, total));
  } catch (error) {
    try {
      socket.close();
    } catch {
      /* ignore */
    }
    throw error;
  }
}

/** 用原始 TCP/TLS 发送一个 GET 请求，自动跟随重定向并解码文本 */
export async function socketHttpGet(
  target: string,
  headers: Record<string, string>,
  timeoutMs = 15000,
): Promise<SimpleHttpResponse> {
  let url = new URL(target);

  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const raw = await socketGetOnce(url, headers, timeoutMs);
    const location = raw.headers['location'];
    if (location && [301, 302, 303, 307, 308].includes(raw.status)) {
      url = new URL(location, url);
      continue;
    }
    const body = await decompress(raw.body, raw.headers['content-encoding']);
    return { status: raw.status, headers: raw.headers, text: new TextDecoder().decode(body) };
  }

  throw new Error('重定向次数过多');
}
