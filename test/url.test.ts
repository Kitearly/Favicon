import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import {
  assertFetchableUrl,
  assertPublicHost,
  BlockedHostError,
  checkHostSafety,
  InvalidUrlError,
  isBlockedHostname,
  parseTarget,
  resolveUrl,
  validateUrl,
} from "../src/url";
import { network } from "./setup";

describe("validateUrl", () => {
  it("accepts http and https URLs", () => {
    expect(validateUrl("https://example.com/", ["80", "443"])).not.toBeNull();
    expect(validateUrl("http://example.com/", ["80", "443"])).not.toBeNull();
  });

  it("rejects other protocols", () => {
    expect(validateUrl("ftp://example.com/", null)).toBeNull();
    expect(validateUrl("file:///etc/passwd", null)).toBeNull();
    expect(validateUrl("javascript:alert(1)", null)).toBeNull();
  });

  it("rejects URLs with credentials", () => {
    expect(validateUrl("https://user:pass@example.com/", null)).toBeNull();
  });

  it("rejects empty and oversized input", () => {
    expect(validateUrl("", null)).toBeNull();
    expect(validateUrl(undefined, null)).toBeNull();
    expect(validateUrl("https://example.com/" + "x".repeat(3000), null)).toBeNull();
  });

  it("honours the port allow list", () => {
    expect(validateUrl("https://example.com:8443/", ["80", "443"])).toBeNull();
    expect(validateUrl("https://example.com:8443/", ["80", "443", "8443"])).not.toBeNull();
    expect(validateUrl("https://example.com:8443/", null)).not.toBeNull();
  });
});

describe("parseTarget", () => {
  it("fills in a missing scheme", () => {
    expect(parseTarget("example.com", ["80", "443"], false)?.href).toBe("https://example.com/");
    expect(parseTarget("example.com/path", ["80", "443"], false)?.href).toBe(
      "https://example.com/path",
    );
  });

  it("keeps an explicit scheme", () => {
    expect(parseTarget("http://example.com/", ["80", "443"], false)?.href).toBe(
      "http://example.com/",
    );
  });

  it("rejects unusable input", () => {
    expect(() => parseTarget("", ["80", "443"], false)).toThrow(InvalidUrlError);
    expect(() => parseTarget(undefined, ["80", "443"], false)).toThrow(InvalidUrlError);
    expect(() => parseTarget("javascript:alert(1)", ["80", "443"], false)).toThrow(
      InvalidUrlError,
    );
    expect(() => parseTarget("https://user:pass@example.com/", ["80", "443"], false)).toThrow(
      InvalidUrlError,
    );
  });

  it("rejects targets that may not be contacted", () => {
    expect(() => parseTarget("http://127.0.0.1/", ["80", "443"], false)).toThrow(
      BlockedHostError,
    );
    expect(() => parseTarget("http://127.0.0.1/", ["80", "443"], true)).not.toThrow();
  });
});

describe("isBlockedHostname", () => {
  it("blocks local host names", () => {
    expect(isBlockedHostname("localhost")).toBe(true);
    expect(isBlockedHostname("app.localhost")).toBe(true);
    expect(isBlockedHostname("printer.local")).toBe(true);
    expect(isBlockedHostname("db.internal")).toBe(true);
  });

  it("allows ordinary host names", () => {
    expect(isBlockedHostname("example.com")).toBe(false);
    expect(isBlockedHostname("localhost.example.com")).toBe(false);
  });
});

describe("checkHostSafety", () => {
  it("blocks private literals by default", () => {
    expect(checkHostSafety("127.0.0.1", false)).toBe("blocked address");
    expect(checkHostSafety("192.168.1.1", false)).toBe("blocked address");
    expect(checkHostSafety("[::1]", false)).toBe("blocked address");
  });

  it("allows private literals when they are permitted", () => {
    expect(checkHostSafety("127.0.0.1", true)).toBeNull();
  });

  it("always blocks local host names", () => {
    expect(checkHostSafety("localhost", true)).toBe("blocked hostname");
  });

  it("does not treat a domain name as a literal address", () => {
    expect(checkHostSafety("example.com", false)).toBeNull();
  });
});

