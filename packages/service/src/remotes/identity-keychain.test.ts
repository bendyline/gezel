/**
 * The acceptance matrix for the macOS Keychain identity collision.
 *
 * These run against `MacKeychainFixture`, whose overwrite behaviour matches
 * the real Keychain — in particular that writing over an item created by a
 * differently-signed build raises errSecDuplicateItem rather than silently
 * replacing it. The permissive in-memory store in identity.test.ts cannot
 * express that, which is why the collision reached a signed release.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KeyringSecretStore } from '../secrets/keyring-store.js';
import { MacKeychainFixture } from '../secrets/macos-keychain-fixture.js';
import { SecretBackendUnavailableError } from '../secrets/types.js';
import {
  deviceIdentityScope,
  loadOrCreateDeviceIdentity,
  signCertFingerprint,
} from './identity.js';

let homeA: string;
let homeB: string;

beforeEach(async () => {
  homeA = await mkdtemp(join(tmpdir(), 'gezel-kc-a-'));
  homeB = await mkdtemp(join(tmpdir(), 'gezel-kc-b-'));
});
afterEach(async () => {
  await rm(homeA, { recursive: true, force: true }).catch(() => {});
  await rm(homeB, { recursive: true, force: true }).catch(() => {});
});

function storeFor(fixture: MacKeychainFixture): KeyringSecretStore {
  return new KeyringSecretStore({ entryFactory: fixture.entryFactory });
}

function accountFor(home: string): string {
  return `deviceIdentity:${deviceIdentityScope(home)}`;
}

function privatePemFor(fixture: MacKeychainFixture, home: string): string {
  const value = fixture.items.get(accountFor(home))?.value;
  if (!value) throw new Error(`missing private identity for ${home}`);
  const parsed = JSON.parse(value) as { privateKeyPem?: unknown };
  if (typeof parsed.privateKeyPem !== 'string') throw new Error('invalid private identity fixture');
  return parsed.privateKeyPem;
}

describe('macOS keychain fixture', () => {
  it('reproduces the shipped failure: writing over a foreign item is a duplicate-item error', () => {
    const fixture = new MacKeychainFixture({
      seed: { deviceIdentity: { value: 'old-key', owner: 'foreign' } },
    });
    const entry = fixture.entryFactory('gezel', 'deviceIdentity');
    expect(() => entry.setPassword('new-key')).toThrowError(
      /The specified item already exists in the keychain/,
    );
  });

  it('does not report a foreign item as missing', () => {
    const fixture = new MacKeychainFixture({
      seed: { deviceIdentity: { value: 'old-key', owner: 'foreign' } },
    });
    const entry = fixture.entryFactory('gezel', 'deviceIdentity');
    expect(() => entry.getPassword()).toThrowError(/not correct/);
  });
});

describe('1. clean macOS user, no Gezel state and no keychain entry', () => {
  it('creates an identity and can sign with it', async () => {
    const secrets = storeFor(new MacKeychainFixture());
    const identity = await loadOrCreateDeviceIdentity(homeA, secrets);

    expect(identity.deviceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(identity.fingerprint).toHaveLength(64);
    expect(await signCertFingerprint(secrets, homeA, 'tls-fp')).toBeTruthy();
  });

  it('stores the private half under a home-scoped account, not the global one', async () => {
    const fixture = new MacKeychainFixture();
    await loadOrCreateDeviceIdentity(homeA, storeFor(fixture));

    expect([...fixture.items.keys()]).toContain(accountFor(homeA));
    expect(fixture.items.has('deviceIdentity')).toBe(false);
  });
});

describe('2. upgrade from the previous signed beta', () => {
  it('boots instead of dying on the retained global keychain item', async () => {
    // Exactly this Mac's state: a `gezel/deviceIdentity` item written by an
    // earlier build, unreadable to the new one, and no public identity file.
    const fixture = new MacKeychainFixture({
      seed: { deviceIdentity: { value: 'previous-build-key', owner: 'foreign' } },
    });

    const identity = await loadOrCreateDeviceIdentity(homeA, storeFor(fixture));
    expect(identity.fingerprint).toHaveLength(64);
  });

  it('rotates safely when the previous public file remains but its legacy key is ACL-inaccessible', async () => {
    const seed = new MacKeychainFixture();
    const previous = await loadOrCreateDeviceIdentity(homeA, storeFor(seed));
    const previousPrivate = privatePemFor(seed, homeA);
    const fixture = new MacKeychainFixture({
      seed: { deviceIdentity: { value: previousPrivate, owner: 'foreign' } },
    });

    const current = await loadOrCreateDeviceIdentity(homeA, storeFor(fixture));

    expect(current.fingerprint).not.toBe(previous.fingerprint);
    expect(fixture.items.get('deviceIdentity')).toEqual({
      value: previousPrivate,
      owner: 'foreign',
    });
    expect(fixture.items.has(accountFor(homeA))).toBe(true);
    expect(await signCertFingerprint(storeFor(fixture), homeA, 'tls-fp')).toBeTruthy();
  });

  it('does not consult the retained foreign global index when creating a scoped identity', async () => {
    const fixture = new MacKeychainFixture({
      seed: {
        deviceIdentity: { value: 'previous-build-key', owner: 'foreign' },
        __gezel_index__: { value: '["deviceIdentity"]', owner: 'foreign' },
      },
    });

    const identity = await loadOrCreateDeviceIdentity(homeA, storeFor(fixture));
    expect(identity.fingerprint).toHaveLength(64);
    expect(fixture.calls).not.toContain('get:__gezel_index__');
  });

  it('leaves the legacy entry untouched so a downgrade still finds it', async () => {
    const fixture = new MacKeychainFixture({
      seed: { deviceIdentity: { value: 'previous-build-key', owner: 'foreign' } },
    });
    await loadOrCreateDeviceIdentity(homeA, storeFor(fixture));

    expect(fixture.items.get('deviceIdentity')).toEqual({
      value: 'previous-build-key',
      owner: 'foreign',
    });
  });

  it('migrates a readable legacy key in place, preserving the pinned fingerprint', async () => {
    // A same-signature upgrade: the old key IS readable, and the public file
    // proves it belongs to this home. Identity must not rotate.
    const first = new MacKeychainFixture();
    const seeded = await loadOrCreateDeviceIdentity(homeA, storeFor(first));
    const privateKey = privatePemFor(first, homeA);

    const legacy = new MacKeychainFixture({
      seed: { deviceIdentity: { value: privateKey, owner: 'self' } },
    });
    const secrets = storeFor(legacy);
    const after = await loadOrCreateDeviceIdentity(homeA, secrets);

    expect(after.fingerprint).toBe(seeded.fingerprint);
    expect(after.deviceId).toBe(seeded.deviceId);
    expect(privatePemFor(legacy, homeA)).toBe(privateKey);
    expect(await signCertFingerprint(secrets, homeA, 'tls-fp')).toBeTruthy();

    await Promise.all([
      rm(join(homeA, 'device-identity.json'), { force: true }),
      rm(join(homeA, 'device-identity.json.bak'), { force: true }),
    ]);
    const recovered = await loadOrCreateDeviceIdentity(homeA, storeFor(legacy));
    expect(recovered).toEqual(seeded);
  });

  it('refuses to adopt a legacy key belonging to a different home', async () => {
    const other = new MacKeychainFixture();
    await loadOrCreateDeviceIdentity(homeB, storeFor(other));
    const foreignKey = privatePemFor(other, homeB);

    const seedFixture = new MacKeychainFixture();
    const seededA = await loadOrCreateDeviceIdentity(homeA, storeFor(seedFixture));

    // homeA has a public file, but the legacy entry holds homeB's key.
    const fixture = new MacKeychainFixture({
      seed: { deviceIdentity: { value: foreignKey, owner: 'self' } },
    });
    const regenerated = await loadOrCreateDeviceIdentity(homeA, storeFor(fixture));

    expect(regenerated.fingerprint).not.toBe(seededA.fingerprint);
    expect(fixture.items.get(accountFor(homeA))?.value).not.toBe(foreignKey);
  });
});

describe('3. Gezel home deleted while the keychain item remains', () => {
  it('recovers the same identity rather than rotating it', async () => {
    const fixture = new MacKeychainFixture();
    const secrets = storeFor(fixture);
    const original = await loadOrCreateDeviceIdentity(homeA, secrets);

    await Promise.all([
      rm(join(homeA, 'device-identity.json'), { force: true }),
      rm(join(homeA, 'device-identity.json.bak'), { force: true }),
    ]);
    const recovered = await loadOrCreateDeviceIdentity(homeA, storeFor(fixture));

    expect(recovered.fingerprint).toBe(original.fingerprint);
    expect(recovered.publicKeyPem).toBe(original.publicKeyPem);
    expect(recovered.deviceId).toBe(original.deviceId);
  });

  it('regenerates when the stored private key is unusable', async () => {
    const fixture = new MacKeychainFixture();
    const original = await loadOrCreateDeviceIdentity(homeA, storeFor(fixture));

    await Promise.all([
      rm(join(homeA, 'device-identity.json'), { force: true }),
      rm(join(homeA, 'device-identity.json.bak'), { force: true }),
    ]);
    fixture.items.set(accountFor(homeA), { value: 'not-a-pem', owner: 'self' });

    const regenerated = await loadOrCreateDeviceIdentity(homeA, storeFor(fixture));
    expect(regenerated.fingerprint).not.toBe(original.fingerprint);
  });
});

describe('4. two intentional GEZEL_HOME values under one login', () => {
  it('gives each home its own identity and its own keychain account', async () => {
    const fixture = new MacKeychainFixture();
    const a = await loadOrCreateDeviceIdentity(homeA, storeFor(fixture));
    const b = await loadOrCreateDeviceIdentity(homeB, storeFor(fixture));

    expect(a.fingerprint).not.toBe(b.fingerprint);
    expect(a.deviceId).not.toBe(b.deviceId);
    expect(fixture.items.has(accountFor(homeA))).toBe(true);
    expect(fixture.items.has(accountFor(homeB))).toBe(true);
  });

  it('initializing the second home does not disturb the first', async () => {
    const fixture = new MacKeychainFixture();
    const secretsA = storeFor(fixture);
    const a = await loadOrCreateDeviceIdentity(homeA, secretsA);
    await loadOrCreateDeviceIdentity(homeB, storeFor(fixture));

    const reloaded = await loadOrCreateDeviceIdentity(homeA, storeFor(fixture));
    expect(reloaded.fingerprint).toBe(a.fingerprint);
    expect(await signCertFingerprint(storeFor(fixture), homeA, 'tls-fp')).toBeTruthy();
  });

  it('scope is stable across restarts and distinct per home', () => {
    expect(deviceIdentityScope(homeA)).toBe(deviceIdentityScope(homeA));
    expect(deviceIdentityScope(homeA)).not.toBe(deviceIdentityScope(homeB));
    expect(deviceIdentityScope(`${homeA}/`)).toBe(deviceIdentityScope(homeA));
  });
});

describe('5. locked keychain with a keyring backend already selected', () => {
  it('keeps the persisted identity instead of destroying it', async () => {
    const fixture = new MacKeychainFixture();
    const original = await loadOrCreateDeviceIdentity(homeA, storeFor(fixture));

    fixture.locked = true;
    const afterLock = await loadOrCreateDeviceIdentity(homeA, storeFor(fixture));

    expect(afterLock.fingerprint).toBe(original.fingerprint);
    expect(fixture.items.get(accountFor(homeA))?.value).toBeTruthy();
  });

  it('degrades signing to null rather than throwing', async () => {
    const fixture = new MacKeychainFixture();
    await loadOrCreateDeviceIdentity(homeA, storeFor(fixture));

    fixture.locked = true;
    expect(await signCertFingerprint(storeFor(fixture), homeA, 'tls-fp')).toBeNull();
  });

  it('fails with an actionable error when there is nothing to fall back on', async () => {
    const fixture = new MacKeychainFixture({ locked: true });
    await expect(loadOrCreateDeviceIdentity(homeA, storeFor(fixture))).rejects.toThrow(
      SecretBackendUnavailableError,
    );
    await expect(loadOrCreateDeviceIdentity(homeA, storeFor(fixture))).rejects.toThrow(
      /Unlock the OS keychain/,
    );
  });
});
