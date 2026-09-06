/** Node-only daemon transport. Fetch and dispatcher must use the same undici version. */
import { readFile } from 'node:fs/promises';
import { Agent, fetch as undiciFetch } from 'undici';

export interface TrustingFetchOptions {
  /** PEM trust anchor. Certificate and hostname validation stay enabled. */
  cert: string | Buffer;
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
    allowH2: true,
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
