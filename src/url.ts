/**
 * URL validation, safety checks and resolution.
 */

import { isIpLiteral, isPrivateAddress } from "./ip";

/** Thrown when the target is not a usable http(s) URL. */
export class InvalidUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidUrlError";
  }
}

/** Thrown when the target points at a host we refuse to talk to. */
export class BlockedHostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockedHostError";
  }
}

/** Host names that must never be fetched. */
export function isBlockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  );
}

/**
 * Validate an absolute URL.
 *
 * @param raw the raw value
 * @param allowedPorts the ports that may be used, or null for any port
 */
export function validateUrl(raw: unknown, allowedPorts: string[] | null): URL | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) return null;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!url.hostname) return null;
  if (url.username || url.password) return null;

  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  if (allowedPorts && !allowedPorts.includes(port)) return null;

  return url;
}

/**
 * Parse the target out of a query parameter. A missing scheme is filled in
 * with `https://`, so `example.com` works just as well as a full URL.
 *
 * @throws InvalidUrlError when the value is not a usable http(s) URL
 * @throws BlockedHostError when the target may not be contacted
 */
export function parseTarget(
  raw: unknown,
  allowedPorts: string[] | null,
  allowPrivateHosts: boolean,
): URL {
  if (typeof raw !== "string") {
    throw new InvalidUrlError("Missing the 'url' parameter.");
  }

  const trimmed = raw.trim();
  if (trimmed === "" || trimmed.length > 2048) {
    throw new InvalidUrlError(`'${raw}' is not a valid URL.`);
  }

  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new InvalidUrlError(`'${raw}' is not a valid URL.`);
  }

  assertFetchableUrl(url, allowedPorts, allowPrivateHosts);
  return url;
}

/**
 * Resolve a possibly relative URL against a base. Only plain http(s) URLs
 * without credentials are accepted.
 */
export function resolveUrl(raw: unknown, base: string): string | null {
  if (typeof raw !== "string") return null;

  const trimmed = raw.trim();
  if (trimmed === "" || trimmed.startsWith("#")) return null;

  let url: URL;
  try {
    url = new URL(trimmed, base);
  } catch {
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;

  return url.href;
}

/**
 * Check a host name before it is fetched.
 *
 * The original implementation also resolved the host name and inspected every
 * returned address. The Worker runtime has no DNS resolver, so only literal
 * addresses can be classified here.
 *
 * @returns an error message when the host must not be contacted
 */
export function checkHostSafety(hostname: string, allowPrivateHosts: boolean): string | null {
  if (isBlockedHostname(hostname)) return "blocked hostname";
  if (allowPrivateHosts) return null;

  const host = hostname.replace(/^\[|\]$/g, "");
  if (isIpLiteral(host) && isPrivateAddress(host)) return "blocked address";

  return null;
}

/**
 * Make sure a URL may be fetched. Throws `InvalidUrlError` for protocols and
 * ports we do not allow and `BlockedHostError` for hosts we refuse.
 */
export function assertFetchableUrl(
  url: URL,
  allowedPorts: string[] | null,
  allowPrivateHosts: boolean,
): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new InvalidUrlError(`Unsupported protocol "${url.protocol}".`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new InvalidUrlError("URLs carrying credentials are not allowed.");
  }

  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  if (allowedPorts && !allowedPorts.includes(port)) {
    throw new InvalidUrlError(`Port "${port}" is not allowed.`);
  }

  const problem = checkHostSafety(url.hostname, allowPrivateHosts);
  if (problem) throw new BlockedHostError(problem);
}

// ---------------------------------------------------------------------------
// Caller allow list
// ---------------------------------------------------------------------------

/**
 * Check the caller against the host allow list.
 *
 * Both `Origin` and `Referer` are inspected: a `fetch()` from a page sends
 * `Origin`, while an `<img src>` only sends `Referer`. `example.com` matches
 * itself and its subdomains; `*.example.com` matches subdomains only.
 *
 * An empty list means the API is open to everybody.
 */
