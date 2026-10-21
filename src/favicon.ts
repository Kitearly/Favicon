/**
 * 被缓存的那一层。
 *
 * Workers Cache 在这个入口前面接管：命中时 Worker 根本不执行，连 KV 都不读。
 * 未命中才会跑下面的逻辑。
 *
 * 入口自己不知道调用方是谁 —— 白名单校验在网关（`src/index.ts`）里，
 * 那一层不缓存，每次都跑。
 */

import { WorkerEntrypoint } from "cloudflare:workers";
import { loadConfig } from "./config";
import {
  kvKeyFail,
  kvKeyLast,
  kvKeyNow,
  randomNowTtlSeconds,
  readFail,
  readIcon,
  writeFail,
  writeIcon,
  type StoredIcon,
} from "./kv";
import { generateFallback, resolveFavicon } from "./resolve";
import { isRefresh, parseSize } from "./params";
import { CORS_HEADERS, describe, errorResponse } from "./respond";
import type { CacheState, Env, FaviconMeta, ResolvedFavicon } from "./types";
import { assertFetchableUrl, InvalidUrlError, validateUrl } from "./url";

/**
 * 负缓存时长（秒）：目标站失败后多久之内不再重试。
 *
 * 没有它的话，一个已经下线的站每次被访问都会重试一次，
 * 一天下来能烧掉不少上游的耐心。
 */
const FAIL_TTL_SECONDS = 1_800;

/**
 * 边缘 `max-age` 的范围（秒），每次响应随机取一个。
 *
 * 必须**远小于**有效期窗口：边缘副本过期后才会回头问源站，
 * 固定值会把随机错开的到期时间重新量化到同一格上，
 * 一批 host 又会挤到同一刻去回源。10~60 分钟相对 4 天的窗口可以忽略，
 * 而且每次都随机，边缘的再验证网格自己会漂。
 */
const EDGE_MIN = 600;
const EDGE_MAX = 3_600;

/** 边缘上源站报错时，继续用旧副本的窗口（秒）。 */
const STALE_IF_ERROR = 86_400;

export class Favicon extends WorkerEntrypoint<Env> {
  override async fetch(request: Request): Promise<Response> {
    const { env, ctx } = this;
    const config = loadConfig(env);

    const params = new URL(request.url).searchParams;

    // 网关已经把目标规范化成了 origin，这里只认它。
    const origin = params.get("o") ?? "";
    const size = parseSize(params.get("s"));
    const refresh = isRefresh(params.get("r"));

    const target = validateUrl(origin, config.allowedPorts);
    if (!target) {
      return errorResponse(400, "INVALID_URL", "Missing or unusable target.");
    }
    try {
      assertFetchableUrl(target, config.allowedPorts, config.allowPrivateHosts);
    } catch (error) {
      if (error instanceof InvalidUrlError) {
        return errorResponse(400, "INVALID_URL", error.message);
      }
      return errorResponse(403, "BLOCKED_HOST", describe(error));
    }

    const page = new URL(`${target.origin}/`);
    const host = target.host;
    const nowKey = kvKeyNow(host);
    const lastKey = kvKeyLast(host);
    const failKey = kvKeyFail(host);

    // 1) 当前这一份还在就直接用 —— 键存在本身就等于「还新鲜」。
    if (!refresh) {
      const fresh = await readIcon(env, nowKey, config.edgeTtlSeconds);
      if (fresh !== null) {
        return imageResponse(fresh, "FRESH", host, request.method, undefined, refresh);
      }
    }

    // 2) 负缓存：这个 host 刚失败过，别再烧上游的耐心了。
    const failure = refresh ? null : await readFail(env, failKey);
    if (failure !== null) {
      return fallback(env, lastKey, host, failure, request.method, refresh);
    }

    // 3) 没有当前份，但有最后一次成功抓到的：先把它交出去，同时后台刷新。
    const last = await readIcon(env, lastKey, config.edgeTtlSeconds);
    if (last !== null && !refresh) {
      ctx.waitUntil(
        refreshInBackground(env, nowKey, lastKey, failKey, page, config, size).catch(
          () => undefined,
        ),
      );
      return imageResponse(last, "STALE", host, request.method, undefined, refresh);
    }

    // 4) 什么都没有了，只能去抓一次。
    let resolved: ResolvedFavicon;
    try {
      resolved = await resolveFavicon(page, {
        size,
        maxHtmlBytes: config.maxHtmlBytes,
        maxIconBytes: config.maxIconBytes,
        timeoutMs: config.fetchTimeoutMs,
        maxRedirects: config.maxRedirects,
        allowedPorts: config.allowedPorts,
        allowPrivateHosts: config.allowPrivateHosts,
      });
    } catch (error) {
      await writeFail(env, failKey, describe(error), FAIL_TTL_SECONDS);
      return fallback(env, lastKey, host, describe(error), request.method, refresh);
    }

    // 生成的字母方块是最后手段，而且从不入库 —— 所以它不可能覆盖任何真图标。
    if (resolved.source === "generated") {
      await writeFail(env, failKey, "no icon found", FAIL_TTL_SECONDS);
      return fallback(env, lastKey, host, "no icon found", request.method, refresh);
    }

    const meta: FaviconMeta = {
      ct: resolved.contentType,
      src: resolved.source,
      url: resolved.finalUrl,
    };

    ctx.waitUntil(
      storeIcon(env, nowKey, lastKey, resolved.bytes, meta).catch(() => undefined),
    );

    return imageResponse(
      { bytes: resolved.bytes, meta },
      "MISS",
      host,
      request.method,
      undefined,
      refresh,
    );
  }
}

