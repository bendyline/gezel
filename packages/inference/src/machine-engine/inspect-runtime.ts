import type { SystemServiceRuntime } from '@bendyline/gezel-client/node';
import {
  IdentityResponseSchema,
  certFingerprintFromPem,
  fingerprintOfPublicKeyPem,
  verifyIdentitySignature,
} from '../remotes/identity.js';
import { createPinnedFetch } from '../remotes/pinned-fetch.js';
import type { PairedRemote } from '../remotes/types.js';
const MACHINE_REMOTE_ID = 'this-machine';
export async function inspectMachineRuntime(runtime: SystemServiceRuntime): Promise<PairedRemote> {
  const fetchImpl = runtime.cert ? createPinnedFetch(runtime.cert) : fetch;
  try {
    const response = await fetchImpl(`${runtime.baseUrl}/v1/identity`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`identity returned HTTP ${response.status}`);
    const identity = IdentityResponseSchema.parse(await response.json());
    if (identity.serviceRole !== 'machine-engine') {
      throw new Error(`runtime advertised unexpected role ${identity.serviceRole ?? '(missing)'}`);
    }
    if (
      fingerprintOfPublicKeyPem(identity.publicKeyPem) !== identity.fingerprint ||
      !identity.tlsCertPem ||
      !identity.tlsCertFingerprint ||
      !identity.sig ||
      certFingerprintFromPem(identity.tlsCertPem) !== identity.tlsCertFingerprint ||
      !verifyIdentitySignature(identity.publicKeyPem, identity.tlsCertFingerprint, identity.sig)
    ) {
      throw new Error('machine identity or TLS signature verification failed');
    }
    if (runtime.cert && certFingerprintFromPem(runtime.cert) !== identity.tlsCertFingerprint) {
      throw new Error('machine runtime certificate does not match its signed identity response');
    }
    return {
      remoteId: MACHINE_REMOTE_ID,
      baseUrl: runtime.baseUrl,
      displayName: 'This machine',
      token: runtime.token,
      pinnedIdentityKey: identity.publicKeyPem,
      pinnedIdentityFingerprint: identity.fingerprint,
      tlsCertPem: identity.tlsCertPem,
      ...(identity.gezelVersion ? { gezelVersion: identity.gezelVersion } : {}),
      scopes: ['remote-inference', 'machine-models', 'machine-knowledge-assets'],
      pairedAt: Date.now(),
      lastSeenAt: Date.now(),
      managed: 'machine-engine',
    };
  } finally {
    const close = (fetchImpl as Partial<{ close(): Promise<void> }>).close;
    if (typeof close === 'function') {
      await close.call(fetchImpl);
    }
  }
}
