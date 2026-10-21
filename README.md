# Favicon API

一个 Cloudflare Worker，把任意网站的 favicon 直接以图片字节返回。拿到就能塞进
`<img>`、`<link rel="icon">` 或者后端图片代理。

```
GET https://<你的-worker>.workers.dev/?url=https://github.com
```

## 它怎么找到图标的

Worker 按顺序走一条候选链，命中第一个「确实是图片」的响应就停：

| 优先级 | 来源 | 说明 |
|:--|:--|:--|
| P0 | `<link rel="icon" type="image/svg+xml">` | 矢量图，任意尺寸都清晰 |
| P1 | `<link rel="apple-touch-icon">` | 通常是 180×180 的 PNG |
| P2 | `<link rel="icon" sizes="…">` | 32×32 / 48×48 这类 |
| P3 | `<link rel="shortcut icon">`、没写 sizes 的 icon | 页面声明里最后那批 |
| P4 | `/favicon.ico` | 约定俗成的路径 |
| P5 | DuckDuckGo，然后 Google | 站点自己失败时才用 |
| P6 | 本地生成的首字母方块 | 必定成功，所以接口永远有响应 |

HTML 用 `HTMLRewriter` 解析；每个响应的真实类型由**魔数嗅探**得出——很多服务器会把
`.ico` 标成 `application/octet-stream`，不能信它自己声明的 Content-Type。

## 用法

| 参数 | 必填 | 说明 |
|:--|:--:|:--|
| `url` | 是 | 目标网址。可以省略 scheme，默认补 `https://` |
| `size` | 否 | 向第三方兜底服务请求的尺寸，16–256，默认 64 |
| `refresh` | 否 | `1` 表示忽略存储，强制重新抓一次 |

```bash
# 取某个站点的图标
curl -o favicon.png "https://favicon.example/?url=https://github.com"

# 直接嵌进页面
<img src="https://favicon.example/?url=https://github.com" alt="GitHub">
```

图标是按**站点**而不是按页面解析的：Worker 抓的是 `https://<host>/`，一个 host 只存
一条记录。所以 `https://example.com/blog/post` 和 `https://example.com` 返回的是同一张图。

### 响应头

| Header | 取值 |
|:--|:--|
| `content-type` | `image/png`、`image/svg+xml`、`image/x-icon` 等 |
| `x-favicon-source` | `html`、`favicon.ico`、`ddg`、`google`、`generated` |
| `x-favicon-final-url` | 图标实际是从哪个绝对地址取到的 |
| `x-favicon-cache` | `FRESH`、`STALE`、`MISS`、`FALLBACK` |
| `x-favicon-reason` | 走了兜底时，说明原因（通常是失败信息） |
| `cf-cache-status` | `HIT` / `MISS` / `EXPIRED` 等，Workers Cache 介入时有 |

`x-favicon-cache` 说明这次响应的来路：

- `FRESH` —— 命中 `ico:now`，直接返回，零上游请求
- `STALE` —— 命中 `ico:last` 返回旧图（可能正在后台刷新）
- `MISS` —— 实时抓取成功
- `FALLBACK` —— 实时抓取失败且没有任何存档，返回生成的字母方块

响应还带 `cache-tag: ico, ico:<host>`，可以按站点精确清除边缘缓存。

### 错误

错误统一返回 JSON。

| 状态码 | code | 原因 |
|:--|:--|:--|
| 400 | `INVALID_URL` | 缺少 `url`，或网址不可用 |
| 403 | `BLOCKED_HOST` | 目标是内网 / 本地地址 |
| 403 | `REFERER_NOT_ALLOWED` | 调用方（Origin / Referer）不在白名单里 |
| 405 | `METHOD_NOT_ALLOWED` | 方法不是 `GET` / `HEAD` / `OPTIONS` |

## 缓存分层

一个请求要穿过三层，每层各自挡掉一部分流量:

```
  GET /?url=…
        │
        ▼
  ┌─────────────────────────────────┐
  │ default 入口（网关，不缓存）      │  方法 → 调用方白名单（Origin/Referer）→ 目标校验
  └───────────────┬─────────────────┘
                  │ ctx.exports.Favicon.fetch(…, { cf: { cacheKey } })
                  ▼
  ┌─────────────────────────────────┐
  │ Workers Cache（边缘）            │  命中时 Worker 整个不执行，连 KV 都不读
  └───────────────┬─────────────────┘
                  │ 未命中
  ┌─────────────────────────────────┐
  │ Favicon 入口（缓存开启）          │  读 KV → 抓上游 → 写 KV，同一 host
  └───────────────┬─────────────────┘  的并发请求在这里被合并成一次
                  ▼
  ┌─────────────────────────────────┐
  │ Workers KV                      │  ico:now / ico:last / fail:
  └─────────────────────────────────┘
```

**为什么拆成两个入口？** Workers Cache 的缓存键只由「入口 + 路径与查询串 +
Worker 版本」组成，**不含 Referer / Origin**。如果把白名单校验放进被缓存的那一层：

- 未授权的调用方能直接拿到缓存图；
- 某次合法的 403 会被缓存下来，之后所有人都收到 403。

