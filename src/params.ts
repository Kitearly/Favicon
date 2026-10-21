/**
 * 请求参数。
 *
 * 网关和被缓存的那一层共用这一套定义：网关把参数编码进内部 URL，
 * 内层再从 URL 里读回来，两边看到的永远是同一份。
 */

/** 默认的图标尺寸。 */
export const DEFAULT_SIZE = 64;

/** 允许的最小尺寸。 */
export const MIN_SIZE = 16;

/** 允许的最大尺寸。 */
export const MAX_SIZE = 256;

/** 解析图标尺寸，非法值退回默认值。 */
export function parseSize(raw: string | null): number {
  if (raw === null) return DEFAULT_SIZE;

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_SIZE;
  return Math.min(MAX_SIZE, Math.max(MIN_SIZE, parsed));
}

/** 是否要求强制重新抓取。 */
export function isRefresh(raw: string | null): boolean {
  return raw === "1" || raw === "true";
}

/**
 * 拼出内部 URL。
 *
 * 路径与查询串**就是**缓存键的 URL 部分：入口 + 路径/查询 + Worker 版本。
 * 网关把它原样交给 `cf.cacheKey`，两边永远一致 —— 即使 `cf` 对象因为
 * 任何原因被丢弃，默认键也不会变。
 *
 * - `o` 目标站点的 origin（路径被忽略，scheme 与端口保留）
 * - `s` 图标尺寸
 * - `r` 是否强制重抓
 *
 * `r` 必须单独成键，否则 `?refresh=1` 会命中普通请求的缓存条目。
 */
export function buildInternalUrl(origin: string, size: number, refresh: boolean): URL {
  const url = new URL("https://favicon.internal/");
  url.searchParams.set("o", origin);
  url.searchParams.set("s", String(size));
  url.searchParams.set("r", refresh ? "1" : "0");
  return url;
}
