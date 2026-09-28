/**
 * Node-only daemon transport with caller-owned deadlines and pinned TLS.
 * Fetch and dispatcher must use the same undici version. HTTP/2 negotiation
 * remains the default; the CLI can opt its whole process into HTTP/1.1 with
 * GEZEL_HTTP_VERSION=1.1, including transports created by discovery and the SDK.
 */
import { readFile } from 'node:fs/promises';
import { Agent, fetch as undiciFetch } from 'undici';

export interface TrustingFetchOptions {
  /** PEM trust anchor. Certificate and hostname validation stay enabled. */
  cert: string | Buffer;
  /** Override the process's GEZEL_HTTP_VERSION choice; auto permits HTTP/2 negotiation. */
  httpVersion?: 'auto' | '1.1';
}

/** The creator owns this dispatcher; borrowed clients must not close it. */
export type ManagedFetch = typeof fetch & {
  /** Stop accepting requests and drain open responses. Consume/cancel SSE bodies first. */
  close(): Promise<void>;
  /** Abort open requests and release sockets immediately. */
  destroy(): Promise<void>;
};

function createManagedFetch(options: Agent.Options): ManagedFetch {
  const dispatcher = new Agent({
    ...options,
    // Semantic callers own deadlines. Native inference/tool calls can exceed five minutes.
    headersTimeout: 0,
    bodyTimeout: 0,
  });
  const request = ((
    url: Parameters<typeof undiciFetch>[0],
    init?: Parameters<typeof undiciFetch>[1],
  ) => undiciFetch(url, { ...init, dispatcher })) as unknown as typeof fetch;
  let closing: Promise<void> | undefined;
  let destroying: Promise<void> | undefined;
  return Object.assign(request, {
    close: () => {
      closing ??= dispatcher.close();
      return closing;
    },
    destroy: () => {
      destroying ??= dispatcher.destroy();
      return destroying;
    },
  });
}

export function createTrustingFetch(opts: TrustingFetchOptions): ManagedFetch {
  return createManagedFetch({
    connect: { ca: opts.cert, rejectUnauthorized: true },
    // HTTP/1.1 uses the pool's independent connections so SSE cannot block uploads.
    allowH2: (opts.httpVersion ?? process.env.GEZEL_HTTP_VERSION) !== '1.1',
  });
}

/** Throws when the certificate cannot be read; never silently disables TLS validation. */
export async function createTrustingFetchFromPath(certPath: string): Promise<ManagedFetch> {
  return createTrustingFetch({ cert: await readFile(certPath, 'utf8') });
}

/** Plain HTTP transport with the same caller-owned deadline and disposal contract. */
export function createPatientFetch(): ManagedFetch {
  return createManagedFetch({});
}
