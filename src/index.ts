/**
 * 网关。
 *
 * 这一层**不缓存**（见 wrangler.jsonc 的 `exports.default.cache`），每次请求都会跑。
 *
 * Workers Cache 的缓存键不含 Referer / Origin，所以调用方白名单必须放在这里：
 * 放进被缓存的那一层的话，未授权的调用方能直接拿到缓存图，
 * 某次合法的 403 也会被缓存下来发给所有人。
 *
 * 校验通过后，把请求转交给被缓存的 `Favicon` 入口
 * （见 `src/favicon.ts`），转发用的内部 URL 把 origin、尺寸和
 * refresh 标记编进查询串 —— 路径与查询串**就是** Workers Cache 的键。
 */

import { Favicon } from "./favicon";
import { loadConfig } from "./config";
import { buildInternalUrl, isRefresh, parseSize } from "./params";
import { CORS_HEADERS, describe, errorResponse } from "./respond";
import type { Env } from "./types";
import { isAllowedCaller, parseTarget, BlockedHostError } from "./url";

export { Favicon };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const config = loadConfig(env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: { ...CORS_HEADERS } });
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return errorResponse(405, "METHOD_NOT_ALLOWED", "Only GET, HEAD and OPTIONS are supported.");
    }

    if (!isAllowedCaller(request, config.hosts, config.allowEmptyReferer)) {
      return errorResponse(
        403,
        "REFERER_NOT_ALLOWED",
        "This service is restricted to the configured hosts.",
      );
    }

    const requestUrl = new URL(request.url);

    let target: URL;
    try {
      target = parseTarget(
        requestUrl.searchParams.get("url"),
        config.allowedPorts,
        config.allowPrivateHosts,
      );
    } catch (error) {
      if (error instanceof BlockedHostError) {
        return errorResponse(403, "BLOCKED_HOST", describe(error));
      }
      return errorResponse(400, "INVALID_URL", describe(error));
    }

    const size = parseSize(requestUrl.searchParams.get("size"));
    const refresh = isRefresh(requestUrl.searchParams.get("refresh"));

    const internalRequest = new Request(
      buildInternalUrl(target.origin, size, refresh).toString(),
      request,
    );

    // WORKERS_CACHE=1 时走 `ctx.exports` 的 loopback 转发，Workers Cache 才有机会
    // 在这一层接管条目；转发初始化里的 `cf.cacheKey` 与内部 URL 自身的
    // 路径/查询串一致，两者给的是同一个键。
    //
    // 其他情况（如本地测试无法注入环境变量的入口）退回进程内直接调用：
    // 逻辑与响应完全一样，只是没有边缘缓存这一层。
    if (config.workersCache) {
      const binding = ctx.exports?.Favicon;
      if (binding) {
        return binding.fetch(internalRequest, {
          cf: { cacheKey: `${new URL(internalRequest.url).pathname}${new URL(internalRequest.url).search}` },
        });
      }
    }

    return new Favicon(ctx, env).fetch(internalRequest);
  },
};
