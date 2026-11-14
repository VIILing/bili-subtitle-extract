# bili-subtitle-extract

一个部署在 **Cloudflare Workers** 上的 B 站字幕提取工具：

- 一个 `POST /api/subtitles` API：AES 鉴权 → D1 缓存 → 抓取锁 → 从 B 站匿名提取字幕（CC / AI 字幕）；
- 一个自带网页（同一个 Worker 的静态资源）：输入 AES 密钥和 BVID 即可使用，密钥只保存在浏览器 localStorage；
- 缓存与锁全部使用 **Cloudflare D1**（不用 KV，也不用 Durable Objects）；
- 每次请求只抓 **一条字幕轨**，缓存键为 `BVID + 分P + 字幕轨名`，例如 `BV1GJ411x7h7-p1-zh-Hans`。

> 原理参考了 `bili-toolkit` 的实测结论：字幕只需要 3 个匿名接口（`x/web-interface/view` → `x/v2/dm/view` → `subtitle_url`），
> **不需要登录、Cookie、WBI 签名**。
>
> 与 B 站风控对抗的完整记录（412、socket 回退、view→pagelist 降级、诊断数据与备选方案）见
> **[docs/anti-risk-control.md](docs/anti-risk-control.md)**。

---

## 1. 工作流程

```
POST /api/subtitles { token, bvid, page?, lang? }
        │
        ├─ 1. AES-GCM 解密 token —— 校验口令、BVID 绑定、60 秒时间窗
        │
        ├─ 2. 读 D1 video_meta（视频信息 + 字幕轨列表，TTL 1 天）
        │        └─ 没有 → 请求 B 站 view + dm/view，写入 video_meta
        │
        ├─ 3. 选轨（lang=auto 时按人工中文 > AI 中文 > 英文优先）
        │     读 D1 subtitle，键 = {bvid}-p{page}-{lan}
        │        └─ 命中 → 直接返回（不再请求 B 站）
        │
        ├─ 4. 未命中 → 原子抢锁（D1 单语句 UPSERT）
        │        └─ 抢不到 → 429「该字幕正在抓取中，请稍后再试」+ retry_after_seconds
        │
        ├─ 5. 现取字幕 URL（`http://` 升级为 `https://`）并下载 JSON → 解析 cues
        │
        ├─ 6. UPSERT subtitle（TTL 1 天）→ 释放锁 → 返回 { cached:false }
        │
        └─ 任何异常：finally 释放锁；锁本身 120 秒过期，Worker 崩溃也能自愈
