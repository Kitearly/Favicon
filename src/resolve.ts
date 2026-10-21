/**
 * Favicon resolution: find the best icon for a site.
 *
 * The chain is deliberately ordered from "declared by the page" down to "we
 * made it up", so that the most accurate icon wins:
 *
 *   P0  SVG declared in the HTML
 *   P1  apple-touch-icon
 *   P2  icon with an explicit size
 *   P3  shortcut icon / icon without a size
 *   P4  /favicon.ico
 *   P5  third party icon services
 *   P6  locally generated letter tile
 *
 * All requests of one resolution share a deadline, so a slow site can never
 * make the API hang: once the budget is gone the remaining candidates are
 * skipped and the generated tile is used.
 */

import { fetchResource } from "./fetch-site";
import { extractIconLinks, scoreIcon } from "./html";
import { sniffImageType } from "./sniff";
import type { FaviconSource, IconCandidate, ResolvedFavicon } from "./types";

const USER_AGENT =
  "Mozilla/5.0 (compatible; FaviconAPI/1.0; +https://github.com/Kitearly/Favicon) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const HTML_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
const IMAGE_ACCEPT = "image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8,*/*;q=0.8";

/** Maximum time one single upstream request may take. */
const HTML_FETCH_CAP_MS = 4_000;
const ICON_FETCH_CAP_MS = 2_500;

/** Options controlling a single resolution run. */
export interface ResolveOptions {
  /** Icon size requested from the third party fallbacks. */
  size: number;
  /** Maximum size of an HTML document to parse. */
  maxHtmlBytes: number;
  /** Maximum size of an icon payload. */
  maxIconBytes: number;
  /** Total budget for the whole resolution, in milliseconds. */
  timeoutMs: number;
  /** Maximum number of redirects that are followed. */
  maxRedirects: number;
  /** Ports that may be used, or null for any port. */
  allowedPorts: string[] | null;
  /** Whether private and loopback addresses may be fetched. */
  allowPrivateHosts: boolean;
}

/** Milliseconds left before the deadline, never negative. */
function remaining(deadline: number): number {
  return Math.max(0, deadline - Date.now());
}

function hashHue(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % 360;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Last resort: a generated tile carrying the first letter of the domain.
 * It always works, which is exactly the point of the fallback.
 */
export function generateFallback(hostname: string): ResolvedFavicon {
  const label = (hostname.replace(/^www\./, "")[0] ?? "?").toUpperCase();
  const hue = hashHue(hostname);

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="${escapeXml(label)}">` +
    `<rect width="64" height="64" rx="14" fill="hsl(${hue},65%,45%)"/>` +
    `<text x="32" y="43" text-anchor="middle" fill="#ffffff" font-size="34" font-weight="700" ` +
    `font-family="system-ui,-apple-system,'Segoe UI',Roboto,sans-serif">${escapeXml(label)}</text>` +
    `</svg>`;

  return {
    bytes: new TextEncoder().encode(svg),
    contentType: "image/svg+xml",
    source: "generated",
    finalUrl: `generated://${hostname}`,
  };
}

/** Fetch the document of a page and return it as text. */
async function fetchHtml(
  page: URL,
  options: ResolveOptions,
  deadline: number,
): Promise<string | null> {
  const budget = Math.min(HTML_FETCH_CAP_MS, remaining(deadline));
  if (budget <= 0) return null;

  const result = await fetchResource(page, {
    deadline,
    timeoutMs: budget,
    maxBytes: options.maxHtmlBytes,
    maxRedirects: options.maxRedirects,
    allowedPorts: options.allowedPorts,
    allowPrivateHosts: options.allowPrivateHosts,
    headers: {
      "user-agent": USER_AGENT,
      accept: HTML_ACCEPT,
      "accept-language": "en-US,en;q=0.9",
    },
  });

  if (!result.ok || !result.bytes) return null;

  const contentType = (result.contentType ?? "").toLowerCase();
  const isHtml =
    contentType === "" ||
    contentType.includes("text/html") ||
    contentType.includes("application/xhtml+xml");
  if (!isHtml) return null;

  return new TextDecoder().decode(result.bytes);
}

/** Fetch a single icon and verify that it really is an image. */
async function fetchIcon(
  url: string,
  options: ResolveOptions,
  deadline: number,
): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  const budget = Math.min(ICON_FETCH_CAP_MS, remaining(deadline));
  if (budget <= 0) return null;

  const result = await fetchResource(new URL(url), {
    deadline,
    timeoutMs: budget,
    maxBytes: options.maxIconBytes,
    maxRedirects: options.maxRedirects,
    allowedPorts: options.allowedPorts,
    allowPrivateHosts: options.allowPrivateHosts,
    headers: {
      "user-agent": USER_AGENT,
      accept: IMAGE_ACCEPT,
      "accept-language": "en-US,en;q=0.9",
    },
  });

  if (!result.ok || !result.bytes || result.bytes.byteLength === 0) return null;

  const contentType = sniffImageType(result.bytes, result.contentType);
  if (contentType === null) return null;

  return { bytes: result.bytes, contentType };
}

/** Build the ordered list of icons to try. */
async function collectCandidates(
  page: URL,
  options: ResolveOptions,
  deadline: number,
): Promise<IconCandidate[]> {
  const candidates: IconCandidate[] = [];

  const html = await fetchHtml(page, options, deadline);
  if (html !== null) {
    const links = await extractIconLinks(html, page);
    const scored = links.map((link) => ({
      url: link.href,
      score: scoreIcon(link),
      source: "html" as FaviconSource,
    }));
    // `Array.prototype.sort` is stable, so links of equal score keep their
    // order of appearance in the document.
    scored.sort((left, right) => left.score - right.score);
    candidates.push(...scored);
  }

  candidates.push({
    url: new URL("/favicon.ico", page.origin).toString(),
    score: 100,
    source: "favicon.ico",
  });

  const host = encodeURIComponent(page.hostname);
  candidates.push({
    url: `https://icons.duckduckgo.com/ip3/${host}.ico`,
    score: 200,
    source: "ddg",
  });
  candidates.push({
    url: `https://www.google.com/s2/favicons?domain=${host}&sz=${options.size}`,
    score: 201,
    source: "google",
  });

  return candidates;
}

/**
 * Resolve the favicon of a site. Always yields a result — the generated tile
 * is used when nothing else worked.
 */
export async function resolveFavicon(
  page: URL,
  options: ResolveOptions,
): Promise<ResolvedFavicon> {
  const deadline = Date.now() + options.timeoutMs;
  const candidates = await collectCandidates(page, options, deadline);

  for (const candidate of candidates) {
    const fetched = await fetchIcon(candidate.url, options, deadline);
    if (fetched !== null) {
      return {
        bytes: fetched.bytes,
        contentType: fetched.contentType,
        source: candidate.source,
        finalUrl: candidate.url,
      };
    }
  }

  return generateFallback(page.hostname);
}