所以网关永远不缓存（每次请求都跑校验），只把校验过的请求转交给被缓存的
`Favicon` 入口——就是 ScreenShot 项目验证过的「网关 + 出图层」结构。

**缓存键是什么？** 网关把 `o`（目标 origin）、`s`（尺寸）、`r`（是否强制重抓）
编进内部 URL 的查询串，路径与查询串**就是**缓存键：

- 同一个站点的不同页面路径共享一条缓存 —— 图标本来就是按站点解析的；
- `r=1` 独立成键，且响应带 `Cache-Control: no-store`，永远不入缓存，
  所以每次强制刷新都是真的重新抓；
- Worker 版本默认也是键的一部分：每次部署边缘缓存清空，图标还在 KV 里，
  **不会**引发回源风暴。

**要开吗？** `WORKERS_CACHE=1`（默认）时网关走 `ctx.exports` 的 loopback 转发，
Workers Cache 才有机会介入。部署后看一眼 `cf-cache-status` 响应头：出现
`HIT` 说明边缘层已接住热流量；如果一直是 `MISS`（个别账号/版本组合
不生效），把它改成 `0` 即可——Worker 的行为完全不变，只是少了边缘那一层。

## 存储

图标存在 Workers KV 里，**一个站点两个键**：

| 键 | TTL | 什么时候写 |
|:--|:--:|:--|
| `ico:now:<host>` | 随机 3–7 天 | 每次成功抓取 |
| `ico:last:<host>` | 永不过期 | 每次成功抓取 |
| `fail:<host>` | 30 分钟 | 抓取失败时（负缓存） |

`ico:now` 的 TTL 是**每次写入重新随机**的，这样各站点的过期时刻天然错开，不会出现
一大批条目同时到期、同时回源的情况。

### 键里存的是什么

**Value 就是图标的原始字节**，没有任何包装。KV 的 value 直接存 `ArrayBuffer`，读的时候
也必须用 `type: "arrayBuffer"` —— 用 `type: "text"` 读会把所有不是合法 UTF-8 的字节
替换成 `�`，图片直接损坏。

**Metadata** 放图标之外的信息：

```json
{ "ct": "image/svg+xml", "src": "html",
  "url": "https://developer.mozilla.org/favicon.svg" }
```

| 字段 | 含义 |
|:--|:--|
| `ct` | 魔数嗅探出的真实内容类型 |
| `src` | 来源：`html` / `favicon.ico` / `ddg` / `google` / `generated` |
| `url` | 图标字节实际从哪个绝对地址取到的 |

`fail:<host>` 存的是失败原因（一段文本），同样是 30 分钟 TTL。

### 读取流程

Workers Cache 命中时，下面的流程整个不会发生（Worker 连跑都不跑）。边缘未命中，
Worker 里的顺序是：

```
ico:now 命中 ─────────────────────────────→ 返回                 [FRESH]
      ↓ 未命中
fail:<host> 命中 → 直接走兜底，不碰上游    ─→ 返回                 [STALE / FALLBACK]
      ↓ 未命中
ico:last 命中 → 立刻返回旧图 + 后台异步刷新 ─→ 返回                 [STALE]
      ↓ 未命中
同步抓上游
  成功 → 写 ico:now（3–7 天随机）+ ico:last（永久）→ 返回           [MISS]
  失败 → 写 fail:<host>（30 分钟）→ 兜底
```

三条设计上的取舍：

- **只有成功抓到的真图标才入库。** 生成的字母方块从不写 KV，所以它不可能覆盖任何
  已经存着的真图标——不需要额外的「防降级」逻辑。
- **失败要负缓存。** `fail:<host>` 存在时直接跳过上游请求。没有它的话，一个已经下线的
  站每次被访问都会重试一次，一天下来能烧掉不少上游的耐心。30 分钟后自动解禁，
  站点恢复了就能重新抓到。
- **上游挂掉时先给旧图。** `ico:now` 过期而 `ico:last` 还在，客户端立刻拿到旧图，
  不用等超时。

`ico:last` 永不过期，所以命名空间会随着查询过的站点持续增长。免费额度 1GB 大约能装
5 万站点（均 20KB），超出后转付费版 $0.50/GB-月。清理脚本见下面的「运维」。

## 安全

接口会按调用方给的地址去抓取，所以每一次出网请求发出前都要过一遍检查：

- 只允许 `http:` 和 `https:`，带账号密码的 URL 一律拒绝
- 回环、内网（`10/8`、`172.16/12`、`192.168/16`）、CGNAT、链路本地、组播等保留段全部
  拒绝，IPv4 和 IPv6 都覆盖
- `localhost`、`*.localhost`、`*.local`、`*.internal` 拒绝
- **域名解析后再查一遍**：Workers 没有 DNS API，这里走 Cloudflare 的 DoH
  （`cloudflare-dns.com/dns-query`），挡住「域名指向内网」这种绕过。解析失败时放行
  （宁可少拦一次，也不要让接口彻底不可用），查询本身有超时且不占用请求总预算
