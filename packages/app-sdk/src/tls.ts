/** Compatibility exports: the client Node entry owns TLS, timeouts, and disposal. */
export {
  createTrustingFetch,
  createPatientFetch,
  type ManagedFetch,
  type TrustingFetchOptions as CreateTrustingFetchOptions,
} from '@bendyline/gezel-client/node';

import { createPatientFetch, createTrustingFetch } from '@bendyline/gezel-client/node';

export interface SdkTransport {
  fetch: typeof fetch;
  /** Present only for a dispatcher created by this SDK. */
  close?: () => Promise<void>;
  /** Abort a failed discovery's sockets without waiting for a stalled response. */
  destroy?: () => Promise<void>;
}

export function createSdkTransport(cert: string | null, borrowed?: typeof fetch): SdkTransport {
  if (borrowed) return { fetch: borrowed };
  const ownedFetch = cert ? createTrustingFetch({ cert }) : createPatientFetch();
  return { fetch: ownedFetch, close: ownedFetch.close, destroy: ownedFetch.destroy };
}
