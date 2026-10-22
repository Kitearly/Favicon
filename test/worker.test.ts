import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { kvKeyFail, kvKeyLast, kvKeyNow, readFail, readIcon, writeIcon } from "../src/kv";
import type { Env, FaviconMeta } from "../src/types";
import { network } from "./setup";

const workerEnv = env as unknown as Env;

/** A real 1x1 PNG. */
const PNG_BYTES = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  ),
  (character) => character.charCodeAt(0),
);

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

const PNG = toArrayBuffer(PNG_BYTES);

const META: FaviconMeta = {
  ct: "image/png",
  src: "html",
  url: "https://declared.test/logo.png",
};

/** The environment the tests run with. */
function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    ...workerEnv,
    HOSTS: "",
    ALLOWED_PORTS: "*",
    ALLOW_PRIVATE_HOSTS: "1",
    KV_EDGE_TTL_SECONDS: "60",
    // 默认在网关里进程内调用 Favicon 入口：这样每个用例对 env 的覆盖
    // 才能传到内层（loopback 入口拿到的是运行时的 env，不是用例传的）。
    // loopback 路径自己有专门的用例。
    WORKERS_CACHE: "",
    ...overrides,
  } as Env;
}

async function call(
  env: Env,
  target: string | null,
  extra: Record<string, string> = {},
): Promise<Response> {
  const params = new URLSearchParams();
  if (target !== null) params.set("url", target);
  for (const [key, value] of Object.entries(extra)) params.set(key, value);

  const query = params.toString();
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`https://worker.test/${query ? `?${query}` : ""}`),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

/** Mock a site that declares a PNG icon. */
function mockSite(host: string, iconPath = "/logo.png"): void {
  network.use(
    http.get(`https://${host}/`, () =>
      HttpResponse.text(`<link rel="icon" href="${iconPath}">`, {
        headers: { "content-type": "text/html" },
      }),
    ),
    http.get(`https://${host}${iconPath}`, () =>
      HttpResponse.arrayBuffer(PNG, { headers: { "content-type": "image/png" } }),
    ),
  );
}

beforeEach(() => {
  // Catch-all first, specific handlers below take precedence.
  network.use(http.all("*", () => new HttpResponse(null, { status: 404 })));
});

