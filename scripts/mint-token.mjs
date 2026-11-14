#!/usr/bin/env node
/**
 * 本地调试用：生成一个 AES-GCM token（算法与 src/auth.ts、public/app.js 完全一致）。
 *
 * 用法：
 *   node scripts/mint-token.mjs <AES_KEY> [BVID] [时间偏移秒数]
 *
 * 示例：
 *   node scripts/mint-token.mjs dev_temp_key_2026_11_14 BV1GJ411x7h7
 *   curl -s http://127.0.0.1:8787/api/subtitles \
 *     -H 'content-type: application/json' \
 *     -d "{\"token\":\"$(node scripts/mint-token.mjs dev_temp_key_2026_11_14 BV1GJ411x7h7)\",\"bvid\":\"BV1GJ411x7h7\"}"
 */

import { webcrypto } from 'node:crypto';

const crypto = globalThis.crypto ?? webcrypto;

const passphrase = process.argv[2];
const bvid = process.argv[3] ?? 'BV1GJ411x7h7';
const offsetSeconds = Number(process.argv[4] ?? 0);

if (!passphrase) {
  console.error('用法: node scripts/mint-token.mjs <AES_KEY> [BVID] [时间偏移秒数]');
  process.exit(1);
}

const encoder = new TextEncoder();
const digest = await crypto.subtle.digest('SHA-256', encoder.encode(passphrase));
const key = await crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt']);
const iv = crypto.getRandomValues(new Uint8Array(12));
const now = Math.floor(Date.now() / 1000) + offsetSeconds;
const plaintext = encoder.encode(JSON.stringify({ b: bvid, t: now }));
const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext));

const combined = new Uint8Array(iv.length + cipher.length);
combined.set(iv, 0);
combined.set(cipher, iv.length);

let binary = '';
for (let i = 0; i < combined.length; i += 1) binary += String.fromCharCode(combined[i]);
const token = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

process.stdout.write(token);
