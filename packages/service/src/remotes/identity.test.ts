import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SecretKey, SecretStore } from '../secrets/types.js';
import { stringifySecretKey } from '../secrets/types.js';
import {
  deviceIdentityScope,
  fingerprintOfPublicKeyPem,
  loadOrCreateDeviceIdentity,
  signCertFingerprint,
  verifyIdentitySignature,
} from './identity.js';

function memSecrets(): SecretStore {
  const map = new Map<string, string>();
  return {
    backend: 'file',
    async get(k: SecretKey) {
      return map.get(stringifySecretKey(k)) ?? null;
    },
    async set(k: SecretKey, v: string) {
      map.set(stringifySecretKey(k), v);
    },
    async delete(k: SecretKey) {
      map.delete(stringifySecretKey(k));
    },
    async has(k: SecretKey) {
      return map.has(stringifySecretKey(k));
    },
    async listForToolset() {
      return [];
    },
  };
}

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-identity-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true }).catch(() => {});
});

describe('device identity', () => {
  it('generates, persists, and reloads a stable identity', async () => {
    const secrets = memSecrets();
    const first = await loadOrCreateDeviceIdentity(home, secrets);
    expect(first.deviceId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(first.publicKeyPem).toContain('BEGIN PUBLIC KEY');
    expect(first.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    // Reload returns the SAME identity (no regeneration).
    const again = await loadOrCreateDeviceIdentity(home, secrets);
    expect(again.deviceId).toBe(first.deviceId);
    expect(again.fingerprint).toBe(first.fingerprint);
    expect(again.publicKeyPem).toBe(first.publicKeyPem);
  });

  it('fingerprint is the SHA-256 of the public key DER', async () => {
    const id = await loadOrCreateDeviceIdentity(home, memSecrets());
    expect(fingerprintOfPublicKeyPem(id.publicKeyPem)).toBe(id.fingerprint);
  });

  it('signs a cert fingerprint and verifies against the public key', async () => {
    const secrets = memSecrets();
    const id = await loadOrCreateDeviceIdentity(home, secrets);
    const sig = await signCertFingerprint(secrets, home, 'abc123');
    expect(sig).toBeTruthy();
    expect(verifyIdentitySignature(id.publicKeyPem, 'abc123', sig!)).toBe(true);
    // Tampered data / signature fail.
    expect(verifyIdentitySignature(id.publicKeyPem, 'abc124', sig!)).toBe(false);
    expect(verifyIdentitySignature(id.publicKeyPem, 'abc123', 'bm90LXNpZw==')).toBe(false);
  });

  it('regenerates (new identity) when the private key is missing', async () => {
    const secrets = memSecrets();
    const first = await loadOrCreateDeviceIdentity(home, secrets);
    // Wipe the key this home actually uses. Deleting the un-scoped legacy
    // account instead would leave the real entry in place and prove nothing.
    await secrets.delete({ kind: 'deviceIdentity', scope: deviceIdentityScope(home) });
    const second = await loadOrCreateDeviceIdentity(home, secrets);
    expect(second.deviceId).not.toBe(first.deviceId);
    expect(second.fingerprint).not.toBe(first.fingerprint);
    // And the new one can sign again.
    const sig = await signCertFingerprint(secrets, home, 'xyz');
    expect(verifyIdentitySignature(second.publicKeyPem, 'xyz', sig!)).toBe(true);
  });

  it('returns null sig when no identity key exists', async () => {
    expect(await signCertFingerprint(memSecrets(), home, 'data')).toBeNull();
  });
});