/**
 * 兜底：最后一次成功抓到的图标，没有就返回生成的字母方块。
 */
async function fallback(
  env: Env,
  lastKey: string,
  host: string,
  reason: string,
  method: string,
  refresh: boolean,
): Promise<Response> {
  const last = await readIcon(env, lastKey, 60);
  if (last !== null) {
    return imageResponse(last, "STALE", host, method, reason, refresh);
  }

  const generated = generateFallback(host);
  return imageResponse(
    {
      bytes: generated.bytes,
      meta: { ct: generated.contentType, src: "generated", url: generated.finalUrl },
    },
    "FALLBACK",
    host,
    method,
    reason,
    refresh,
  );
}

/** Store an icon under both keys. The permanent copy is written first. */
async function storeIcon(
  env: Env,
  nowKey: string,
  lastKey: string,
  bytes: Uint8Array,
  meta: FaviconMeta,
): Promise<void> {
  await writeIcon(env, lastKey, bytes, meta, null);
  await writeIcon(env, nowKey, bytes, meta, randomNowTtlSeconds());
}

/**
 * Refresh a stale icon in the background.
 *
 * When the site cannot be reached the host goes into the negative cache, so
 * the next requests do not all try again at once.
 */
async function refreshInBackground(
  env: Env,
  nowKey: string,
  lastKey: string,
  failKey: string,
  page: URL,
  config: ReturnType<typeof loadConfig>,
  size: number,
): Promise<void> {
  let resolved: ResolvedFavicon;
  try {
    resolved = await resolveFavicon(page, {
      size,
      maxHtmlBytes: config.maxHtmlBytes,
      maxIconBytes: config.maxIconBytes,
      timeoutMs: config.fetchTimeoutMs,
      maxRedirects: config.maxRedirects,
      allowedPorts: config.allowedPorts,
      allowPrivateHosts: config.allowPrivateHosts,
    });
  } catch (error) {
    await writeFail(env, failKey, describe(error), FAIL_TTL_SECONDS);
    return;
  }

  if (resolved.source === "generated") {
    await writeFail(env, failKey, "no icon found", FAIL_TTL_SECONDS);
    return;
  }

  const meta: FaviconMeta = {
    ct: resolved.contentType,
    src: resolved.source,
    url: resolved.finalUrl,
  };

  await writeIcon(env, lastKey, resolved.bytes, meta, null);
  await writeIcon(env, nowKey, resolved.bytes, meta, randomNowTtlSeconds());
}

/** Build the response that carries the icon. */
function imageResponse(
  icon: StoredIcon,
  state: CacheState,
  host: string,
  method: string,
  reason: string | undefined,
  refresh: boolean,
): Response {
  const headers = new Headers({
    "content-type": icon.meta.ct,
    "cache-control": refresh
      ? "no-store"
      : `public, max-age=${edgeMaxAge()}, stale-if-error=${STALE_IF_ERROR}`,
    "cache-tag": `ico, ico:${host}`,
    "x-favicon-source": icon.meta.src,
    "x-favicon-final-url": icon.meta.url,
    "x-favicon-cache": state,
    ...CORS_HEADERS,
  });
  if (reason) headers.set("x-favicon-reason", reason.slice(0, 200));

  return new Response(method === "HEAD" ? null : icon.bytes, { headers });
}

/** 边缘缓存时长：每次响应随机取一个，让边缘的再验证网格自己漂移。 */
function edgeMaxAge(): number {
  return EDGE_MIN + Math.floor(Math.random() * (EDGE_MAX - EDGE_MIN));
}

