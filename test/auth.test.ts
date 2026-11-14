import { describe, expect, it } from 'vitest';

import {
  TOKEN_WINDOW_SECONDS,
  authFailureMessage,
  base64UrlToBytes,
  bytesToBase64Url,
  createToken,
  deriveKey,
  verifyToken,
} from '../src/auth';

const KEY = 'unit-test-passphrase';
const BVID = 'BV1GJ411x7h7';
const NOW = 1794600000;

describe('AES-GCM token', () => {
  it('加密后再校验通过', async () => {
    const token = await createToken(KEY, BVID, NOW);
    const result = await verifyToken(KEY, token, BVID, NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.b).toBe(BVID);
      expect(result.payload.t).toBe(NOW);
    }
  });

  it('时间窗内（±60s）通过，超过 60s 过期', async () => {
    const token = await createToken(KEY, BVID, NOW);
    await expect(verifyToken(KEY, token, BVID, NOW + TOKEN_WINDOW_SECONDS)).resolves.toMatchObject({ ok: true });
    await expect(verifyToken(KEY, token, BVID, NOW - TOKEN_WINDOW_SECONDS)).resolves.toMatchObject({ ok: true });
    await expect(verifyToken(KEY, token, BVID, NOW + TOKEN_WINDOW_SECONDS + 1)).resolves.toMatchObject({
      ok: false,
      reason: 'expired',
    });
  });

  it('密钥错误时解密失败', async () => {
    const token = await createToken(KEY, BVID, NOW);
    await expect(verifyToken('another-key', token, BVID, NOW)).resolves.toMatchObject({
      ok: false,
      reason: 'decrypt',
    });
  });

  it('token 与 bvid 绑定时拒绝不匹配的 bvid', async () => {
    const token = await createToken(KEY, BVID, NOW);
    await expect(verifyToken(KEY, token, 'BV1xx411c7mD', NOW)).resolves.toMatchObject({
      ok: false,
      reason: 'bvid',
    });
  });

  it('被篡改的 token 拒绝', async () => {
    const token = await createToken(KEY, BVID, NOW);
    const tampered = token.slice(0, -2) + (token.endsWith('AA') ? 'BB' : 'AA');
    const result = await verifyToken(KEY, tampered, BVID, NOW);
    expect(result.ok).toBe(false);
  });

  it('格式非法的 token 返回 malformed', async () => {
    for (const bad of ['', 'abc', '!!!', 'a'.repeat(600)]) {
      await expect(verifyToken(KEY, bad, BVID, NOW)).resolves.toMatchObject({
        ok: false,
        reason: 'malformed',
      });
    }
  });

  it('base64url 编解码可逆且不含 +/=/', async () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    const encoded = bytesToBase64Url(bytes);
    expect(encoded).not.toMatch(/[+/=]/);
    expect(Array.from(base64UrlToBytes(encoded))).toEqual(Array.from(bytes));
  });

  it('同一 passphrase 派生出的密钥可互相加解密', async () => {
    const key1 = await deriveKey(KEY);
    const key2 = await deriveKey(KEY);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plain = new TextEncoder().encode('hello');
    const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key1, plain);
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key2, cipher);
    expect(new TextDecoder().decode(decrypted)).toBe('hello');
  });

  it('失败原因都有中文提示', () => {
    for (const reason of ['malformed', 'decrypt', 'bvid', 'expired'] as const) {
      expect(authFailureMessage(reason)).toContain('验签失败');
    }
  });
});