export function isAllowedCaller(
  request: Request,
  hosts: string[],
  allowEmpty: boolean,
): boolean {
  if (hosts.length === 0) return true;

  let sawHeader = false;
  for (const header of [
    request.headers.get("origin"),
    request.headers.get("referer"),
  ]) {
    if (!header) continue;
    sawHeader = true;

    let host: string;
    try {
      host = new URL(header).hostname.toLowerCase();
    } catch {
      continue;
    }
    if (!host) continue;

    for (const domain of hosts) {
      if (host === domain) return true;
      // "*.example.com" matches any subdomain.
      if (domain.startsWith("*.") && host.endsWith(domain.slice(1))) return true;
      // "example.com" also matches its subdomains.
      if (host.endsWith(`.${domain}`)) return true;
    }
  }

  if (sawHeader) return false;
  return allowEmpty;
}

// ---------------------------------------------------------------------------
// DNS
// ---------------------------------------------------------------------------

/**
 * 解析结果在 isolate 内短暂缓存。
 *
 * 一次解析最多要查 2 个域名（页面 + 图标 CDN），每次都是两次 DoH 查询。
 * 60 秒的缓存足以把同一个站的重复查询合并掉，又短到不会明显削弱
 * 域名重绑定（DNS rebinding）的防护。
 */
const dnsMemo = new Map<string, { expires: number; ok: boolean; reason: string }>();

/** DNS 解析结果的缓存时长（毫秒）。 */
const DNS_MEMO_TTL_MS = 60_000;

/**
 * 单次 DNS 查询的超时（毫秒）。
 *
 * 解析器不可达时必须快速放弃 —— 查不通只是少拦一次，
 * 但挂住会把整个请求的预算耗光。
 */
const DNS_TIMEOUT_MS = 2_000;

/**
 * 解析域名并检查它是否落在私网，挡住「域名指向内网」这种绕过。
 *
 * Workers 运行时没有 DNS API，这里走 Cloudflare 的 DoH 接口。
 * 查询本身失败时放行 —— 宁可少拦一次，也不要让接口彻底不可用。
 */
export async function assertPublicHost(
  target: URL | string,
  timeoutMs: number = DNS_TIMEOUT_MS,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  let url: URL;
  try {
    url = new URL(target.toString());
  } catch {
    return { ok: false, reason: "invalid url" };
  }

  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  // IP 字面量已经在静态检查里处理过了。
  if (!host || host.includes(":") || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    return { ok: true };
  }

  const memo = dnsMemo.get(host);
  if (memo !== undefined && memo.expires > Date.now()) {
    return memo.ok ? { ok: true } : { ok: false, reason: memo.reason };
  }

  const budget = Math.max(250, timeoutMs);
  const [v4, v6] = await Promise.all([
    dnsLookup(host, "A", budget).catch(() => [] as string[]),
    dnsLookup(host, "AAAA", budget).catch(() => [] as string[]),
  ]);

  let reason = "";
  for (const ip of [...v4, ...v6]) {
    if (isPrivateAddress(ip)) {
      reason = `resolves to private address ${ip}`;
      break;
    }
  }

  const ok = reason === "";
  dnsMemo.set(host, { expires: Date.now() + DNS_MEMO_TTL_MS, ok, reason });
  return ok ? { ok: true } : { ok: false, reason };
}

/** 通过 Cloudflare 的 DoH 接口查询 A / AAAA 记录。 */
async function dnsLookup(
  host: string,
  type: "A" | "AAAA",
  timeoutMs: number,
): Promise<string[]> {
  const response = await fetch(
    `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`,
    {
      headers: { accept: "application/dns-json" },
      signal: AbortSignal.timeout(timeoutMs),
    },
  );
  if (!response.ok) return [];

  const body = (await response.json()) as { Answer?: { type?: number; data?: string }[] };
  const wanted = type === "A" ? 1 : 28;

  return (body.Answer ?? [])
    .filter((answer) => answer.type === wanted)
    .map((answer) => (answer.data ?? "").trim())
    .filter(Boolean);
}
