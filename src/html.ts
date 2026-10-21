/**
 * HTML parsing: find the icon links a page declares.
 *
 * Uses `HTMLRewriter` so the markup is handled by the platform parser instead
 * of a regular expression.
 */

import { decodeEntities } from "./entities";
import { resolveUrl } from "./url";

/** A single `<link rel="...">` icon declaration. */
export interface IconLink {
  /** Absolute URL of the icon. */
  href: string;
  /** Normalised `rel` attribute. */
  rel: string;
  /** Raw `sizes` attribute, when present. */
  sizes?: string;
  /** Raw `type` attribute, when present. */
  type?: string;
}

const ICON_RELS = new Set([
  "icon",
  "apple-touch-icon",
  "apple-touch-icon-precomposed",
  "mask-icon",
  "fluid-icon",
]);

/** Maximum number of icon links we collect from one document. */
const MAX_LINKS = 32;

/** Thrown from the rewriter to stop scanning once enough links were found. */
const ABORT = new Error("icon scan complete");

/**
 * Score an icon link. Lower is better and the order matches the resolution
 * chain: SVG first, then apple-touch-icon, then regular icons that carry a
 * size, and finally the ones without any size information.
 */
export function scoreIcon(link: IconLink): number {
  const type = (link.type ?? "").toLowerCase();
  const rel = link.rel.toLowerCase();

  if (type.includes("svg")) return 0;
  if (rel.includes("apple-touch-icon")) return 1;
  if (rel.includes("mask-icon")) return 4;
  if (rel.includes("fluid-icon")) return 3;
  if (link.sizes && link.sizes.toLowerCase() !== "any") return 2;
  return 3;
}

/**
 * Extract every icon link declared by a document.
 *
 * `pageUrl` is used to resolve relative hrefs. A `<base href>` element, when
 * present, takes precedence — matching how browsers resolve those URLs.
 */
export async function extractIconLinks(html: string, pageUrl: URL): Promise<IconLink[]> {
  // The raw href is kept until the whole document has been scanned: a
  // `<base href>` may appear after the links and still apply to them.
  const raw: Array<Omit<IconLink, "href"> & { href: string }> = [];
  let baseHref: string | null = null;

  const rewriter = new HTMLRewriter()
    .on("base[href]", {
      element(element) {
        if (baseHref === null) {
          baseHref = decodeEntities(element.getAttribute("href") ?? "");
        }
      },
    })
    .on("link[rel]", {
      element(element) {
        const rawHref = element.getAttribute("href");
        if (!rawHref) return;

        const rel = decodeEntities(element.getAttribute("rel") ?? "").trim().toLowerCase();
        const tokens = rel.split(/\s+/).filter(Boolean);
        if (!tokens.some((token) => ICON_RELS.has(token))) return;

        const link: Omit<IconLink, "href"> & { href: string } = {
          href: decodeEntities(rawHref),
          rel,
        };

        const sizes = element.getAttribute("sizes");
        const type = element.getAttribute("type");
        if (sizes !== null) link.sizes = decodeEntities(sizes).trim();
        if (type !== null) link.type = decodeEntities(type).trim();

        raw.push(link);

        if (raw.length >= MAX_LINKS) throw ABORT;
      },
    });

  try {
    await rewriter.transform(new Response(html)).arrayBuffer();
  } catch {
    // Either the scan was aborted on purpose or the document was malformed.
    // Whatever was collected so far is still usable.
  }

  const base = baseHref ? resolveUrl(baseHref, pageUrl.toString()) : null;
  const baseUrl = base ?? pageUrl.toString();

  return raw
    .map((link) => {
      const href = resolveUrl(link.href, baseUrl);
      return href === null ? null : { ...link, href };
    })
    .filter((link): link is IconLink => link !== null);
}
