import type { Env } from "./types";

/** Runtime configuration, derived from the environment variables. */
export interface Config {
  /** Referer hosts that may use the API. Empty means "no restriction". */
  hosts: string[];
  /** Whether requests without a referer are accepted. */
  allowEmptyReferer: boolean;
  /** Whether private and loopback addresses may be fetched. */
  allowPrivateHosts: boolean;
  /**
   * Whether the gateway forwards through the `ctx.exports` loopback so that
   * Workers Cache can cache the inner entrypoint's responses.
   */
  /** Ports that may be used, or null for any port. */
  allowedPorts: string[] | null;
  /** Edge cache TTL applied to KV reads, in seconds. */
  edgeTtlSeconds: number;
  /** Maximum icon payload size, in bytes. */
  maxIconBytes: number;
  /** Maximum HTML document size, in bytes. */
  maxHtmlBytes: number;
  /** Total budget for one resolution, in milliseconds. */
  fetchTimeoutMs: number;
  /** Maximum number of redirects that are followed. */
  maxRedirects: number;
  /** Whether the gateway forwards through the Workers Cache loopback. */
  workersCache: boolean;
}

const DEFAULTS = {
  hosts: [] as string[],
  edgeTtlSeconds: 3_600,
  maxIconBytes: 262_144,
  maxHtmlBytes: 2_097_152,
  fetchTimeoutMs: 8_000,
  maxRedirects: 5,
} as const;

function flag(value: string | undefined): boolean {
  return value === "1" || value === "true";
}

function integer(value: string | undefined, fallback: number, minimum = 0): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < minimum) return fallback;
  return parsed;
}

function parseHosts(value: string | undefined): string[] {
  if (!value) return [...DEFAULTS.hosts];
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
}

function parsePorts(value: string | undefined): string[] | null {
  if (!value) return ["80", "443"];
  const trimmed = value.trim();
  if (trimmed === "*") return null;
  return trimmed
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
}

/** Read the configuration out of the environment. */
export function loadConfig(env: Env): Config {
  return {
    hosts: parseHosts(env.HOSTS),
    allowEmptyReferer: flag(env.ALLOW_EMPTY_REFERER),
    allowPrivateHosts: flag(env.ALLOW_PRIVATE_HOSTS),
    allowedPorts: parsePorts(env.ALLOWED_PORTS),
    edgeTtlSeconds: integer(env.KV_EDGE_TTL_SECONDS, DEFAULTS.edgeTtlSeconds),
    maxIconBytes: integer(env.MAX_ICON_BYTES, DEFAULTS.maxIconBytes, 1),
    maxHtmlBytes: integer(env.MAX_HTML_BYTES, DEFAULTS.maxHtmlBytes, 1),
    fetchTimeoutMs: integer(env.FETCH_TIMEOUT_MS, DEFAULTS.fetchTimeoutMs, 1),
    maxRedirects: integer(env.MAX_REDIRECTS, DEFAULTS.maxRedirects),
    workersCache: flag(env.WORKERS_CACHE),
  };
}