```

为什么只用 D1：

| 需求 | 方案 |
|---|---|
| 字幕缓存、视频元信息缓存 | D1 普通行（读多写少，免费额度 500 万行读/天、10 万行写/天、5GB） |
| 防止同一视频同一轨道被并发重复抓取 | D1 单主库串行写 + 单语句原子 UPSERT（`ON CONFLICT ... WHERE expires_at <= now`），`meta.changes` 判断是否抢到 |
| 缓存一致性 | 不需要强一致；缓存读到旧值最多多抓一次，锁会拦住重复抓取 |
| 过期清理 | Cron Trigger 每天删除 `expires_at` 过期的行；读路径也会惰性删除过期行 |

KV 免费额度只有 1000 写/天，一次提取要写 2~3 次，所以不采用；DO 对本项目属于过度设计（只有一个锁需要一致性）。

---

## 2. API

### 2.1 `POST /api/subtitles`

请求体：

```json
{
  "token": "base64url(AES-GCM(iv || ciphertext))",
  "bvid": "BV1GJ411x7h7",
  "page": 1,
  "lang": "auto"
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `token` | 是 | 网页自动生成；也可放在 `Authorization: Bearer <token>` 头 |
| `bvid` | 是 | BVID，也接受包含 BVID 的视频链接 |
| `page` | 否 | 分 P，默认 1，范围 1~100 |
| `lang` | 否 | `auto`（默认）/ 真实轨道名如 `zh-Hans`、`en-US` / 别名 `zh`、`en`、`ja` |

成功响应（HTTP 200）：

```json
{
  "ok": true,
  "cached": false,
  "server_time": "2026-11-14T06:18:09.546Z",
  "cache_key": "BV1GJ411x7h7-p1-zh-Hans",
  "data": {
    "video": {
      "bvid": "BV1GJ411x7h7",
      "aid": 80433022,
      "title": "【官方 MV】Never Gonna Give You Up - Rick Astley",
      "owner_name": "账号已注销",
      "owner_mid": 371800306,
      "duration": 213,
      "page": 1,
      "page_count": 1,
      "cid": 137649199,
      "pages": [{ "page": 1, "part": "P1", "duration": 213 }]
    },
    "tracks": [
      { "lan": "zh-CN", "lan_doc": "中文（中国）", "is_ai": false },
      { "lan": "zh-Hans", "lan_doc": "中文（简体）", "is_ai": false }
    ],
    "track": { "lan": "zh-Hans", "lan_doc": "中文（简体）", "is_ai": false },
    "cues": [[18.225, 21.65, "我们对爱情并不陌生"]],
    "cue_count": 44,
    "cached_at": 1794637089546
  }
}
```

- `cues` 是紧凑数组：`[起始秒, 结束秒, 文本]`，SRT / TXT 由网页端根据 cues 生成；
- `cached=true` 表示命中 D1（`cached_at` 为写入时间）；
- 没有外挂字幕轨时返回 HTTP 200 + `empty: true` + `tracks: []`（网页显示提示，不算错误）。

错误响应统一为：

```json
{ "ok": false, "code": "AUTH_FAILED", "message": "验签失败：AES 密钥不正确", "server_time": "..." }
```

| HTTP | code | 含义 |
|---|---|---|
| 400 | `INVALID_BVID` / `INVALID_PAGE` / `TRACK_NOT_FOUND` / `INVALID_REQUEST` | 参数错误 |
| 401 | `AUTH_FAILED` | 密钥错误 / token 与 BVID 不匹配 / 超过 60 秒时间窗 |
| 404 | `VIDEO_NOT_FOUND` / `NO_SUBTITLE_TRACK` | 视频不存在 / 没有字幕轨 |
| 429 | `CACHING` | 同一视频同一轨道正在被其他请求抓取，`retry_after_seconds` 为建议等待秒数 |
| 500 | `SERVER_NOT_CONFIGURED` | 没配置 `AES_KEY` Secret |
| 502/504 | `BILI_RISK_CONTROL` / `BILI_HTTP` / `BILI_TIMEOUT` / `SUBTITLE_EXPIRED` 等 | B 站侧错误（含 412 风控） |

> 面向 AI Agent / 自动化脚本的一页式使用说明见 [public/skill.txt](public/skill.txt)（部署后访问 `/skill.txt`）；网页顶部也提供了入口链接。

### 2.2 `GET /api/health`

不需要鉴权，用于排查「Cloudflare 出口能否访问 B 站」：

```json
{
  "ok": true,
  "server_time": "...",
  "config": { "aes_key_configured": true },
  "bilibili": { "ok": true, "http_status": 200, "code": -101, "message": "账号未登录", "ms": 132, "via": "socket" }
}
```

- `bilibili.code = -101` 属正常（匿名请求 nav 接口）；
- 若返回 `http_status: 412` / `BILI_RISK_CONTROL`，说明 Cloudflare 出口被 B 站风控，需要走下面的「风险」方案。

---

## 3. 鉴权算法（网页端与 Worker 端一致）

```
key       = SHA-256(UTF-8(AES_KEY))                 // AES-256-GCM
iv        = 随机 12 字节
plaintext = {"b": "<bvid>", "t": <unix 秒>}
token     = base64url(iv || AES-GCM密文)             // 密文自带 16 字节 tag
```

Worker 校验：能解密（口令正确）→ `b` 与请求 BVID 一致 → `|now - t| <= 60s`。
`v1` 的载荷里没有随机 nonce，60 秒内 token 可重放（同一 BVID），这是有意的取舍；
密钥建议使用 16 位以上随机字符串。网页端密钥只存 localStorage，**不会上传服务器**。

---

## 4. D1 表结构

首次请求自动建表（每个 isolate 只检查一次，Git 部署无需手动跑 migration）：

```sql
CREATE TABLE video_meta (
  cache_key  TEXT PRIMARY KEY,   -- {bvid}-p{page}-meta
  payload    TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE subtitle (
  cache_key  TEXT PRIMARY KEY,   -- {bvid}-p{page}-{lan}，例如 BV1GJ411x7h7-p1-zh-Hans
  payload    TEXT NOT NULL,      -- JSON: [[from,to,text], ...]
  cached_at  INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE fetch_lock (
  cache_key  TEXT PRIMARY KEY,   -- 与 subtitle 同键
  expires_at INTEGER NOT NULL    -- now + 120s
);
```

抢锁 SQL（单语句原子，依赖 D1 单主库串行写）：

```sql
INSERT INTO fetch_lock (cache_key, expires_at) VALUES (?, ?)
ON CONFLICT(cache_key) DO UPDATE SET expires_at = excluded.expires_at
WHERE fetch_lock.expires_at <= ?;   -- 过期锁可被接管；未过期时 changes=0
```

---

## 5. 部署到 Cloudflare

仓库已关联 Cloudflare Workers 的 Git 部署：**推送到 `main` 即自动构建 + 部署**。

工作流：

1. `wrangler.jsonc` 的 `name` 为 `bili-subtitle-extract`，与 Cloudflare 上的 Worker 一致；
2. `d1_databases` 只声明了 `binding = "DB"`，**没有写 database_id**：wrangler 4.45+ 在部署时会自动创建 D1 数据库并绑定（Git 部署下 ID 只显示在 Dashboard，不影响后续部署）；
3. 首次部署完成后，在 Cloudflare Dashboard 给 Worker 添加 Secret：
   - Workers & Pages → `bili-subtitle-extract` → Settings → Variables and Secrets → Add → **Secret** → 名称 `AES_KEY`，值填你自定义的口令；
   - 网页端输入同一个口令即可使用；
   - 配置了 `keep_vars = true`，以后每次 Git 部署不会覆盖/删除这个 Secret。
4. 打开 Worker 的访问域名（workers.dev 子域或自定义域名）→ 页面即可使用；
5. 可选：访问 `/api/health` 确认 `bilibili.ok=true`。

Cron Trigger 已配置为每天 `23 3 * * *`（UTC）清理过期缓存与锁。

### 构建命令

Workers Builds 里推荐配置：

| 项 | 值 |
|---|---|
| Build command | `npm run build`（= `tsc --noEmit`，可选） |
| Deploy command | `npx wrangler deploy` |

即使 Build command 留空也可以部署（TypeScript 由 wrangler/esbuild 直接打包）。

---

## 6. Cloudflare 出口 412 与 socket 传输

Cloudflare Worker 用 `fetch()` 出站时会被强制附加 `cf-connecting-ip`、`cf-ipcountry`、`cf-worker`
等请求头，B 站 WAF 会因此返回 **HTTP 412**（本项目线上首次部署实测就是如此）。

因此 `src/bili.ts` 内置了两种出站方式，由 Worker 变量 `BILI_TRANSPORT` 控制：

| 值 | 行为 |
|---|---|
| `auto`（默认） | 先 `fetch`；若 HTTP 412 或网络错误，自动改用原始 TCP + TLS（`cloudflare:sockets` + 自拼 HTTP/1.1）重试；成功后本 isolate 内后续请求都直接走 socket，避免反复撞 412 |
| `fetch` | 只用 `fetch`（本地开发一般够用） |
| `socket` | 只用原始 TCP + TLS（强制走 socket，可用于排查） |

原始 TCP 方式完全不经过 CF 的 HTTP 代理层，请求头由我们自己构造（Host / UA / Referer / Accept），
所以不会带 `cf-*` 头。`/api/health` 返回的 `bilibili.via` 会显示本次实际使用的方式（`fetch` / `socket`）。

本地强制测试 socket 方式：在 `.dev.vars` 里写 `BILI_TRANSPORT=socket` 再 `pnpm dev`。

> 为什么 view 接口即使走 socket 也会被风控、pagelist 降级细节、线上实测数据与后续备选方案，
> 见 **[docs/anti-risk-control.md](docs/anti-risk-control.md)**。

## 7. 本地开发

```bash
pnpm install

# 本地环境变量（wrangler dev 会读取；已 gitignore）
cp .dev.vars.example .dev.vars
# 编辑 .dev.vars，例如 AES_KEY=dev_temp_key_2026_11_14

pnpm dev            # http://localhost:8787 （本地 D1 自动创建）
pnpm test           # vitest 单测
pnpm typecheck      # tsc --noEmit
```

生成 token 并调用本地 API：

```bash
TOKEN=$(node scripts/mint-token.mjs dev_temp_key_2026_11_14 BV1GJ411x7h7)
curl -s http://127.0.0.1:8787/api/subtitles \
  -H 'content-type: application/json' \
  -d "{\"token\":\"$TOKEN\",\"bvid\":\"BV1GJ411x7h7\",\"lang\":\"zh\"}"

curl -s http://127.0.0.1:8787/api/health
```

本地 D1 数据默认存放在 `.wrangler/state`，可用下面的命令查看：

```bash
pnpm wrangler d1 execute DB --local --command "SELECT cache_key FROM subtitle"
```

---

## 8. 目录结构

```
.
├── src/
│   ├── index.ts      # Worker 入口：/api/* 走 app，其余走静态资源；Cron 清理
│   ├── app.ts        # API 路由与业务编排（可注入依赖，便于单测）
│   ├── auth.ts       # AES-GCM + 时间窗 鉴权
│   ├── bili.ts       # B 站 3 个匿名接口 + 轨道选择 + cues 解析
│   ├── store.ts      # D1：缓存 / 元信息 / 原子锁 / 清理
│   ├── errors.ts     # ApiError 与 B 站错误码映射
│   └── types.ts      # 公共类型 + Env 绑定
├── public/           # 网页（同源静态资源，无框架无构建）
│   ├── index.html
│   ├── app.js        # 浏览器端 WebCrypto 生成 token + 展示/导出字幕
│   ├── style.css
│   ├── skill.txt     # 面向 Agent 的 API/Skill 使用说明（部署后 /skill.txt）
│   └── _headers      # 让 /skill.txt 以 text/plain; charset=utf-8 返回
├── test/             # vitest：鉴权、B 站解析、API 流程（假 Store/BiliClient）
├── docs/
│   └── anti-risk-control.md   # B 站风控对抗记录（412 / socket / pagelist，含实测数据）
├── scripts/mint-token.mjs
├── wrangler.jsonc
└── package.json
```

---

## 9. 已知限制与风险

- **Cloudflare 出口风控**：B 站会对 CF 注入的 `cf-*` 请求头返回 412，已通过 `BILI_TRANSPORT=auto`
  自动切换到原始 TCP+TLS 解决（见第 6 节）；`/api/health` 的 `bilibili.via` 可确认实际走的是哪条路。
  如果 socket 也被 B 站按 IP 拦截，需要再考虑非 CF 中转（会引入额外服务器）。
- **`x/web-interface/view` 可能被风控**：CF 出口请求该接口可能返回 412 或 `-404` 诱饵响应；
  代码会自动降级用 `x/player/pagelist` 获取 cid / 分 P / 时长，标题退化为第一个分 P 的 part 名
  （可能比真实标题略短），不影响字幕提取。
- **首次提取延迟**：受 CF 出口 412 + socket 回退影响，首次提取约 3~5 秒；之后同视频同轨道命中 D1 缓存约 1 秒。
- **字幕 URL 是限时签名**：缓存里只存轨道元信息，不存 `auth_key`；下载 403 时会自动重新取一次 URL。
- **单次只抓一条轨**：切换语言 = 换缓存键重新请求（命中的轨道不会重复下载）。
- **只支持有外挂字幕轨的视频**：没有 CC / AI 字幕的视频返回 `empty`；弹幕不能当字幕用。
- **番剧 / 付费 / 充电专属**：匿名接口不支持，本项目也不打算绕过。
- **D1 免费额度**：10 万行写/天、500 万行读/天、5GB 存储（单库上限 500MB）。一次新提取约 3~5 行写，
  个人使用足够；浏览器页面不存字幕数据，只缓存密钥。
- **鉴权简化**：token 60 秒内可重放；密钥一旦泄露，对方可以调用接口但无法读取你浏览器的 localStorage。

## 10. 合规

- 只请求 B 站公开接口，用于个人学习与研究；请控制频率，不要滥用；
- 字幕版权归原作者与平台所有，请勿二次发布或商用；
- 本项目不绕过登录、付费、充电、地区限制。
