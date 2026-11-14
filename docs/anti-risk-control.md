# B 站风控对抗记录（412 / socket / pagelist）

> 记录时间：2026-11-14（Asia/Shanghai）
> 项目：`bili-subtitle-extract`（Cloudflare Worker + D1，匿名提取 B 站字幕）
> 状态：已解决并上线验证；本文用于日后回顾、复现排查与应对策略变化。

---

## 0. TL;DR

| 项 | 内容 |
|---|---|
| 症状 | 部署到 Cloudflare 后，Worker 请求 B 站接口全部返回 **HTTP 412 `request was banned`** |
| 直接原因 | Worker 用 `fetch()` 出站时，Cloudflare 强制附加 `cf-connecting-ip` / `cf-ipcountry` / `cf-worker` 等请求头；B 站 WAF 据此判定为机器人流量 |
| 方案一 | `cloudflare:sockets` 建立原始 TCP + TLS，自行拼 HTTP/1.1 请求，绕过 CF 的 HTTP 代理层（`src/socket-http.ts`） |
| 遗留问题 | `x/web-interface/view` 即使走 socket 仍被风控（412 或 `-404` 诱饵响应） |
| 方案二 | view 失败时降级用 `x/player/pagelist` 获取 cid / 分P / 时长；标题退化为第一个分P的 part 名 |
| 最终效果 | 线上 `via:"socket"`；首次提取约 6s，D1 缓存命中约 1.3s；字幕、换轨、无字幕、鉴权失败均符合预期 |

核心结论：**Cloudflare Worker 访问国内有 WAF 的站，`fetch` 不等价于浏览器请求；需要按接口级别探测风控，并准备降级路径。**

---

## 1. 背景

Worker 的字幕提取链路需要 3 个请求：

1. `x/web-interface/view`（BVID → cid / 标题 / 分P）
2. `x/v2/dm/view`（cid → 字幕轨列表，含限时 `subtitle_url`）
3. `subtitle_url`（字幕 JSON）

这套接口在本地（上海中国移动家宽）匿名访问完全正常，但部署到 Cloudflare 后第一步就失败。
本文记录从“412”到“线上可用”的完整排查与方案，包含实测数据，便于将来 B 站策略变化时快速定位。

---

## 2. 时间线

| 时间 | 事件 | 对应 commit |
|---|---|---|
| 14:22 | 首次 push，CF Workers Builds 触发 | `1ea9a28` |
| 14:23 | 构建失败：pnpm 10 报 `packages field missing or empty` | — |
| 14:36 | 修复 `pnpm-workspace.yaml` 后构建成功 | `28bfcb6` |
| 15:18 | 线上 `/api/health`：`http_status:412`、`code:-412`、`message:"request was banned"` | — |
| 15:19 | 实现 socket 传输层（`BILI_TRANSPORT=auto/fetch/socket`） | `f8d4a88` |
| 15:21 | 构建成功；15:22 线上 health 变为 `via:"socket"`、`code:-101` | — |
| 15:22 | 字幕接口仍 502 `BILI_RISK_CONTROL` → 定位到 view 接口 | — |
| 15:23 | 加临时诊断端点 `/api/health?probe=1`（对比 fetch/socket） | `22e4f16` / `464ba0d` |
| 15:25 | 结论：view 被单独风控；pagelist / dm/view 可走 socket → 实现降级 | `667d9fe` |
| 15:27 | 线上首次提取成功、二次请求命中 D1、换轨成功、开发密钥 401 | — |
| 15:29 | 移除诊断端点、补标题兜底，最终验证 | `834f8e6` |

> 构建 ID 可在对应 commit 的 GitHub check-run 的 `details_url` 中找到；诊断端点代码可用
> `git show 22e4f16` / `git show 464ba0d` 查看。

---

## 3. 症状与初步判断

线上 `/api/health` 返回：

```json
{
  "ok": true,
  "config": { "aes_key_configured": true },
  "bilibili": {
    "ok": false,
    "http_status": 412,
    "code": -412,
    "message": "request was banned",
    "ms": 287
  }
}
```

同时正文是：

