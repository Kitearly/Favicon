/**
 * Fetching an upstream resource.
 *
 * Redirects are followed manually so that every hop can be validated again —
 * a redirect must not be able to lead to an address that is off limits.
 */

import { assertFetchableUrl, assertPublicHost } from "./url";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Options for {@link fetchResource}. */
export interface FetchOptions {
  /** Timestamp (ms) after which no further request may be started. */
  deadline: number;
  /** Maximum duration of a single request, in milliseconds. */
  timeoutMs: number;
  /** Maximum size of the response body, in bytes. */
  maxBytes: number;
  /** Maximum number of redirects that are followed. */
  maxRedirects: number;
  /** Ports that may be used, or null for any port. */
  allowedPorts: string[] | null;
  /** Whether private and loopback addresses may be fetched. */
  allowPrivateHosts: boolean;
  /** Request headers. */
  headers: Record<string, string>;
}

/** The outcome of a fetch. */
export interface FetchedResource {
  /** Whether the resource was loaded. */
  ok: boolean;
  /** Status code to report when it was not. */
  status: number;
  /** A short description of the problem. */
  message: string;
  /** The response body. */
  bytes?: Uint8Array;
  /** The content type the upstream declared. */
  contentType?: string | null;
  /** The URL the body was finally loaded from. */
  finalUrl?: string;
}

/** Read a body, stopping after `maxBytes`. */
async function readCapped(
  response: Response,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const declared = response.headers.get("content-length");
  const length = declared === null ? Number.NaN : Number(declared);

  if (Number.isFinite(length) && length > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    return { bytes: new Uint8Array(0), truncated: true };
  }

  if (!response.body) {
    return { bytes: new Uint8Array(0), truncated: false };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;

    total += value.byteLength;
    chunks.push(value);

    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return { bytes: new Uint8Array(0), truncated: true };
    }
  }

  let size = 0;
  for (const chunk of chunks) size += chunk.byteLength;
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return { bytes, truncated: false };
}

/**
 * Fetch a URL, following redirects within the given budget.
 */
export async function fetchResource(
  url: URL,
  options: FetchOptions,
): Promise<FetchedResource> {
  let target = new URL(url.toString());
  let remainingRedirects = options.maxRedirects;

  for (;;) {
    try {
      assertFetchableUrl(target, options.allowedPorts, options.allowPrivateHosts);
    } catch (error) {
      const status = error instanceof Error && error.name === "BlockedHostError" ? 403 : 400;
      return {
        ok: false,
        status,
        message: error instanceof Error ? error.message : String(error),
      };
    }

    const remaining = options.deadline - Date.now();
    if (remaining <= 0) {
      return { ok: false, status: 504, message: "timeout" };
    }

    // The host name is resolved and checked again here, so that a domain
    // pointing at a private address cannot be used to reach the inside.
    // The lookup may claim at most half of what is left of the budget, so a
    // slow resolver can never eat the whole request.
    const publicHost = await assertPublicHost(target, Math.floor(remaining / 2));
    if (!publicHost.ok) {
      return { ok: false, status: 403, message: publicHost.reason };
    }

    const timeout = Math.min(options.timeoutMs, remaining);

    let response: Response;
    try {
      response = await fetch(target.toString(), {
        method: "GET",
        headers: options.headers,
        redirect: "manual",
        signal: AbortSignal.timeout(timeout),
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      if (name === "TimeoutError" || name === "AbortError") {
        return { ok: false, status: 504, message: "timeout" };
      }
      return {
        ok: false,
        status: 502,
        message: "fetch error: " + (error instanceof Error ? error.message : String(error)),
      };
    }

    const location = response.headers.get("location");
    if (REDIRECT_STATUSES.has(response.status) && location) {
      await response.body?.cancel().catch(() => undefined);

      let next: URL;
      try {
        next = new URL(location, target);
      } catch {
        return { ok: false, status: 502, message: "invalid redirect location" };
      }

      if (next.href === target.href) {
        return { ok: false, status: 502, message: "redirect loop" };
      }
      if (remainingRedirects <= 0) {
        return { ok: false, status: 502, message: "too many redirects" };
      }

      remainingRedirects -= 1;
      target = next;
      continue;
    }

    if (response.status >= 400) {
      await response.body?.cancel().catch(() => undefined);
      return { ok: false, status: 502, message: `upstream status ${response.status}` };
    }

    const { bytes, truncated } = await readCapped(response, options.maxBytes);
    if (truncated) {
      return { ok: false, status: 502, message: "response too large" };
    }

    return {
      ok: true,
      status: 200,
      message: "",
      bytes,
      contentType: response.headers.get("content-type"),
      finalUrl: target.href,
    };
  }
}
