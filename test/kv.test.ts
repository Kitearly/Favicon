import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  kvKeyLast,
  kvKeyNow,
  randomNowTtlSeconds,
  readIcon,
  writeIcon,
} from "../src/kv";
import type { Env, FaviconMeta } from "../src/types";

const workerEnv = env as unknown as Env;

const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);

/** Bytes that are not valid UTF-8 and would be destroyed by a text read. */
const BINARY = Uint8Array.from([
  0x00, 0x01, 0xff, 0xfe, 0x80, 0x9f, 0xc3, 0x28, 0xed, 0xa0, 0x80,
]);

const META: FaviconMeta = {
  ct: "image/png",
  src: "html",
  url: "https://example.com/i.png",
};

describe("key helpers", () => {
  it("builds the two keys of a host", () => {
    expect(kvKeyNow("Example.COM")).toBe("ico:now:example.com");
    expect(kvKeyLast("example.com:8443")).toBe("ico:last:example.com:8443");
  });
});

describe("randomNowTtlSeconds", () => {
  it("picks a lifetime between three and seven days", () => {
    for (let i = 0; i < 200; i += 1) {
      const ttl = randomNowTtlSeconds();
      expect(ttl).toBeGreaterThanOrEqual(3 * 24 * 3600);
      expect(ttl).toBeLessThanOrEqual(7 * 24 * 3600);
    }
  });

  it("actually spreads the values out", () => {
    const values = new Set<number>();
    for (let i = 0; i < 50; i += 1) values.add(randomNowTtlSeconds());
    expect(values.size).toBeGreaterThan(10);
  });
});

describe("readIcon", () => {
  it("returns null for a missing key", async () => {
    expect(await readIcon(workerEnv, "ico:now:missing.example", 60)).toBeNull();
  });
});

describe("writeIcon", () => {
  it("stores and reads an icon with its metadata", async () => {
    const key = kvKeyNow("roundtrip.example");
    expect(await writeIcon(workerEnv, key, PNG, META, 600)).toBe(true);

    const read = await readIcon(workerEnv, key, 60);
    expect(read).not.toBeNull();
    expect(read?.bytes).toEqual(PNG);
    expect(read?.meta).toEqual(META);
  });

  it("keeps bytes that are not valid UTF-8 intact", async () => {
    const key = kvKeyNow("binary.example");
    await writeIcon(workerEnv, key, BINARY, META, 600);

    const read = await readIcon(workerEnv, key, 60);
    expect(read?.bytes).toEqual(BINARY);
  });

  it("writes an entry that never expires", async () => {
    const key = kvKeyLast("forever.example");
    expect(await writeIcon(workerEnv, key, PNG, META, null)).toBe(true);
    expect(await readIcon(workerEnv, key, 60)).not.toBeNull();
  });

  it("ignores an entry without usable metadata", async () => {
    const key = kvKeyNow("nometa.example");
    await workerEnv.FAVICON_KV.put(key, PNG, { expirationTtl: 600 });
    expect(await readIcon(workerEnv, key, 60)).toBeNull();
  });

  it("ignores an entry whose metadata is incomplete", async () => {
    const key = kvKeyNow("partialmeta.example");
    await workerEnv.FAVICON_KV.put(key, PNG, {
      expirationTtl: 600,
      metadata: { src: "html" },
    });
    expect(await readIcon(workerEnv, key, 60)).toBeNull();
  });

  it("ignores an entry whose metadata has an unknown source", async () => {
    const key = kvKeyNow("badsource.example");
    await workerEnv.FAVICON_KV.put(key, PNG, {
      expirationTtl: 600,
      metadata: { ct: "image/png", src: "somewhere-else", url: "https://x.test/i.png" },
    });
    expect(await readIcon(workerEnv, key, 60)).toBeNull();
  });
});
