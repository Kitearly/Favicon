import { describe, expect, it } from "vitest";
import { isIpLiteral, isPrivateAddress } from "../src/ip";

describe("isPrivateAddress", () => {
  it("blocks the IPv4 ranges that must not be reached", () => {
    expect(isPrivateAddress("0.0.0.0")).toBe(true);
    expect(isPrivateAddress("127.0.0.1")).toBe(true);
    expect(isPrivateAddress("10.1.2.3")).toBe(true);
    expect(isPrivateAddress("172.16.0.1")).toBe(true);
    expect(isPrivateAddress("172.31.255.255")).toBe(true);
    expect(isPrivateAddress("192.168.1.1")).toBe(true);
    expect(isPrivateAddress("169.254.169.254")).toBe(true);
    expect(isPrivateAddress("100.64.0.1")).toBe(true);
    expect(isPrivateAddress("192.0.0.1")).toBe(true);
    expect(isPrivateAddress("192.0.2.1")).toBe(true);
    expect(isPrivateAddress("198.51.100.1")).toBe(true);
    expect(isPrivateAddress("203.0.113.1")).toBe(true);
    expect(isPrivateAddress("224.0.0.1")).toBe(true);
    expect(isPrivateAddress("239.255.255.255")).toBe(true);
    expect(isPrivateAddress("255.255.255.255")).toBe(true);
    expect(isPrivateAddress("240.0.0.1")).toBe(true);
  });

  it("allows public IPv4 addresses", () => {
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
    expect(isPrivateAddress("1.1.1.1")).toBe(false);
    expect(isPrivateAddress("93.184.216.34")).toBe(false);
    expect(isPrivateAddress("172.32.0.1")).toBe(false);
    expect(isPrivateAddress("172.15.0.1")).toBe(false);
  });

  it("blocks the IPv6 ranges that must not be reached", () => {
    expect(isPrivateAddress("::")).toBe(true);
    expect(isPrivateAddress("::1")).toBe(true);
    expect(isPrivateAddress("fc00::1")).toBe(true);
    expect(isPrivateAddress("fd12:3456::1")).toBe(true);
    expect(isPrivateAddress("fe80::1")).toBe(true);
    expect(isPrivateAddress("ff02::1")).toBe(true);
    expect(isPrivateAddress("2002::1")).toBe(true);
    expect(isPrivateAddress("2001::1")).toBe(true);
    expect(isPrivateAddress("64:ff9b::1.2.3.4")).toBe(true);
  });

  it("checks IPv4 mapped addresses", () => {
    expect(isPrivateAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateAddress("::ffff:169.254.169.254")).toBe(true);
    expect(isPrivateAddress("::ffff:10.0.0.1")).toBe(true);
    expect(isPrivateAddress("::ffff:8.8.8.8")).toBe(false);
  });

  it("allows public IPv6 addresses", () => {
    expect(isPrivateAddress("2606:4700:4700::1111")).toBe(false);
    expect(isPrivateAddress("2001:4860:4860::8888")).toBe(false);
  });

  it("fails closed on addresses it cannot parse", () => {
    expect(isPrivateAddress("not an address")).toBe(true);
    expect(isPrivateAddress("999.1.1.1")).toBe(true);
  });
});

describe("isIpLiteral", () => {
  it("recognises literals", () => {
    expect(isIpLiteral("127.0.0.1")).toBe(true);
    expect(isIpLiteral("::1")).toBe(true);
    expect(isIpLiteral("[::1]")).toBe(true);
  });

  it("does not treat host names as literals", () => {
    expect(isIpLiteral("example.com")).toBe(false);
    expect(isIpLiteral("127.0.0.1.example.com")).toBe(false);
  });
});