```json
{"code":-412,"message":"request was banned","ttl":1}
```

初步排除项：

- 不是 WBI 签名 / Cookie / 参数问题：字幕链路本来就不需要这些，本地同一套代码正常；
- 不是 B 站接口变更：本地（国内家宽）同时刻访问返回 `code:0`；
- 不是 Worker 代码错误：`/api/health` 已是最小请求（只请求 nav）。

因此高度怀疑：**Cloudflare 出口 IP / CF 注入的请求头触发了 B 站 WAF**。
随后用临时诊断端点验证了这个判断（见下一节）。

---

## 4. 诊断：接口级 `fetch` vs `socket` 探针

为了一次性拿到足够信息，临时在 Worker 里加了：

```
GET /api/health?probe=1&bvid=BV...&cid=...
```

对每个候选接口分别用两种方式请求：

- `fetch`：Worker 默认方式（会被 CF 注入 `cf-*` 头）；
- `socket`：`cloudflare:sockets` 直连 TLS，自拼 HTTP/1.1（不经过 CF HTTP 代理层）。

2026-11-14 15:26 左右的线上实测（同一 Worker、同一时刻）：

| 接口 | fetch | socket | 说明 |
|---|---|---|---|
| `x/web-interface/nav` | **412** | 200 `code:-101` | 匿名未登录，正常 |
| `x/web-interface/view` | **412** | **412** / 某几次 `200 + code:-404` | B 站对 view 单独风控，返回值不稳定 |
| `x/player/pagelist` | **412** | **200 `code:0`** | 可拿到 cid / page / part / duration |
| `x/v2/dm/view` | **412** | **200 `code:0`** | 可拿到字幕轨列表 |
| `x/player/v2` | **412** | **200 `code:0`** | 含 aid / bvid / cid 等（未用于业务） |
| `x/frontend/finger/spi` | — | **200 `code:0`** | 可拿到 buvid3 / buvid4 |
| `x/web-interface/archive/stat` | 412 | 404（B 站 HTML 错误页） | 不可用 |
| `x/web-interface/wbi/view`（未签名） | 412 | 412 | 不可用 |
| `www.bilibili.com/video/BV...` 网页 | 412 | 412 | 不可用 |

补充尝试（均失败）：

| 变体 | 结果 |
|---|---|
| `view?bvid=...&jsonp=jsonp` | socket 412 |
| `view` + 视频页 Referer | socket 412 |
| `view` + `Origin` / `Sec-Fetch-*` 浏览器头 | socket 412 |
| `view?aid=...` | socket 412 |
| `view` + 从 `finger/spi` 拿到的 `buvid3/buvid4` Cookie | socket `200 + code:-404`（诱饵，仍拿不到真实数据） |

关键观察：

1. **所有 `fetch` 请求全部 412** —— 与 CF 注入头/出口高度相关；
2. **socket 对 nav、pagelist、dm/view 等接口有效** —— 说明不是简单的“IP 段全封”，而是按接口 + 请求特征的风控策略；
3. **view 是特殊项**：socket 下也返回 412，偶尔返回 `HTTP 200 + code -404 "啥都木有"`。
   这不是“视频不存在”，而是风控诱饵——同一个 BVID 本地请求返回 `code:0`；
4. 补 Cookie、补 Referer、补 `Sec-Fetch-*`、加 `jsonp`、换 `aid` 参数都不能让 view 恢复；
   说明 view 是按“来源 IP + 接口”做的策略，不是缺某个参数。

结论：**fetch 层要绕过 CF 注入头；view 接口要换数据源。**

---

## 5. 方案一：原始 TCP + TLS（socket）绕过 CF 注入头

### 5.1 为什么可行

Cloudflare Workers 的 `fetch()` 出站会由 CF 统一代理，并附加一些无法由业务代码删除的请求头
（`cf-connecting-ip`、`cf-ipcountry`、`cf-worker` 等）。B 站 WAF 检测到这些头后直接 412。

`cloudflare:sockets` 提供原始 TCP 能力：