describe("parameter handling", () => {
  it("rejects a request without a target", async () => {
    const response = await call(makeEnv(), null);
    expect(response.status).toBe(400);
    // Errors must never be cached, not even by heuristic freshness.
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INVALID_URL");
  });

  it("rejects a malformed target", async () => {
    const response = await call(makeEnv(), "http://");
    expect(response.status).toBe(400);
  });

  it("rejects private targets", async () => {
    const response = await call(
      makeEnv({ ALLOW_PRIVATE_HOSTS: "0" }),
      "http://169.254.169.254/latest/meta-data/",
    );
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("BLOCKED_HOST");
  });

  it("rejects ports that are not allowed", async () => {
    const response = await call(makeEnv({ ALLOWED_PORTS: "80,443" }), "https://example.com:8443/");
    expect(response.status).toBe(400);
  });

  it("answers CORS preflight requests", async () => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request("https://worker.test/", { method: "OPTIONS" }),
      workerEnv,
      ctx,
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("caller allow list", () => {
  it("allows everything when HOSTS is empty", async () => {
    const response = await call(makeEnv({ HOSTS: "" }), "https://referer.test/");
    expect(response.status).toBe(200);
  });

  it("rejects a referer that is not on the list", async () => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request("https://worker.test/?url=https%3A%2F%2Freferer.test%2F", {
        headers: { referer: "https://evil.com/x" },
      }),
      makeEnv({ HOSTS: "allowed.test" }),
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("REFERER_NOT_ALLOWED");
  });

  it("accepts a referer that is on the list", async () => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request("https://worker.test/?url=https%3A%2F%2Freferer.test%2F", {
        headers: { referer: "https://allowed.test/page" },
      }),
      makeEnv({ HOSTS: "allowed.test" }),
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
  });

  it("inspects Origin as well: fetch() requests send only that", async () => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request("https://worker.test/?url=https%3A%2F%2Freferer.test%2F", {
        headers: { origin: "https://allowed.test" },
      }),
      makeEnv({ HOSTS: "allowed.test" }),
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
  });

  it("rejects an Origin from an unknown host even when the Referer is empty", async () => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request("https://worker.test/?url=https%3A%2F%2Freferer.test%2F", {
        headers: { origin: "https://evil.com" },
      }),
      makeEnv({ HOSTS: "allowed.test" }),
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(403);
  });

  it("matches subdomains of a listed host", async () => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request("https://worker.test/?url=https%3A%2F%2Freferer.test%2F", {
        headers: { origin: "https://blog.allowed.test" },
      }),
      makeEnv({ HOSTS: "allowed.test" }),
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
  });

  it("normalises the configured hosts to lower case", async () => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request("https://worker.test/?url=https%3A%2F%2Freferer.test%2F", {
        headers: { origin: "https://allowed.test" },
      }),
      makeEnv({ HOSTS: "Allowed.Test" }),
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
  });

  it("honours an explicit *. wildcard", async () => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request("https://worker.test/?url=https%3A%2F%2Freferer.test%2F", {
        headers: { origin: "https://allowed.test" },
      }),
      makeEnv({ HOSTS: "*.allowed.test" }),
      ctx,
    );
    await waitOnExecutionContext(ctx);

    // `*.allowed.test` 只匹配子域，自身不带后缀的裸域名在白名单之外。
    expect(response.status).toBe(403);
  });

  it("rejects requests without any caller header unless ALLOW_EMPTY_REFERER is on", async () => {
    const blocked = await call(makeEnv({ HOSTS: "allowed.test" }), "https://referer.test/");
    expect(blocked.status).toBe(403);

    const allowed = await call(
      makeEnv({ HOSTS: "allowed.test", ALLOW_EMPTY_REFERER: "1" }),
      "https://referer.test/",
    );
    expect(allowed.status).toBe(200);
  });
});

