import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateLoopbackCert } from '../http/cert.js';
import type { SecretKey, SecretStore } from '../secrets/types.js';
import { stringifySecretKey } from '../secrets/types.js';
import {
  certFingerprintFromPem,
  loadOrCreateDeviceIdentity,
  signCertFingerprint,
} from './identity.js';
import {
  inspectRemoteIdentity,
  normalizeRemoteBaseUrl,
  remoteIdForFingerprint,
} from './pairing.js';
import { createPairedRemoteFetch } from './pinned-fetch.js';
import type { PairedRemote, RemotesRegistry } from './registry.js';

function memSecrets(): SecretStore {
  const values = new Map<string, string>();
  return {
    backend: 'file',
    async get(key: SecretKey) {
      return values.get(stringifySecretKey(key)) ?? null;
    },
    async set(key: SecretKey, value: string) {
      values.set(stringifySecretKey(key), value);
    },
    async delete(key: SecretKey) {
      values.delete(stringifySecretKey(key));
    },
    async has(key: SecretKey) {
      return values.has(stringifySecretKey(key));
    },
    async listForToolset() {
      return [];
    },
  };
}

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-pairing-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true }).catch(() => undefined);
});

async function signedIdentity() {
  const secrets = memSecrets();
  const identity = await loadOrCreateDeviceIdentity(home, secrets);
  const cert = await generateLoopbackCert();
  const tlsCertFingerprint = certFingerprintFromPem(cert.certPem);
  const sig = await signCertFingerprint(secrets, tlsCertFingerprint);
  return {
    ...identity,
    tlsCertPem: cert.certPem,
    tlsCertFingerprint,
    sig: sig!,
  };
}

describe('remote pairing trust', () => {
  it('uses the complete identity fingerprint as the collision-resistant remote id', () => {
    const fingerprint = 'ab'.repeat(32);
    expect(remoteIdForFingerprint(fingerprint)).toBe(fingerprint);
    expect(remoteIdForFingerprint(fingerprint)).toHaveLength(64);
  });

  it('accepts only an exact HTTPS origin as a remote base URL', () => {
    expect(normalizeRemoteBaseUrl('https://Example.COM:443/')).toBe('https://example.com');
    expect(() => normalizeRemoteBaseUrl('http://example.com')).toThrow(/exact HTTPS origin/);
    expect(() => normalizeRemoteBaseUrl('https://example.com/api')).toThrow(/exact HTTPS origin/);
    expect(() => normalizeRemoteBaseUrl('https://user@example.com')).toThrow(/exact HTTPS origin/);
  });

  it('accepts only a self-consistent, signed identity document during inspection', async () => {
    const identity = await signedIdentity();
    const fetchIdentity = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(identity), {
        headers: { 'content-type': 'application/json' },
      }),
    );
    await expect(
      inspectRemoteIdentity('https://192.0.2.10:43936/', fetchIdentity as typeof fetch),
    ).resolves.toMatchObject({ fingerprint: identity.fingerprint });
    expect(fetchIdentity).toHaveBeenCalledWith(
      'https://192.0.2.10:43936/v1/identity',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    fetchIdentity.mockResolvedValueOnce(
      new Response(JSON.stringify({ ...identity, sig: 'bm90LWEtc2lnbmF0dXJl' })),
    );
    await expect(
      inspectRemoteIdentity('https://192.0.2.10:43936', fetchIdentity as typeof fetch),
    ).rejects.toThrow(/signature/);
  });

  it('accepts a rotated TLS certificate only when the pinned device identity signs it', async () => {
    const identity = await signedIdentity();
    const remote: PairedRemote = {
      remoteId: identity.fingerprint,
      baseUrl: 'https://192.0.2.10:43936',
      displayName: 'Remote',
      token: 'TOKEN',
      pinnedIdentityKey: identity.publicKeyPem,
      pinnedIdentityFingerprint: identity.fingerprint,
      tlsCertPem: 'OLD-CERT',
      scopes: ['remote-inference'],
      pairedAt: Date.now(),
    };
    const update = vi.fn().mockResolvedValue(true);
    const registry = { update } as unknown as RemotesRegistry;
    const oldFetch = vi.fn().mockRejectedValue(new Error('old certificate rejected'));
    const newFetch = vi.fn().mockResolvedValue(new Response('ok'));
    const createPinned = vi.fn(
      (certPem: string) =>
        (certPem === 'OLD-CERT' ? oldFetch : newFetch) as unknown as typeof fetch,
    );
    const bootstrap = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(identity))) as unknown as typeof fetch;

    const pairedFetch = createPairedRemoteFetch(remote, registry, {
      createPinned,
      createBootstrap: () => bootstrap,
    });
    await expect(pairedFetch(`${remote.baseUrl}/v1/remote/models`)).resolves.toBeInstanceOf(
      Response,
    );

    expect(update).toHaveBeenCalledWith(remote.remoteId, { tlsCertPem: identity.tlsCertPem });
    expect(remote.tlsCertPem).toBe(identity.tlsCertPem);
    expect(newFetch).toHaveBeenCalledTimes(1);
  });

  it('does not update the cert pin when refresh identity verification fails', async () => {
    const identity = await signedIdentity();
    const remote: PairedRemote = {
      remoteId: identity.fingerprint,
      baseUrl: 'https://192.0.2.10:43936',
      displayName: 'Remote',
      token: 'TOKEN',
      pinnedIdentityKey: identity.publicKeyPem,
      pinnedIdentityFingerprint: identity.fingerprint,
      tlsCertPem: 'OLD-CERT',
      scopes: ['remote-inference'],
      pairedAt: Date.now(),
    };
    const update = vi.fn();
    const registry = { update } as unknown as RemotesRegistry;
    const bootstrap = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ ...identity, sig: 'dGFtcGVyZWQ=' })),
      ) as unknown as typeof fetch;
    const pairedFetch = createPairedRemoteFetch(remote, registry, {
      createPinned: () => vi.fn().mockRejectedValue(new Error('old certificate rejected')) as never,
      createBootstrap: () => bootstrap,
    });

    await expect(pairedFetch(`${remote.baseUrl}/v1/remote/models`)).rejects.toThrow(
      /old certificate rejected/,
    );
    expect(update).not.toHaveBeenCalled();
    expect(remote.tlsCertPem).toBe('OLD-CERT');
  });
});