- 重定向手动跟随，**每一跳都重新校验**，防止用 302 绕进内网
- 响应体有上限（HTML 2 MB、图标 256 KB），超了立刻断掉上游连接
- 整次解析共享一个总截止时间，慢站点拖不垮接口

## 部署

```bash
npm install
npx wrangler login
npm run kv:create    # 创建 KV namespace，并把真实 id 写进 wrangler.jsonc
npm run deploy
```

`wrangler login` 会给一个 URL，在本地浏览器完成授权（服务器 / SSH 环境同样适用）。

### 部署后验证

```bash
curl -sD - -o favicon.png "https://favicon-api.<你的子域>.workers.dev/?url=https://github.com"
```

| 看什么 | 期望 |
|:--|:--|
| `content-type` | 真实图片类型（魔数嗅探过的） |
| `x-favicon-cache` | 第一次 `MISS`，紧接着再请求是 `FRESH` |
| `cf-cache-status` | 边缘层出现 `HIT`；edge 副本过期（10–60 分钟）后会先再现一次 `MISS` |

### 排查

- **`cf-cache-status` 一直是 `MISS`** —— Workers Cache 没有介入（个别账号/版本组合
  不生效）。把 `WORKERS_CACHE` 改成 `"0"` 再 deploy：Worker 行为完全不变，只是没了
  边缘那一层。
- **403 `REFERER_NOT_ALLOWED`** —— 检查 `HOSTS`；服务端脚本调用要配
  `ALLOW_EMPTY_REFERER=1`。
- **KV 一直空** —— 带 `wrangler tail` 看实时日志，多半是目标站点出网被墙或超时预算
  耗尽，`x-favicon-reason` 里会写明原因。

## 配置

所有配置都在 `wrangler.jsonc` 的 `vars` 里，改配置不用动代码。

| 变量 | 默认值 | 说明 |
|:--|:--|:--|
| `HOSTS` | *(空)* | 允许调用接口的站点，逗号分隔，**同时比对 Origin 和 Referer**。留空表示不限制 |
| `ALLOW_EMPTY_REFERER` | `0` | 设为 `1` 允许既没有 Origin 也没有 Referer 的请求 |
| `WORKERS_CACHE` | `1` | 设为 `1` 走 `ctx.exports` loopback，让 Workers Cache 缓存出图层；边缘不生效时改 `0` 降级 |
| `ALLOW_PRIVATE_HOSTS` | `0` | 设为 `1` 允许抓取本机 / 内网地址 |
| `ALLOWED_PORTS` | `80,443` | 允许的端口，逗号分隔；`*` 表示任意端口 |
| `MAX_REDIRECTS` | `5` | 最大重定向次数 |
| `KV_EDGE_TTL_SECONDS` | `3600` | KV 读请求的边缘缓存时长，也决定新图标最多多久全球可见 |
| `MAX_ICON_BYTES` | `262144` | 图标体积上限 |
| `MAX_HTML_BYTES` | `2097152` | 参与解析的 HTML 体积上限 |
| `FETCH_TIMEOUT_MS` | `8000` | 单次解析的总预算 |

> **调用方白名单**。`HOSTS` 默认留空，也就是谁都能用。浏览器嵌 `<img src="…">`
> 会带页面域名当 Referer，页面里的 `fetch()` 跨域时带的是 Origin —— 两个头都会比对。
> `example.com` 匹配自身和所有子域，`*.example.com` 只匹配子域。
> 服务端脚本调用两个头都不带，那种场景要么别设 `HOSTS`，要么配
> `ALLOW_EMPTY_REFERER=1`，否则会被 403 挡掉。

## 运维

`ico:now` 靠 TTL 自己回收，`ico:last` 需要手动清理。`wrangler kv key list` 能直接看
到每个条目的来源：

```bash
npx wrangler kv key list --namespace-id <id> --prefix ico:last:
```

```json
{
  "name": "ico:last:developer.mozilla.org",
  "metadata": {
    "ct": "image/svg+xml",
    "src": "html",
    "url": "https://developer.mozilla.org/favicon.svg"
  }
}
```

清理脚本：

```bash
npm run kv:gc -- --prefix ico:last: --older-than 30d          # 只报告
npm run kv:gc -- --prefix ico:last: --older-than 30d --delete  # 真删
npm run kv:gc -- --local --older-than 30d                      # 本地开发数据
```

注意 `wrangler kv key list` 和 `wrangler kv key delete` 都是计费操作，所以脚本默认只报告，
加了 `--delete` 才动手。

## 测试

```bash
npm test
```

测试跑在真实的 Workers 运行时里（[`@cloudflare/vitest-plugin`](https://github.com/cloudflare/workers-sdk)），
所以 `HTMLRewriter` 和 KV 的行为跟线上完全一致。出网请求由
[`@msw/cloudflare`](https://github.com/mswjs/msw) 拦截，测试不会访问公网。

## License

MIT。`entities.ts`（HTML 实体解码）等少数模块移植自
[site-info-api](https://github.com/xaoxuu/site-info-api)，按其 MIT 许可保留
`Copyright (c) 2022 Mr. X` 的版权声明；其余为本项目重写。