describe("resolving a favicon", () => {
  it("returns the icon declared in the HTML", async () => {
    mockSite("declared.test");

    const response = await call(makeEnv(), "https://declared.test");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("x-favicon-source")).toBe("html");
    expect(response.headers.get("x-favicon-final-url")).toBe("https://declared.test/logo.png");
    expect(response.headers.get("x-favicon-cache")).toBe("MISS");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG_BYTES);
  });

  it("serves the stored icon on the next request", async () => {
    mockSite("cached.test");

    const first = await call(makeEnv(), "https://cached.test");
    expect(first.headers.get("x-favicon-cache")).toBe("MISS");

    const second = await call(makeEnv(), "https://cached.test");
    expect(second.status).toBe(200);
    expect(second.headers.get("x-favicon-cache")).toBe("FRESH");
    expect(second.headers.get("x-favicon-source")).toBe("html");
  });

  it("stores the icon under both keys", async () => {
    mockSite("bothkeys.test");

    await call(makeEnv(), "https://bothkeys.test");

    const now = await readIcon(workerEnv, kvKeyNow("bothkeys.test"), 60);
    const last = await readIcon(workerEnv, kvKeyLast("bothkeys.test"), 60);

    expect(now?.bytes).toEqual(PNG_BYTES);
    expect(now?.meta.ct).toBe("image/png");
    expect(now?.meta.src).toBe("html");
    expect(last?.bytes).toEqual(PNG_BYTES);
    expect(last?.meta).toEqual(now?.meta);

    // 清理脚本靠写入时间判断 `ico:last` 的年龄。
    const raw = await workerEnv.FAVICON_KV.getWithMetadata(kvKeyLast("bothkeys.test"), {
      type: "arrayBuffer",
    });
    const at = (raw.metadata as { at?: number } | null)?.at;
    expect(typeof at).toBe("number");
    expect(at).toBeGreaterThan(Date.now() - 60_000);
  });

  it("falls back to /favicon.ico when the page declares nothing", async () => {
    network.use(
      http.get("https://plain.test/", () =>
        HttpResponse.text("<!doctype html><html><head></head><body>no icons</body></html>", {
          headers: { "content-type": "text/html" },
        }),
      ),
      http.get("https://plain.test/favicon.ico", () =>
        HttpResponse.arrayBuffer(PNG, { headers: { "content-type": "image/x-icon" } }),
      ),
    );

    const response = await call(makeEnv(), "https://plain.test");
    expect(response.status).toBe(200);
    expect(response.headers.get("x-favicon-source")).toBe("favicon.ico");
    // The payload is a PNG even though the URL claims to be an icon.
    expect(response.headers.get("content-type")).toBe("image/png");
  });

  it("generates a placeholder when the site has no icon at all", async () => {
    const response = await call(makeEnv(), "https://nothing.test");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/svg+xml");
    expect(response.headers.get("x-favicon-source")).toBe("generated");
    expect(response.headers.get("x-favicon-cache")).toBe("FALLBACK");
    // The placeholder is only a stopgap: keep it out of the edge cache quickly.
    const maxAge = Number(
      /max-age=(\d+)/.exec(response.headers.get("cache-control") ?? "")?.[1] ?? "-1",
    );
    expect(maxAge).toBeLessThanOrEqual(60);
    const body = await response.text();
    expect(body).toContain("<svg");
    expect(body).toContain("N");
  });

  it("never stores the generated placeholder", async () => {
    await call(makeEnv(), "https://notstored.test");

    expect(await readIcon(workerEnv, kvKeyNow("notstored.test"), 60)).toBeNull();
    expect(await readIcon(workerEnv, kvKeyLast("notstored.test"), 60)).toBeNull();
  });

  it("ignores an HTML answer for an icon URL", async () => {
    network.use(
      http.get("https://htmlanswer.test/", () =>
        HttpResponse.text(`<link rel="icon" href="/logo.png">`, {
          headers: { "content-type": "text/html" },
        }),
      ),
      http.get("https://htmlanswer.test/logo.png", () =>
        HttpResponse.text("<!doctype html><html>not an image</html>", {
          headers: { "content-type": "text/html" },
        }),
      ),
      http.get("https://htmlanswer.test/favicon.ico", () =>
        HttpResponse.arrayBuffer(PNG, { headers: { "content-type": "image/png" } }),
      ),
    );

    const response = await call(makeEnv(), "https://htmlanswer.test");
    expect(response.status).toBe(200);
    expect(response.headers.get("x-favicon-source")).toBe("favicon.ico");
  });

  it("forces a fresh resolution with refresh=1", async () => {
    mockSite("forced.test");

    await call(makeEnv(), "https://forced.test");
    const refreshed = await call(makeEnv(), "https://forced.test", { refresh: "1" });
    expect(refreshed.status).toBe(200);
    expect(refreshed.headers.get("x-favicon-cache")).toBe("MISS");
  });

  it("accepts a bare domain", async () => {
    mockSite("bare.test");

    const response = await call(makeEnv(), "bare.test");
    expect(response.status).toBe(200);
    expect(response.headers.get("x-favicon-source")).toBe("html");
  });

  it("answers HEAD requests without a body", async () => {
    mockSite("head.test");

    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request("https://worker.test/?url=https%3A%2F%2Fhead.test%2F", { method: "HEAD" }),
      makeEnv(),
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(await response.text()).toBe("");
  });
});

