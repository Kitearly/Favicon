/**
 * Bindings and environment variables of the Worker.
 */
export interface Env {
  /** KV namespace holding the cached favicons. */
  FAVICON_KV: KVNamespace;
  /** Referer hosts that may use the API. Empty means "no restriction". */
  HOSTS?: string;
  /** Set to "1" to allow requests without a `Referer` header. */
  ALLOW_EMPTY_REFERER?: string;
  /** Set to "1" to allow fetching private and loopback addresses. */
  ALLOW_PRIVATE_HOSTS?: string;
  /** Ports that may be used, comma separated. `*` allows any port. */
  ALLOWED_PORTS?: string;
  /** Edge cache TTL applied to KV reads, in seconds. */
  KV_EDGE_TTL_SECONDS?: string;
  /** Maximum size of an icon payload, in bytes. */
  MAX_ICON_BYTES?: string;
  /** Maximum size of an HTML document that is parsed, in bytes. */
  MAX_HTML_BYTES?: string;
  /** Total budget for one resolution, in milliseconds. */
  FETCH_TIMEOUT_MS?: string;
  /** Maximum number of redirects that are followed. */
  MAX_REDIRECTS?: string;
  /**
   * Set to "1" to route the gateway through the `ctx.exports` loopback so that
   * Workers Cache can cache the inner entrypoint's responses.
   */
  WORKERS_CACHE?: string;
}

/** Where a favicon was obtained from. */
export type FaviconSource =
  | "html"
  | "favicon.ico"
  | "ddg"
  | "google"
  | "generated";

/** How the served icon relates to the store. */
export type CacheState = "FRESH" | "STALE" | "MISS" | "FALLBACK";

/**
 * Everything about a stored icon that is not the icon itself.
 *
 * It is kept in the KV metadata so that the value can stay raw image bytes.
 */
export interface FaviconMeta {
  /** Sniffed content type of the payload. */
  ct: string;
  /** Where the icon came from. */
  src: FaviconSource;
  /** Absolute URL the payload was fetched from. */
  url: string;
}

/** An icon that may be fetched. */
export interface IconCandidate {
  /** Absolute URL of the icon. */
  url: string;
  /** Lower is better. */
  score: number;
  /** Where this candidate comes from. */
  source: FaviconSource;
}

/** A favicon that was successfully resolved. */
export interface ResolvedFavicon {
  /** Raw icon bytes. */
  bytes: Uint8Array;
  /** Sniffed content type. */
  contentType: string;
  /** Where the icon came from. */
  source: FaviconSource;
  /** Absolute URL the bytes were fetched from. */
  finalUrl: string;
}
