/**
 * IP address classification.
 *
 * A port of the `ipaddr.js` range check that the original implementation used.
 * The Worker runtime has no DNS resolver, so only literal addresses can be
 * classified here — see `README.md` for what that means for the port.
 */

/** Split a dotted quad into its four octets, or null when it is not one. */
function parseIpv4(address: string): number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;

  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }
  return octets;
}

/** Expand an IPv6 literal into its eight 16 bit groups, or null. */
function parseIpv6(address: string): number[] | null {
  let text = address;

  if (text.includes(".")) {
    const separator = text.lastIndexOf(":");
    if (separator < 0) return null;
    const octets = parseIpv4(text.slice(separator + 1));
    if (!octets) return null;
    const high = ((octets[0]! << 8) | octets[1]!).toString(16);
    const low = ((octets[2]! << 8) | octets[3]!).toString(16);
    text = `${text.slice(0, separator + 1)}${high}:${low}`;
  }

  const halves = text.split("::");
  if (halves.length > 2) return null;

  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(":") : []) : [];
  const missing = 8 - head.length - tail.length;
  if (missing < 0) return null;
  if (halves.length === 1 && missing !== 0) return null;

  const groups: number[] = [];
  const push = (group: string): boolean => {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return false;
    groups.push(Number.parseInt(group, 16));
    return true;
  };

  for (const group of head) {
    if (!push(group)) return null;
  }
  for (let i = 0; i < missing; i += 1) groups.push(0);
  for (const group of tail) {
    if (!push(group)) return null;
  }
  if (groups.length !== 8) return null;

  return groups;
}

/** IPv4 ranges that must never be reached. Mirrors `ipaddr.js`. */
function isPrivateIpv4(octets: number[]): boolean {
  const [a, b, c, d] = octets as [number, number, number, number];

  if (a === 0) return true; // unspecified
  if (a === 255 && b === 255 && c === 255 && d === 255) return true; // broadcast
  if (a >= 224 && a <= 239) return true; // multicast
  if (a === 169 && b === 254) return true; // link local
  if (a === 127) return true; // loopback
  if (a >= 100 && a <= 107 && b >= 64 && b <= 127) return true; // carrier grade NAT
  if (a === 10) return true; // private
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 192 && b === 0 && c === 0) return true; // reserved
  if (a === 192 && b === 0 && c === 2) return true; // reserved
  if (a === 198 && b >= 51 && b <= 52) return true; // reserved
  if (a === 203 && b === 0 && c === 113) return true; // reserved
  if (a >= 240) return true; // reserved

  return false;
}

/** IPv6 ranges that must never be reached. Mirrors `ipaddr.js`. */
function isPrivateIpv6(groups: number[]): boolean {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups as [
    number, number, number, number, number, number, number, number,
  ];

  // ::ffff:0:0/96 — an IPv4 address in disguise.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return isPrivateIpv4([(g6 >> 8) & 0xff, g6 & 0xff, (g7 >> 8) & 0xff, g7 & 0xff]);
  }

  if (g0 === 0x2002) return true; // 6to4
  if (g0 === 0x2001 && g1 === 0) return true; // teredo
  if (g0 === 0x0064 && g1 === 0xff9b) return true; // rfc6052 / NAT64
  if (g0 === 0xfe80) return true; // link local
  if ((g0 & 0xff00) === 0xff00) return true; // multicast
  if (g0 === 0x2001 && g1 === 0x0db8) return true; // reserved
  if (g0 === 0x2001 && g1 === 0x0010) return true; // reserved
  if (g0 === 0x2001 && g1 === 0x0020) return true; // reserved
  if ((g0 & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
  if (g0 === 0xfe00 || g0 === 0xfec0 || g0 === 0xef00) return true; // reserved
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0) return true; // unspecified
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 1) return true; // loopback
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 2) return true; // rfc6145

  return false;
}

/**
 * Check whether an address belongs to a private, loopback, link-local or
 * otherwise reserved range. Addresses that cannot be parsed are rejected.
 */
export function isPrivateAddress(address: string): boolean {
  const trimmed = address.trim();

  const ipv4 = parseIpv4(trimmed);
  if (ipv4) return isPrivateIpv4(ipv4);

  const ipv6 = parseIpv6(trimmed);
  if (ipv6) return isPrivateIpv6(ipv6);

  // Fail closed on anything we cannot parse.
  return true;
}

/** Whether the given string is an IP literal rather than a host name. */
export function isIpLiteral(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "");
  return parseIpv4(host) !== null || parseIpv6(host) !== null;
}
