/**
 * Node-side helper for talking to a daemon serving HTTPS over a
 * self-signed cert. The daemon's loopback TLS exists to unlock HTTP/2
 * multiplexing in the renderer (Chromium won't speak HTTP/2 cleartext);
 * Node-side clients (CLI, MCP child, supervisor probes) need a
 * dispatcher that trusts the cert without doing global-singleton
 * surgery on `process.env.NODE_TLS_REJECT_UNAUTHORIZED`.
 *
 * Returns a `fetch`-compatible function bound to an undici `Agent`
 * configured with the cert as its CA. Validation stays on — we want
 * cert-mismatch to fail loudly, not silently — and `allowH2: true`
 * lets in-Node clients also benefit from HTTP/2 multiplexing for
 * concurrent SSE subscriptions (CLI batched calls, etc.).
 */

import { readFile } from 'node:fs/promises';
import { Agent, fetch as undiciFetch } from 'undici';

export interface TrustingFetchOptions {
  /** PEM-encoded cert (or Buffer of one). The trust anchor for this fetch. */
  cert: string | Buffer;
}

export function createTrustingFetch(opts: TrustingFetchOptions): typeof fetch {
  const dispatcher = new Agent({
    connect: {
      ca: opts.cert,
      // Default — keep validation on. Listed explicitly so a future
      // edit can't quietly weaken the trust check by omission.
      rejectUnauthorized: true,
    },
    allowH2: true,
    // Disable undici's 5-minute headers/body timeouts. The MCP bridge
    // and CLI both call legitimately long-running daemon endpoints —
    // `generate_image` (sd-cpp's diffusion loop), `npm_install`,
    // `run_playwright_script`, etc. — that can hold a single HTTP
    // request open well past 5 minutes before the route flushes its
    // first byte. Without this, the request aborts with a generic
    // `fetch failed` at exactly the 5-min mark even though the
    // daemon is still doing useful work. Per-tool timeouts are
    // already enforced by the MCP bridge (`TOOL_TIMEOUT_MS`).
    headersTimeout: 0,
    bodyTimeout: 0,
  });
  // Use undici's own `fetch` rather than Node's global `fetch`. Node's
  // bundled undici and the version we depend on directly can drift,
  // and dispatcher interfaces between drifted versions are NOT
  // ABI-compatible — passing an undici@8 Agent to Node's bundled
  // undici@7 fetch throws `invalid onRequestStart method` at request
  // time. Keeping both halves on the same package eliminates that
  // class of breakage entirely. The signature is intentionally cast
  // to the global `typeof fetch` so callers don't need to know about
  // the swap; the runtime semantics are identical for HTTPS GET/POST.
  return ((url: Parameters<typeof undiciFetch>[0], init?: Parameters<typeof undiciFetch>[1]) =>
    undiciFetch(url, { ...init, dispatcher })) as unknown as typeof fetch;
}

/**
 * Convenience wrapper for the common case: read the cert from
 * `~/.gezel/runtime/cert.pem` and build the fetch in one call.
 * Throws if the cert file isn't there — caller likely wants to
 * fall back to plain `fetch` in that case rather than retry.
 */
export async function createTrustingFetchFromPath(certPath: string): Promise<typeof fetch> {
  const cert = await readFile(certPath, 'utf8');
  return createTrustingFetch({ cert });
}

/**
 * Plain HTTP fetch with the same long-call-friendly timeout policy as
 * {@link createTrustingFetch}, for callers that hit a loopback daemon
 * over HTTP instead of HTTPS (operator escape hatch — `GEZEL_CERT_PATH`
 * unset). Without this, those callers fall back to the global `fetch`
 * and inherit Node's default 5-minute `headersTimeout`/`bodyTimeout`
 * — long-running tools (`generate_image`, `npm_install`,
 * `run_playwright_script`) abort at exactly 5 minutes with a generic
 * `fetch failed` while the daemon is still working.
 */
export function createPatientFetch(): typeof fetch {
  const dispatcher = new Agent({
    headersTimeout: 0,
    bodyTimeout: 0,
  });
  return ((url: Parameters<typeof undiciFetch>[0], init?: Parameters<typeof undiciFetch>[1]) =>
    undiciFetch(url, { ...init, dispatcher })) as unknown as typeof fetch;
}
