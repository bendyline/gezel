import { Agent, fetch as undiciFetch } from 'undici';

/**
 * Build a `fetch` configured to trust gezel's per-launch loopback TLS
 * cert. The daemon writes the cert to `<home>/runtime/cert.pem`; this
 * helper takes its PEM contents and produces a `fetch` bound to an
 * undici Agent with the cert as a CA.
 *
 * Validation stays on — cert-mismatch must fail loudly. `allowH2` is
 * enabled so SSE streams from `/v1/chat/completions` and
 * `/v1/models/ensure/:jobId/events` can multiplex over one TCP
 * connection.
 *
 * Without this helper, `UNABLE_TO_VERIFY_LEAF_SIGNATURE` is what
 * first-time integrations see when the daemon is serving HTTPS.
 * The SDK's `connect` flow uses it automatically; surfaced as a
 * named export so apps that build their own fetch pipeline can drop
 * it in.
 */
export interface CreateTrustingFetchOptions {
  /** PEM-encoded cert (or Buffer of one). */
  cert: string | Buffer;
}

export function createTrustingFetch(opts: CreateTrustingFetchOptions): typeof fetch {
  const dispatcher = new Agent({
    connect: {
      ca: opts.cert,
      rejectUnauthorized: true,
    },
    allowH2: true,
    // Disable undici's 5-min header/body timeouts. Long-running
    // model installs (`/v1/models/ensure`) and slow chat streams
    // hold a single HTTPS request well past 5 minutes; the SDK's
    // own per-call timeouts (when set) gate them at a higher
    // semantic level.
    headersTimeout: 0,
    bodyTimeout: 0,
  });
  return ((url: Parameters<typeof undiciFetch>[0], init?: Parameters<typeof undiciFetch>[1]) =>
    undiciFetch(url, { ...init, dispatcher })) as unknown as typeof fetch;
}

/**
 * Plain HTTP fetch with the same long-call timeouts policy. Used
 * when the daemon was launched with `GEZEL_INSECURE_TRANSPORT=1` and
 * no cert is on disk.
 */
export function createPatientFetch(): typeof fetch {
  const dispatcher = new Agent({
    headersTimeout: 0,
    bodyTimeout: 0,
  });
  return ((url: Parameters<typeof undiciFetch>[0], init?: Parameters<typeof undiciFetch>[1]) =>
    undiciFetch(url, { ...init, dispatcher })) as unknown as typeof fetch;
}