describe("assertFetchableUrl", () => {
  it("accepts a public http(s) URL", () => {
    expect(() => assertFetchableUrl(new URL("https://example.com/"), ["80", "443"], false)).not.toThrow();
  });

  it("rejects other protocols and credentials", () => {
    expect(() => assertFetchableUrl(new URL("file:///etc/passwd"), null, false)).toThrow(
      InvalidUrlError,
    );
    expect(() => assertFetchableUrl(new URL("https://u:p@example.com/"), null, false)).toThrow(
      InvalidUrlError,
    );
  });

  it("rejects ports that are not allowed", () => {
    expect(() => assertFetchableUrl(new URL("https://example.com:8443/"), ["80", "443"], false)).toThrow(
      InvalidUrlError,
    );
  });

  it("rejects private and local targets", () => {
    expect(() => assertFetchableUrl(new URL("http://169.254.169.254/"), null, false)).toThrow(
      BlockedHostError,
    );
    expect(() => assertFetchableUrl(new URL("http://localhost/"), null, false)).toThrow(
      BlockedHostError,
    );
  });
});

describe("assertPublicHost", () => {
  it("accepts IP literals without asking the resolver", async () => {
    expect((await assertPublicHost("https://127.0.0.1/")).ok).toBe(true);
    expect((await assertPublicHost("https://[::1]/")).ok).toBe(true);
  });

  it("blocks a host that resolves to a private address", async () => {
    network.use(
      http.get("https://cloudflare-dns.com/dns-query", ({ request }) => {
        const type = new URL(request.url).searchParams.get("type");
        return HttpResponse.json({
          Answer:
            type === "A"
              ? [{ type: 1, data: "10.0.0.1" }]
              : [{ type: 28, data: "fd00::1" }],
        });
      }),
    );

    const result = await assertPublicHost("https://private.test/");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("private address");
  });

  it("accepts a host that resolves to a public address", async () => {
    network.use(
      http.get("https://cloudflare-dns.com/dns-query", () =>
        HttpResponse.json({ Answer: [{ type: 1, data: "93.184.216.34" }] }),
      ),
    );

    expect((await assertPublicHost("https://public.test/")).ok).toBe(true);
  });

  it("fails open when the resolver is unavailable", async () => {
    network.use(
      http.get("https://cloudflare-dns.com/dns-query", () => new HttpResponse(null, { status: 500 })),
    );

    expect((await assertPublicHost("https://unreachable.test/")).ok).toBe(true);
  });
});

describe("resolveUrl", () => {
  const base = "https://example.com/dir/page";

  it("resolves relative paths", () => {
    expect(resolveUrl("/a.png", base)).toBe("https://example.com/a.png");
    expect(resolveUrl("a.png", base)).toBe("https://example.com/dir/a.png");
    expect(resolveUrl("../a.png", base)).toBe("https://example.com/a.png");
  });

  it("keeps absolute URLs", () => {
    expect(resolveUrl("https://cdn.example.net/a.png", base)).toBe("https://cdn.example.net/a.png");
  });

  it("inherits the protocol of the base", () => {
    expect(resolveUrl("//example.com/a.png", "http://example.com/")).toBe("http://example.com/a.png");
  });

  it("rejects fragments, empty values and other protocols", () => {
    expect(resolveUrl("#", base)).toBeNull();
    expect(resolveUrl("", base)).toBeNull();
    expect(resolveUrl("   ", base)).toBeNull();
    expect(resolveUrl("data:image/png;base64,AA", base)).toBeNull();
    expect(resolveUrl("javascript:alert(1)", base)).toBeNull();
  });

  it("rejects URLs with credentials", () => {
    expect(resolveUrl("https://user:pass@example.com/a.png", base)).toBeNull();
  });
});
