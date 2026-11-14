/**
 * 网页端逻辑（无框架、无构建）。
 *
 * 与 Worker 侧 src/auth.ts 保持同一套算法：
 *   key       = SHA-256(UTF-8(口令)) -> AES-256-GCM
 *   iv        = 随机 12 字节
 *   plaintext = {"b":"BV...","t":<unix 秒>}
 *   token     = base64url(iv || ciphertext)
 *
 * 每次请求都重新生成 token（时间窗 60 秒，不需要也不应该缓存 token）。
 */
(() => {
  'use strict';

  const STORAGE_KEY = 'bili_subtitle_extract_aes_key';
  const encoder = new TextEncoder();

  const els = {
    key: document.getElementById('key'),
    toggleKey: document.getElementById('toggle-key'),
    bvid: document.getElementById('bvid'),
    page: document.getElementById('page'),
    fetch: document.getElementById('fetch'),
    remember: document.getElementById('remember'),
    loading: document.getElementById('loading'),
    loadingText: document.getElementById('loading-text'),
    status: document.getElementById('status'),
    result: document.getElementById('result'),
    videoTitle: document.getElementById('video-title'),
    videoMeta: document.getElementById('video-meta'),
    cacheBadge: document.getElementById('cache-badge'),
    tracks: document.getElementById('tracks'),
    cueCount: document.getElementById('cue-count'),
    cues: document.getElementById('cues'),
    copyText: document.getElementById('copy-text'),
    copySrt: document.getElementById('copy-srt'),
    downloadSrt: document.getElementById('download-srt'),
    downloadTxt: document.getElementById('download-txt'),
  };

  const state = {
    video: null,
    tracks: [],
    track: null,
    cues: [],
    bvid: '',
    page: 1,
    cached: false,
    cachedAt: null,
    busy: false,
    lastRequest: null,
    retryTimer: 0,
    retryAt: 0,
  };

  // ---------------------------------------------------------------- 工具函数
  function showStatus(kind, text) {
    els.status.hidden = false;
    els.status.className = `status ${kind}`;
    els.status.textContent = text;
  }

  function hideStatus() {
    els.status.hidden = true;
    els.status.textContent = '';
  }

  function setLoading(loading, text) {
    state.busy = loading;
    els.loading.hidden = !loading;
    if (text) els.loadingText.textContent = text;
    els.fetch.disabled = loading;
  }

  function clearRetry() {
    if (state.retryTimer) {
      clearInterval(state.retryTimer);
      state.retryTimer = 0;
    }
    state.retryAt = 0;
  }

  function parseBvid(input) {
    const matched = String(input || '').trim().match(/BV[0-9A-Za-z]{10}/);
    return matched ? matched[0] : '';
  }

  function parsePage() {
    const page = Number(els.page.value || 1);
    if (!Number.isInteger(page) || page < 1 || page > 100) return 1;
    return page;
  }

  function fmtClock(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const minutes = Math.floor(total / 60);
    const rest = total % 60;
    return `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
  }

  function fmtSrtTime(seconds) {
    const totalMs = Math.max(0, Math.round((Number(seconds) || 0) * 1000));
    const hours = Math.floor(totalMs / 3600000);
    const minutes = Math.floor((totalMs % 3600000) / 60000);
    const secs = Math.floor((totalMs % 60000) / 1000);
    const ms = totalMs % 1000;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(
      2,
      '0',
    )},${String(ms).padStart(3, '0')}`;
  }

  function fmtDuration(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    return `${minutes}:${String(secs).padStart(2, '0')}`;
  }

  function fmtDateTime(ms) {
    try {
      return new Date(ms).toLocaleString('zh-CN', { hour12: false });
    } catch {
      return '';
    }
  }

  function safeFilename(name) {
    return String(name).replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 120);
  }

  // ---------------------------------------------------------------- 加密 token
  async function makeToken(passphrase, bvid) {
    const digest = await crypto.subtle.digest('SHA-256', encoder.encode(passphrase));
    const key = await crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = encoder.encode(JSON.stringify({ b: bvid, t: Math.floor(Date.now() / 1000) }));
    const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext));
    const combined = new Uint8Array(iv.length + cipher.length);
    combined.set(iv, 0);
    combined.set(cipher, iv.length);
    let binary = '';
    for (let i = 0; i < combined.length; i += 1) binary += String.fromCharCode(combined[i]);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  // ---------------------------------------------------------------- 密钥记忆
  function loadSavedKey() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        els.key.value = saved;
        els.remember.checked = true;
      }
    } catch {
      /* localStorage 不可用时忽略 */
    }
  }

  function saveKey() {
    try {
      if (els.remember.checked) localStorage.setItem(STORAGE_KEY, els.key.value);
      else localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }

  // ---------------------------------------------------------------- 请求流程
  function scheduleRetry(params, seconds) {
    clearRetry();
    const wait = Math.max(1, Number(seconds) || 3);
    state.retryAt = Date.now() + wait * 1000;
    state.retryTimer = setInterval(() => {
      const left = Math.ceil((state.retryAt - Date.now()) / 1000);
      if (left <= 0) {
        clearRetry();
        requestSubtitles(params);
        return;
      }
      showStatus('warn', `该字幕正在抓取中，${left} 秒后自动重试…`);
    }, 250);
  }

  async function requestSubtitles({ bvid, page, lang }) {
    if (state.busy) return;

    const passphrase = els.key.value.trim();
    if (!passphrase) {
      showStatus('error', '请先填写 AES 密钥（部署时在 Cloudflare 设置的 AES_KEY）。');
      els.key.focus();
      return;
    }
    if (!window.isSecureContext || !window.crypto || !window.crypto.subtle) {
      showStatus('error', '当前页面不是安全上下文（https / localhost），浏览器不提供 WebCrypto，无法加密 token。');
      return;
    }

    clearRetry();
    hideStatus();
    setLoading(true, lang ? `正在获取 ${lang} 字幕…` : '正在获取字幕…');
    state.lastRequest = { bvid, page, lang };

    try {
      const token = await makeToken(passphrase, bvid);
      const response = await fetch('/api/subtitles', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token, bvid, page, lang }),
      });

      let payload;
      try {
        payload = await response.json();
      } catch {
        payload = { ok: false, code: 'BAD_RESPONSE', message: '服务端返回的不是 JSON' };
      }

      if (response.status === 429 || payload.code === 'CACHING') {
        const wait = Number(payload.retry_after_seconds) || 3;
        showStatus('warn', `该字幕正在抓取中，${wait} 秒后自动重试…`);
        scheduleRetry({ bvid, page, lang }, wait);
        return;
      }

      if (!response.ok || !payload.ok) {
        showStatus('error', payload.message || `请求失败（HTTP ${response.status}）`);
        if (response.status === 401) els.key.focus();
        return;
      }

      saveKey();
      renderResult(payload, { bvid, page });
      if (payload.empty) {
        showStatus('warn', payload.message || '该视频没有外挂字幕轨。');
      } else {
        showStatus(
          'ok',
          payload.cached
            ? '已命中 D1 缓存（未请求 B 站）。'
            : '已从 B 站抓取并写入 D1 缓存（1 天内复用）。',
        );
      }
    } catch (error) {
      showStatus('error', `请求失败：${error && error.message ? error.message : error}`);
    } finally {
      setLoading(false);
    }
  }

  // ---------------------------------------------------------------- 渲染
  function renderResult(payload, params) {
    const data = payload.data || {};
    const video = data.video || {};
    state.video = video;
    state.tracks = Array.isArray(data.tracks) ? data.tracks : [];
    state.track = data.track || null;
    state.cues = Array.isArray(data.cues) ? data.cues : [];
    state.bvid = video.bvid || params.bvid;
    state.page = video.page || params.page;
    state.cached = Boolean(payload.cached);
    state.cachedAt = data.cached_at || null;

    els.result.hidden = false;
    els.videoTitle.textContent = video.title || `视频 ${state.bvid}`;

    const metaParts = [];
    if (video.owner_name) metaParts.push(video.owner_name);
    if (video.duration) metaParts.push(`时长 ${fmtDuration(video.duration)}`);
    if (video.page_count) metaParts.push(`第 ${state.page}/${video.page_count} P`);
    if (state.cached && state.cachedAt) metaParts.push(`缓存于 ${fmtDateTime(state.cachedAt)}`);
    els.videoMeta.textContent = metaParts.join(' · ');

    renderTracks();
    renderCues();
  }

  function renderTracks() {
    els.tracks.innerHTML = '';
    if (!state.tracks.length) {
      const span = document.createElement('span');
      span.className = 'muted';
      span.textContent = '该视频没有外挂字幕轨';
      els.tracks.appendChild(span);
      return;
    }
    const activeLan = state.track ? state.track.lan : '';
    for (const track of state.tracks) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'track' + (track.lan === activeLan ? ' active' : '');
      button.dataset.lan = track.lan;
      button.title = `获取 ${track.lan_doc || track.lan} 字幕（BVID + 轨道名作为缓存键）`;
      button.textContent = track.lan_doc || track.lan;
      if (track.is_ai) {
        const ai = document.createElement('span');
        ai.className = 'ai';
        ai.textContent = 'AI';
        button.appendChild(ai);
      }
      els.tracks.appendChild(button);
    }
  }

  function renderCues() {
    els.cues.innerHTML = '';
    els.cueCount.textContent = state.cues.length ? `共 ${state.cues.length} 条字幕` : '没有字幕内容';
    els.copyText.disabled = !state.cues.length;
    els.copySrt.disabled = !state.cues.length;
    els.downloadSrt.disabled = !state.cues.length;
    els.downloadTxt.disabled = !state.cues.length;

    if (!state.tracks.length) {
      els.cacheBadge.textContent = '无字幕轨';
      els.cacheBadge.className = 'badge';
    } else if (state.cached) {
      els.cacheBadge.textContent = '缓存';
      els.cacheBadge.className = 'badge cache';
    } else {
      els.cacheBadge.textContent = '实时抓取';
      els.cacheBadge.className = 'badge fresh';
    }

    if (!state.cues.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = state.tracks.length ? '当前轨道没有字幕内容' : '该视频没有外挂字幕轨（CC / AI 字幕）';
      els.cues.appendChild(li);
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const cue of state.cues) {
      const li = document.createElement('li');

      const time = document.createElement('span');
      time.className = 'time';
      time.textContent = fmtClock(cue[0]);

      const text = document.createElement('span');
      text.className = 'text';
      text.textContent = cue[2];

      li.appendChild(time);
      li.appendChild(text);
      fragment.appendChild(li);
    }
    els.cues.appendChild(fragment);
  }

  function srtText() {
    return state.cues
      .map((cue, index) => {
        const lines = [
          String(index + 1),
          `${fmtSrtTime(cue[0])} --> ${fmtSrtTime(cue[1])}`,
          String(cue[2] || '').trim(),
        ];
        return lines.join('\n');
      })
      .join('\n\n') + '\n';
  }

  function plainText() {
    return state.cues
      .map((cue) => `[${fmtClock(cue[0])}] ${String(cue[2] || '').trim()}`)
      .join('\n') + '\n';
  }

  function fileBase() {
    const lan = state.track ? state.track.lan : 'subtitle';
    return safeFilename(`${state.bvid}-p${state.page}-${lan}`);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      showStatus('ok', '已复制到剪贴板。');
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      try {
        document.execCommand('copy');
        showStatus('ok', '已复制到剪贴板。');
      } catch {
        showStatus('error', '复制失败，请手动选择文本复制。');
      } finally {
        document.body.removeChild(textarea);
      }
    }
  }

  function download(filename, text) {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  // ---------------------------------------------------------------- 事件绑定
  function toggleKeyVisibility() {
    const isPassword = els.key.type === 'password';
    els.key.type = isPassword ? 'text' : 'password';
    els.toggleKey.textContent = isPassword ? '隐藏' : '显示';
  }

  function onFetchClick() {
    const bvid = parseBvid(els.bvid.value);
    if (!bvid) {
      showStatus('error', '请输入正确的 BVID（例如 BV1GJ411x7h7）或包含 BVID 的视频链接。');
      els.bvid.focus();
      return;
    }
    // 切换视频时重新拿默认轨道
    const sameVideo = state.bvid === bvid && state.page === parsePage();
    const lang = sameVideo && state.track ? state.track.lan : 'auto';
    requestSubtitles({ bvid, page: parsePage(), lang });
  }

  function onTrackClick(event) {
    const button = event.target.closest('.track');
    if (!button || !button.dataset.lan) return;
    if (state.busy) return;
    if (!state.video) return;
    requestSubtitles({ bvid: state.bvid, page: state.page, lang: button.dataset.lan });
  }

  function init() {
    loadSavedKey();

    els.toggleKey.addEventListener('click', toggleKeyVisibility);
    els.remember.addEventListener('change', saveKey);
    els.fetch.addEventListener('click', onFetchClick);
    els.bvid.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') onFetchClick();
    });
    els.key.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') onFetchClick();
    });
    els.tracks.addEventListener('click', onTrackClick);

    els.copyText.addEventListener('click', () => copyText(plainText()));
    els.copySrt.addEventListener('click', () => copyText(srtText()));
    els.downloadSrt.addEventListener('click', () => download(`${fileBase()}.srt`, srtText()));
    els.downloadTxt.addEventListener('click', () => download(`${fileBase()}.txt`, plainText()));
  }

  init();
})();
