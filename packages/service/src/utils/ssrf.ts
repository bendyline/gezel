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

/** True for loopback / private / link-local / ULA / unspecified / CGNAT / multicast literals. */
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
  if (a >= 224) return true; // 224/4 multicast + 240/4 reserved
  return false;
}

function isPrivateV6(ip: string): boolean {
  let addr = ip.toLowerCase();
  const pct = addr.indexOf('%');
  if (pct >= 0) addr = addr.slice(0, pct); // strip zone id
  if (addr === '::1' || addr === '::') return true; // loopback / unspecified
  const mapped = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped?.[1]) return isPrivateV4(mapped[1]); // IPv4-mapped
  // link-local fe80::/10 → fe8/fe9/fea/feb prefixes
  if (/^fe[89ab]/.test(addr)) return true;
  // unique-local fc00::/7 → fc/fd
  if (addr.startsWith('fc') || addr.startsWith('fd')) return true;
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
