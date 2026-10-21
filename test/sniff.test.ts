import { describe, expect, it } from "vitest";
import { sniffImageType } from "../src/sniff";

const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);

const GIF = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const ICO = Uint8Array.from([0x00, 0x00, 0x01, 0x00, 0x01, 0x00]);
const BMP = Uint8Array.from([0x42, 0x4d, 0x1e, 0x00]);
const WEBP = Uint8Array.from([
  0x52, 0x49, 0x46, 0x46, 0x1a, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);

function text(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

describe("sniffImageType", () => {
  it("detects PNG", () => {
    expect(sniffImageType(PNG)).toBe("image/png");
  });

  it("detects GIF, JPEG, BMP and WebP", () => {
    expect(sniffImageType(GIF)).toBe("image/gif");
    expect(sniffImageType(JPEG)).toBe("image/jpeg");
    expect(sniffImageType(BMP)).toBe("image/bmp");
    expect(sniffImageType(WEBP)).toBe("image/webp");
  });

  it("detects ICO and cursor files", () => {
    expect(sniffImageType(ICO)).toBe("image/x-icon");
    expect(sniffImageType(Uint8Array.from([0x00, 0x00, 0x02, 0x00]))).toBe("image/x-icon");
  });

  it("trusts the magic bytes over a wrong content type", () => {
    // A very common upstream mistake: .ico served as octet-stream.
    expect(sniffImageType(ICO, "application/octet-stream")).toBe("image/x-icon");
    expect(sniffImageType(PNG, "text/html")).toBe("image/png");
  });

  it("detects SVG", () => {
    expect(sniffImageType(text('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBe(
      "image/svg+xml",
    );
    expect(
      sniffImageType(text('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>')),
    ).toBe("image/svg+xml");
    expect(sniffImageType(text("  \n<svg viewBox='0 0 1 1'/>"))).toBe("image/svg+xml");
  });

  it("rejects HTML answers", () => {
    expect(sniffImageType(text("<!doctype html><html><body>nope</body></html>"))).toBeNull();
    expect(sniffImageType(text("<html><svg></svg></html>"))).toBeNull();
  });

  it("rejects empty payloads", () => {
    expect(sniffImageType(new Uint8Array(0))).toBeNull();
  });
});