- 可以直连端口 443 并自行完成 TLS（`secureTransport: 'on'`）；
- 请求/响应完全由业务代码构造与解析，不经过 CF 的 HTTP 代理层，因此**不会附加 `cf-*` 头**；
- CF 限制：不能连 Cloudflare 自有 IP 段 / 私网 / localhost；每个请求最多 6 个并发出站连接；socket 只能在请求处理过程中创建。

实测 `nav`、`pagelist`、`dm/view` 在 socket 下全部 200，方案成立。

### 5.2 实现（`src/socket-http.ts`）

一个极简的 HTTPS 客户端，包含：

| 能力 | 说明 |
|---|---|
| 建连 | `connect({ hostname, port }, { secureTransport: 'on', allowHalfOpen: true })` |
| 请求 | `GET path?query HTTP/1.1` + `Host` / UA / Referer / Accept / `Connection: close` |
| 响应解析 | 状态行、headers、`Content-Length` / `Transfer-Encoding: chunked` |
| 解压 | `Content-Encoding: gzip` / `deflate`（通过 `DecompressionStream`，按 `Accept-Encoding: identity` 发送，仍兼容压缩） |
| 重定向 | 301/302/303/307/308 最多 3 次 |
| 超时 | 默认 15s，超时关闭 socket |
| 防护 | 响应体上限 4MB；TLS 握手失败/读超时抛错并包装成 `BILI_SOCKET_ERROR` |

### 5.3 传输状态机（`src/bili.ts`）

Worker 变量 `BILI_TRANSPORT` 控制，默认 `auto`：

| 值 | 行为 |
|---|---|
| `auto` | 先 `fetch`；若 HTTP 412 或网络错误，改用 socket 重试；成功后本 isolate 内后续请求都直接走 socket（`forceSocket = true`） |
| `fetch` | 只用 fetch（本地开发用） |
| `socket` | 只用 socket（强制验证/排查） |

`/api/health` 返回的 `bilibili.via` 会显示实际使用的传输方式：

```json
{"bilibili":{"ok":true,"http_status":200,"code":-101,"message":"账号未登录","ms":1217,"via":"socket"}}
```

本地验证 socket 实现：`.dev.vars` 写 `BILI_TRANSPORT=socket`，用 `wrangler dev` + `scripts/mint-token.mjs` 跑通真实字幕抓取。

---

## 6. 方案二：view → pagelist 降级

`x/web-interface/view` 是拿标题/UP 主/总时长的唯一方便接口，但它被单独风控且无法用参数绕过。
而 `x/player/pagelist` 可以用，能拿到：

```json
[{"cid":137649199,"page":1,"part":"...","duration":213,"...": "..."}]
```

降级规则（`src/bili.ts` 的 `resolveMeta`）：

| 字段 | 来源 |
|---|---|
| `cid` / 分P数 / pages | pagelist（view 可用时优先 view） |
| `title` | `view.title` → 第一分P `part` → 当前分P `part` → BVID |
| `owner_name` / `owner_mid` | view 可用时才有，否则空 / 0 |
| `duration` | view 可用时用总时长，否则当前分P时长 |
| `cover` / `pubdate` / `aid` | view 可用时才有，否则空 / 0 |

影响：

- **字幕本身完全不受影响**（cid + dm/view + subtitle_url 链路完整）；
- 标题可能比真实标题短（例如真实标题是 `【官方 MV】...`，降级后是分P名 `...`）；
- 元信息缓存 1 天，所以每个视频每天最多探测一次 view，不会持续触发风控；
- view 偶尔能成功时仍会用真实标题，属“尽力而为”。

---

## 7. 线上实测数据（2026-11-14）

| 场景 | 结果 |
|---|---|
| `GET /api/health` | 200，`bilibili.ok:true`，`code:-101`，`via:"socket"`，0.7~1.2s |
| 首次提取 `BV1GJ411x7h7`（zh） | 200，`cached:false`，44 cues，约 5.8~6.0s |
| 再次请求同轨 | 200，`cached:true`，1.29s（命中 D1） |
| 切换 `en-US` | 200，50 cues，约 3.6s（新缓存键） |
| 切换 `ja`（新缓存） | 200，62 cues，约 6.0s |
| 无外挂字幕视频 | 200 + `empty:true` + 提示，约 3.3s |
| 错误密钥 / 开发密钥 | 401 `AUTH_FAILED` |
| 非法 BVID | 400 `INVALID_BVID` |

