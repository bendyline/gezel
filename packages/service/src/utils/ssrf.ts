import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * SSRF guard for model- and script-driven outbound fetches (`fetch_url`,
 * `http.authed`). Without it, a prompt-injected model or a malicious
 * script can steer an authenticated daemon-side fetch at internal
 * targets — cloud metadata (`169.254.169.254`), other loopback services,
 * router admin pages, RFC-1918 hosts — or non-`http(s)` schemes.
 *
 * Caveat: validation happens at DNS-resolution time. A determined
 * DNS-rebinding attacker could flip the record between this check and the
 * connect. For the local-tool threat model this raises the bar
 * substantially (it blocks the metadata endpoint, localhost services, and
 * private ranges) without a custom connect-time IP pin. Callers that
 * follow redirects MUST re-validate every hop (use `redirect: 'manual'`).
 */
export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfError';
  }
}

/**
 * True for loopback / private / link-local / ULA / unspecified / CGNAT /
 * multicast literals, including any IPv6 form that carries such an IPv4
 * address (mapped, compatible, NAT64, 6to4).
 */
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return isPrivateV4(ip);
  if (v === 6) return isPrivateV6(ip);
  return false;
}

function isPrivateV4(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true; // malformed → treat as unsafe
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8 "this host"
  if (a === 10) return true; // 10/8 private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local, incl. 169.254.169.254 metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12 private
  if (a === 192 && b === 168) return true; // 192.168/16 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a === 192 && b === 0) return true; // 192.0.0/24 IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15 benchmarking
  if (a >= 224) return true; // 224/4 multicast + 240/4 reserved
  return false;
}

/**
 * The eight 16-bit groups of an IPv6 literal, zone id stripped. Parsed rather
 * than pattern-matched because the URL parser rewrites every embedded IPv4
 * address to hex: `http://[::ffff:127.0.0.1]/` arrives here as
 * `::ffff:7f00:1`, which a dotted-quad regex never recognized, and loopback,
 * the LAN and 169.254.169.254 were all reachable through it.
 */
function ipv6Groups(ip: string): number[] | null {
  let addr = ip.toLowerCase();
  const pct = addr.indexOf('%');
  if (pct >= 0) addr = addr.slice(0, pct);
  if (isIP(addr) !== 6) return null;
  const tail: number[] = [];
  const lastColon = addr.lastIndexOf(':');
  const dotted = addr.slice(lastColon + 1);
  if (dotted.includes('.')) {
    const [a = 0, b = 0, c = 0, d = 0] = dotted.split('.').map(Number);
    tail.push((a << 8) | b, (c << 8) | d);
    addr = addr.slice(0, lastColon + 1);
    if (!addr.endsWith('::')) addr = addr.slice(0, -1);
  }
  const parse = (part: string) =>
    part === '' ? [] : part.split(':').map((group) => Number.parseInt(group, 16));
  let groups: number[];
  const gap = addr.indexOf('::');
  if (gap >= 0) {
    const left = parse(addr.slice(0, gap));
    const right = parse(addr.slice(gap + 2));
    const fill = 8 - tail.length - left.length - right.length;
    groups = [...left, ...new Array<number>(Math.max(0, fill)).fill(0), ...right];
  } else {
    groups = parse(addr);
  }
  groups.push(...tail);
  return groups.length === 8 && groups.every((g) => Number.isInteger(g)) ? groups : null;
}

/** An IPv4 address carried in two IPv6 groups. */
function embeddedV4(high: number, low: number): string {
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

function isPrivateV6(ip: string): boolean {
  const g = ipv6Groups(ip);
  if (!g) return true; // unparseable → treat as unsafe
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const zeroThrough = (n: number) => g.slice(0, n).every((group) => group === 0);
  // ::/128 unspecified and ::1 loopback.
  if (zeroThrough(7) && (g7 === 0 || g7 === 1)) return true;
  // Every form that carries an IPv4 address is judged as that address:
  // ::ffff:0:0/96 mapped, ::/96 compatible (deprecated), 64:ff9b::/96 NAT64,
  // and 2002::/16 6to4.
  if (zeroThrough(5) && g5 === 0xffff) return isPrivateV4(embeddedV4(g6, g7));
  if (zeroThrough(6)) return isPrivateV4(embeddedV4(g6, g7));
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return isPrivateV4(embeddedV4(g6, g7));
  }
  if (g0 === 0x2002) return isPrivateV4(embeddedV4(g1, g2));
  // 64:ff9b:1::/48 is local-use NAT64: private by definition.
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 1) return true;
  // 2001::/32 Teredo hides its client address; 2001:db8::/32 is documentation.
  if (g0 === 0x2001 && (g1 === 0 || g1 === 0xdb8)) return true;
  // 100::/64 discard-only.
  if (g0 === 0x100 && g1 === 0 && g2 === 0 && g3 === 0) return true;
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g0 & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((g0 & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
}

/**
 * Throw `SsrfError` unless `rawUrl` is an http(s) URL whose host resolves
 * exclusively to public, routable addresses.
 */
export async function assertPublicUrl(rawUrl: string): Promise<void> {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new SsrfError('invalid URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new SsrfError(`unsupported URL scheme: ${u.protocol}`);
  }
  const host = u.hostname.replace(/^\[/, '').replace(/\]$/, ''); // strip IPv6 brackets
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new SsrfError('destination address is private or loopback');
    return;
  }
  // Reject localhost aliases up front — some resolvers map them oddly.
  if (host === 'localhost' || host.endsWith('.localhost')) {
    throw new SsrfError('destination resolves to loopback');
  }
  let results: Array<{ address: string }>;
  try {
    results = await lookup(host, { all: true });
  } catch {
    // Unresolvable host: not a private-target threat (known-private
    // targets resolve, or are IP literals handled above). Allow it and
    // let the fetch attempt fail naturally rather than raise a
    // false-positive SSRF refusal on a nonexistent/transient host.
    return;
  }
  if (results.length === 0) return;
  for (const r of results) {
    if (isPrivateAddress(r.address)) {
      throw new SsrfError('destination resolves to a private or loopback address');
    }
  }
}
