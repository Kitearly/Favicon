import { describe, expect, it } from "vitest";
import { extractIconLinks, scoreIcon } from "../src/html";

const PAGE = new URL("https://example.com/blog/post");

describe("extractIconLinks", () => {
  it("collects the icon links of a document", async () => {
    const links = await extractIconLinks(
      `<!doctype html><html><head>
         <link rel="icon" href="/favicon.ico" sizes="32x32">
         <link rel="apple-touch-icon" href="/apple.png" sizes="180x180">
         <link rel="icon" type="image/svg+xml" href="/vector.svg">
         <link rel="stylesheet" href="/style.css">
         <link rel="preload" href="/font.woff2">
       </head><body>hi</body></html>`,
      PAGE,
    );

    expect(links.map((link) => link.href)).toEqual([
      "https://example.com/favicon.ico",
      "https://example.com/apple.png",
      "https://example.com/vector.svg",
    ]);
  });

  it("understands multi token rel values", async () => {
    const links = await extractIconLinks(`<link rel="shortcut icon" href="/legacy.ico">`, PAGE);
    expect(links).toHaveLength(1);
    expect(links[0]?.href).toBe("https://example.com/legacy.ico");
  });

  it("resolves relative URLs against the page", async () => {
    const links = await extractIconLinks(`<link rel="icon" href="../assets/icon.png">`, PAGE);
    expect(links[0]?.href).toBe("https://example.com/assets/icon.png");
  });

  it("honours a base element", async () => {
    const links = await extractIconLinks(
      `<head><base href="https://cdn.example.net/v2/"><link rel="icon" href="i.png"></head>`,
      PAGE,
    );
    expect(links[0]?.href).toBe("https://cdn.example.net/v2/i.png");
  });

  it("applies a base element that appears after the links", async () => {
    const links = await extractIconLinks(
      `<head><link rel="icon" href="i.png"><base href="https://cdn.example.net/"></head>`,
      PAGE,
    );
    expect(links[0]?.href).toBe("https://cdn.example.net/i.png");
  });

  it("decodes character references in the href", async () => {
    const links = await extractIconLinks(`<link rel="icon" href="/i.png?v=1&amp;t=2">`, PAGE);
    expect(links[0]?.href).toBe("https://example.com/i.png?v=1&t=2");
  });

  it("ignores links that are not icons", async () => {
    const links = await extractIconLinks(
      `<link rel="stylesheet" href="/a.css"><link rel="canonical" href="/b">`,
      PAGE,
    );
    expect(links).toHaveLength(0);
  });

  it("ignores links without an href", async () => {
    const links = await extractIconLinks(`<link rel="icon">`, PAGE);
    expect(links).toHaveLength(0);
  });

  it("drops links with a non http scheme", async () => {
    const links = await extractIconLinks(`<link rel="icon" href="data:image/png;base64,AAAA">`, PAGE);
    expect(links).toHaveLength(0);
  });

  it("drops an incomplete tag at the end of the document", async () => {
    // The HTML parser drops a tag that is never closed, just like a browser.
    const links = await extractIconLinks(`<html><head><link rel="icon" href="/a.png"`, PAGE);
    expect(links).toHaveLength(0);
  });
});

describe("scoreIcon", () => {
  it("prefers SVG over everything else", () => {
    expect(scoreIcon({ href: "x", rel: "icon", type: "image/svg+xml" })).toBe(0);
  });

  it("prefers apple-touch-icon next", () => {
    expect(scoreIcon({ href: "x", rel: "apple-touch-icon", sizes: "180x180" })).toBe(1);
  });

  it("ranks sized icons above unsized ones", () => {
    expect(scoreIcon({ href: "x", rel: "icon", sizes: "32x32" })).toBe(2);
    expect(scoreIcon({ href: "x", rel: "icon" })).toBe(3);
    expect(scoreIcon({ href: "x", rel: "shortcut icon" })).toBe(3);
    expect(scoreIcon({ href: "x", rel: "icon", sizes: "any" })).toBe(3);
  });

  it("puts mask icons last", () => {
    expect(scoreIcon({ href: "x", rel: "mask-icon" })).toBe(4);
  });
});