首次提取之所以比缓存慢，是因为 socket 模式下每个 B 站请求都要新建 TCP + TLS 连接
（view 探测 412 → pagelist → dm/view → subtitle 文件），且要等 view 失败后才降级。
缓存命中只需要一次 D1 读，因此约 1.3s。

---

## 8. 配置与再次排查

### 8.1 切换传输方式

`BILI_TRANSPORT` 定义在 `wrangler.jsonc` 的 `vars` 里（默认 `auto`）。
注意：**在 wrangler 配置中定义的变量会覆盖 Dashboard 同名变量**。要改默认值：

- 改 `wrangler.jsonc` 的 `vars.BILI_TRANSPORT` 后 push；或
- 在 Dashboard 设置同名变量前，先从 `wrangler.jsonc` 删除该变量（`keep_vars = true` 会保留 Dashboard 配置）。

### 8.2 快速判断当前状态

```bash
curl -s https://<你的域名>/api/health
```

- `bilibili.http_status:200` + `code:0 或 -101` → 正常；
- `http_status:412` 且 `via:"socket"` → socket 也被 IP 级风控（见第 9 节）；
- `via:"fetch"` 且 412 → auto 回退未生效或 `BILI_TRANSPORT=fetch`，检查配置。

### 8.3 重新跑接口级探针

诊断端点已在 `834f8e6` 中移除（避免公开端点被滥用生成 B 站请求）。需要复现时：

```bash
git show 22e4f16:src/bili.ts      # 第一版探针
git show 464ba0d:src/bili.ts      # 扩展版探针（view 变体 / pagelist / cookie 等）
git show 22e4f16:src/app.ts       # 临时路由接线
```

按上述内容临时恢复代码 → push → 访问 `/api/health?probe=1&bvid=...&cid=...` → 排查完再移除。
本地也可以用 `wrangler tail` 观察 Worker 日志。

---

## 9. 如果未来 socket 也失效

可能原因：

- B 站对 Cloudflare 的 socket 出口 IP 段做整体封禁；
- 对 TLS 指纹（JA3/JA4）、HTTP/2 缺失、连接行为做识别；
- 接口策略再次调整（例如某接口单独提高风控等级）。

按 `/api/health` 的表现区分：

| 表现 | 判断 | 应对 |
|---|---|---|
| socket 下部分接口 200、部分 412 | 接口级风控 | 换接口/降级（本次方案二） |
| socket 下全部 B 站接口 412 | IP/网络层封禁 | socket 无解，需要非 CF 中转 |
| 偶尔 412、重试恢复 | 频率/风控抖动 | 降低频率、加缓存、退避重试 |

备选方案（按成本从低到高）：

1. **非 CF 中转**：在国内 VPS / 已有服务器上部署一个极小的 B 站请求转发服务（只做 view/pagelist/dm/view），
   Worker 通过 `fetch` 调用中转；需给中转加 token 鉴权、限流、最小化日志。代价：多一台服务器。
2. **Cloudflare Tunnel + 家宽中转**：家里常开设备跑中转，用 Tunnel 暴露给 Worker；
   不适合长期无人值守。
3. **第三方数据源/API**：字幕/元信息接口换成别家，但一致性与可用性不可控，谨慎选。
4. **暂停/降级功能**：保留 D1 缓存中已有的字幕，仅对未缓存视频提示稍后再试。

> 决策原则：先看 `/api/health` 确认是“接口级”还是“IP 级”；接口级优先换接口，IP 级才考虑增加中转。

---

## 10. 注意事项与合规

- 只请求 B 站公开接口，不登录、不绕过付费/地区限制；
- 出现 412 时**立刻降频或停手**，不要重试轰炸（-412 是 IP 级风控，重试会加重）；
- 项目本身用 D1 缓存字幕 1 天、元信息 1 天，减少重复请求；视图探测每视频最多每天一次；
- `/api/health` 每次会请求 2 个 B 站接口（nav + 可能的探测），不要频繁调用；
- 不要把 SESSDATA 等 Cookie 写进代码或 Secret——本方案不需要。

