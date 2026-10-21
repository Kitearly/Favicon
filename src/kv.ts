/**
 * KV persistence layer.
 *
 * Two keys per site:
 *
 *   ico:now:<host>   the latest icon, expires after a random 3 to 7 days
 *   ico:last:<host>  the last successfully fetched icon, never expires
 *
 * The value is the raw image bytes; everything else lives in the KV metadata.
 */

import type { Env, FaviconMeta, FaviconSource } from "./types";

/** Key of the most recent icon. */
export const KEY_NOW = "ico:now:";

/** Key of the last successfully fetched icon. */
export const KEY_LAST = "ico:last:";

/** Key of the negative cache: the host failed and must not be retried yet. */
export const KEY_FAIL = "fail:";

/** Shortest lifetime of `ico:now`, in seconds (3 days). */
const NOW_TTL_MIN = 3 * 24 * 3_600;

/** Longest lifetime of `ico:now`, in seconds (7 days). */
const NOW_TTL_MAX = 7 * 24 * 3_600;

/** Build the key of the most recent icon. */
export function kvKeyNow(host: string): string {
  return `${KEY_NOW}${host.toLowerCase()}`;
}

/** Build the key of the last successfully fetched icon. */
export function kvKeyLast(host: string): string {
  return `${KEY_LAST}${host.toLowerCase()}`;
}

/** Build the key of the negative cache. */
export function kvKeyFail(host: string): string {
  return `${KEY_FAIL}${host.toLowerCase()}`;
}

/**
 * Read the negative cache. Its presence means the host failed recently and
 * must not be contacted again.
 */
export async function readFail(env: Env, key: string): Promise<string | null> {
  try {
    return await env.FAVICON_KV.get(key, { type: "text" });
  } catch {
    return null;
  }
}

/** Write the negative cache. The value is the reason of the failure. */
export async function writeFail(
  env: Env,
  key: string,
  reason: string,
  ttlSeconds: number,
): Promise<boolean> {
  try {
    await env.FAVICON_KV.put(key, reason.slice(0, 200), {
      expirationTtl: Math.max(60, Math.floor(ttlSeconds)),
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * A random lifetime for `ico:now`, between 3 and 7 days.
 *
 * The randomness spreads the moments at which sites are fetched again, so a
 * whole batch of entries never expires at the same time.
 */
export function randomNowTtlSeconds(): number {
  return NOW_TTL_MIN + Math.floor(Math.random() * (NOW_TTL_MAX - NOW_TTL_MIN + 1));
}

/** An icon as it comes out of the store. */
export interface StoredIcon {
  /** Raw icon bytes. */
  bytes: Uint8Array;
  /** Everything that is known about the icon besides its bytes. */
  meta: FaviconMeta;
}

const SOURCES: FaviconSource[] = ["html", "favicon.ico", "ddg", "google", "generated"];

/** Validate the metadata of a stored icon. */
function parseMeta(raw: unknown): FaviconMeta | null {
  if (!raw || typeof raw !== "object") return null;

  const meta = raw as Partial<FaviconMeta>;
  if (typeof meta.ct !== "string" || meta.ct === "") return null;
  if (typeof meta.url !== "string") return null;
  if (typeof meta.src !== "string" || !SOURCES.includes(meta.src as FaviconSource)) return null;

  return { ct: meta.ct, src: meta.src as FaviconSource, url: meta.url };
}

/**
 * Read an icon.
 *
 * The value has to be read as an `arrayBuffer`: reading it as text would
 * replace every byte that is not valid UTF-8 and destroy the image.
 */
export async function readIcon(
  env: Env,
  key: string,
  edgeTtlSeconds: number,
): Promise<StoredIcon | null> {
  let result: { value: ArrayBuffer | null; metadata: unknown };
  try {
    result = await env.FAVICON_KV.getWithMetadata(key, {
      type: "arrayBuffer",
      cacheTtl: edgeTtlSeconds,
    });
  } catch {
    return null;
  }

  if (!result.value) return null;

  const meta = parseMeta(result.metadata);
  if (meta === null) return null;

  return { bytes: new Uint8Array(result.value), meta };
}

function isRateLimited(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("429") || message.includes("Too Many Requests");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Write an icon.
 *
 * @param ttlSeconds lifetime of the entry, or null for "never expires"
 *
 * KV allows a single write per key per second, so a rate limited write is
 * retried with a short backoff. Failing to persist is never fatal for the
 * request that triggered the write.
 */
export async function writeIcon(
  env: Env,
  key: string,
  bytes: Uint8Array,
  meta: FaviconMeta,
  ttlSeconds: number | null,
): Promise<boolean> {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);

  const options =
    ttlSeconds === null
      ? { metadata: meta }
      : { metadata: meta, expirationTtl: Math.max(60, Math.floor(ttlSeconds)) };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await env.FAVICON_KV.put(key, buffer, options);
      return true;
    } catch (error) {
      if (!isRateLimited(error) || attempt === 2) return false;
      await delay(200 * 2 ** attempt);
    }
  }

  return false;
}