describe("when the most recent icon is gone", () => {
  /** Store an icon under `ico:last` only, as if `ico:now` had expired. */
  async function seedLast(host: string, bytes: Uint8Array, meta: FaviconMeta): Promise<void> {
    await writeIcon(workerEnv, kvKeyLast(host), bytes, meta, null);
  }

  it("serves the last icon and refreshes in the background", async () => {
    const old = Uint8Array.from(PNG_BYTES);
    old[old.length - 1] = 0x00;
    await seedLast("stale.test", old, { ...META, url: "https://stale.test/old.png" });

    mockSite("stale.test", "/new.png");

    const response = await call(makeEnv(), "https://stale.test");
    expect(response.status).toBe(200);
    expect(response.headers.get("x-favicon-cache")).toBe("STALE");
    // The old payload is handed out straight away.
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(old);

    // The background refresh replaced the stored icon.
    const now = await readIcon(workerEnv, kvKeyNow("stale.test"), 60);
    expect(now?.bytes).toEqual(PNG_BYTES);
    expect(now?.meta.url).toBe("https://stale.test/new.png");
  });

  it("keeps the old icon and goes into the negative cache when the upstream is gone", async () => {
    const old = Uint8Array.from(PNG_BYTES);
    old[old.length - 1] = 0x00;
    await seedLast("broken.test", old, { ...META, url: "https://broken.test/old.png" });

    const response = await call(makeEnv(), "https://broken.test");
    expect(response.status).toBe(200);
    expect(response.headers.get("x-favicon-cache")).toBe("STALE");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(old);

    // The host is in the negative cache now, so the next requests do not all
    // hammer a site that is down.
    const failure = await readFail(workerEnv, kvKeyFail("broken.test"));
    expect(failure).not.toBeNull();

    // And nothing was written to the "most recent" key.
    expect(await readIcon(workerEnv, kvKeyNow("broken.test"), 60)).toBeNull();
  });

  it("does not contact the upstream while the negative cache is alive", async () => {
    let attempts = 0;
    network.use(
      http.get("https://blocked.test/", () => {
        attempts += 1;
        return new HttpResponse(null, { status: 500 });
      }),
    );

    await workerEnv.FAVICON_KV.put(kvKeyFail("blocked.test"), "boom", { expirationTtl: 600 });

    const response = await call(makeEnv(), "https://blocked.test");
    expect(response.status).toBe(200);
    expect(response.headers.get("x-favicon-cache")).toBe("FALLBACK");
    expect(response.headers.get("x-favicon-reason")).toBe("boom");
    expect(attempts).toBe(0);
  });

  it("clears the negative cache once the host recovers", async () => {
    mockSite("recovered.test");

    await workerEnv.FAVICON_KV.put(kvKeyFail("recovered.test"), "boom", { expirationTtl: 600 });

    // The negative cache is alive, so the site is not contacted.
    const blocked = await call(makeEnv(), "https://recovered.test");
    expect(blocked.headers.get("x-favicon-cache")).toBe("FALLBACK");

    // Once the marker is gone the site is fetched again.
    await workerEnv.FAVICON_KV.delete(kvKeyFail("recovered.test"));

    const response = await call(makeEnv(), "https://recovered.test");
    expect(response.status).toBe(200);
    expect(response.headers.get("x-favicon-cache")).toBe("MISS");
    expect(response.headers.get("x-favicon-source")).toBe("html");
  });

  it("serves the last icon when a forced refresh fails", async () => {
    const old = Uint8Array.from(PNG_BYTES);
    old[old.length - 1] = 0x00;
    await seedLast("forcedfail.test", old, { ...META, url: "https://forcedfail.test/old.png" });

    const response = await call(makeEnv(), "https://forcedfail.test", { refresh: "1" });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-favicon-cache")).toBe("STALE");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(old);
  });
});

describe("WORKERS_CACHE loopback", () => {
  it("routes through the ctx.exports binding when the flag is on", async () => {
    mockSite("loopback.test");

    const response = await call(makeEnv({ WORKERS_CACHE: "1" }), "https://loopback.test");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("x-favicon-cache")).toBe("MISS");
  });
});