---

## 11. 复盘与经验

1. **Worker 的 fetch 出站不是浏览器**：CF 会注入 `cf-*` 头，国内有 WAF 的站点很容易识别。
   遇到 412 时，先怀疑“来源特征”，再怀疑参数/签名。
2. **按接口做探针，而不是整体判断**：同一站点里 `nav/pagelist/dm` 可用、`view` 被单独封，
   只看一个接口会误判为“全站封禁”。
3. **警惕“HTTP 200 + 业务 code -404”的诱饵**：不能只看业务 code 就认定“视频不存在”，
   要同时看 HTTP 状态、响应体内容，并与本地/已知正常请求对比。
4. **准备好降级路径**：核心目标（字幕）依赖的接口（pagelist/dm/view）可用，就能先上线；
   非核心信息（标题/UP 主）允许退化，后续再优化。
5. **缓存与限频也是风控对抗的一部分**：D1 缓存把重复请求降到零；元信息缓存让 view 探测每天最多一次。
6. **记录数据**：状态码、`via`、耗时、接口、时间。本次排查能快速定位，靠的就是探针留下的结构化对比数据。

---

## 附录 A：排查期间的其他工程坑

1. **pnpm 10 的 workspace 清单**：`pnpm-workspace.yaml` 缺少 `packages` 字段时，
   CF Workers Builds 的 `pnpm install --frozen-lockfile` 直接失败（`packages field missing or empty`）。
   单包项目也要写 `packages: ["."]`。
2. **开发密钥与线上密钥隔离**：本地 `.dev.vars` 已 gitignore，`wrangler deploy` 不会上传；
   线上只认 Dashboard Secret `AES_KEY`。曾用本地开发密钥在线上发起请求验证，返回 401，
   证明开发密钥在线上不可用。
3. **构建环境差异**：CF 构建使用 Node 24 + pnpm 10.11.1；本地是 Node 27 + pnpm 12，
   配置需要兼容两代 pnpm 的 build-script 白名单（`onlyBuiltDependencies` 与 `allowBuilds`）。

## 附录 B：相关 commit

| commit | 内容 |
|---|---|
| `1ea9a28` | 首个版本：D1 缓存 + AES-GCM 鉴权 + 网页 |
| `28bfcb6` | 修复 pnpm workspace 构建失败 |
| `f8d4a88` | socket 传输层 + `BILI_TRANSPORT` 回退 |
| `22e4f16` | 临时诊断端点（首个探针） |
| `464ba0d` | 扩展探针：pagelist / aid / 网页 / buvid cookie 变体 |
| `667d9fe` | view 风控降级 pagelist |
| `834f8e6` | 移除诊断端点、标题兜底、最终验证 |

## 附录 C：探针返回样例（节选）

```json
{
  "bilibili": { "ok": true, "http_status": 200, "code": -101, "ms": 673, "via": "socket" },
  "probe": [
    {
      "label": "view",
      "url": "https://api.bilibili.com/x/web-interface/view",
      "fetch": { "status": 412, "code": -412, "snippet": "{\"code\":-412,\"message\":\"request was banned\"}" },
      "socket": { "status": 412, "code": -412, "snippet": "{\"code\":-412,\"message\":\"request was banned\"}" }
    },
    {
      "label": "pagelist",
      "url": "https://api.bilibili.com/x/player/pagelist",
      "fetch": { "status": 412, "code": -412 },
      "socket": { "status": 200, "code": 0, "snippet": "{\"code\":0,\"message\":\"OK\",\"data\":[{\"cid\":137649199,...}]}" }
    },
    {
      "label": "dm-view",
      "url": "https://api.bilibili.com/x/v2/dm/view",
      "fetch": { "status": 412, "code": -412 },
      "socket": { "status": 200, "code": 0, "snippet": "{\"code\":0,\"message\":\"OK\",\"data\":{\"subtitle\":{...}}}" }
    }
  ]
}
```
