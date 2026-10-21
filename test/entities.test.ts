import { describe, expect, it } from "vitest";
import { decodeEntities } from "../src/entities";

describe("decodeEntities", () => {
  it("decodes the markup significant references", () => {
    expect(decodeEntities("Tom &amp; Jerry")).toBe("Tom & Jerry");
    expect(decodeEntities("&lt;tag&gt;")).toBe("<tag>");
    expect(decodeEntities("&quot;quoted&quot;")).toBe('"quoted"');
    expect(decodeEntities("it&apos;s")).toBe("it's");
  });

  it("decodes numeric references", () => {
    expect(decodeEntities("&#65;&#66;&#67;")).toBe("ABC");
    expect(decodeEntities("&#x41;&#X42;")).toBe("AB");
  });

  it("decodes latin-1 and symbol references", () => {
    expect(decodeEntities("caf&eacute;")).toBe("café");
    expect(decodeEntities("&mdash;")).toBe("—");
    expect(decodeEntities("&hellip;")).toBe("…");
    expect(decodeEntities("&copy;")).toBe("©");
  });

  it("leaves unknown references alone", () => {
    expect(decodeEntities("&notareference;")).toBe("&notareference;");
    expect(decodeEntities("plain text")).toBe("plain text");
  });

  it("replaces invalid code points", () => {
    expect(decodeEntities("&#0;")).toBe("�");
    expect(decodeEntities("&#xD800;")).toBe("�");
  });

  it("does nothing when there is no ampersand", () => {
    expect(decodeEntities("plain")).toBe("plain");
  });
});
