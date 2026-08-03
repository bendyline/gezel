import { describe, expect, it } from 'vitest';
import {
  type KeyringEntryFactory,
  KeyringSecretStore,
  probeKeyringAvailable,
} from './keyring-store.js';
import type { ProviderCredentialName, SecretKey } from './types.js';

// The store's positive TTL is 5s; advancing just past it forces a refresh.
const POSITIVE_TTL_MS_OVER = 6_000;

/**
 * In-memory stand-in for `@napi-rs/keyring`. `locked` makes every operation
 * throw (a locked Secret Service collection), and missing entries throw on
 * read the way the native binding does — so the store's failure path is
 * exercised for both "absent" and "locked". Counters let tests assert how many
 * real keyring round-trips a sequence of `get()`s actually made.
 */
class FakeKeychain {
  readonly store = new Map<string, string>();
  locked = false;
  getCalls = 0;
  setCalls = 0;

  readonly factory: KeyringEntryFactory = (_service, account) => ({
    getPassword: () => {
      this.getCalls++;
      if (this.locked) throw new Error('secret service collection is locked');
      const v = this.store.get(account);
      if (v === undefined) throw new Error('no matching entry');
      return v;
    },
    setPassword: (value: string) => {
      this.setCalls++;
      if (this.locked) throw new Error('secret service collection is locked');
      this.store.set(account, value);
    },
    deletePassword: () => {
      if (this.locked) throw new Error('secret service collection is locked');
      if (!this.store.delete(account)) throw new Error('no matching entry');
    },
  });
}

const cred = (name: ProviderCredentialName): SecretKey => ({ kind: 'providerCredential', name });

describe('KeyringSecretStore caching', () => {
  it('serves repeated reads from cache within the positive TTL', async () => {
    const kc = new FakeKeychain();
    kc.store.set('providerCredential:anthropicApiKey', 'sk-live');
    let t = 1000;
    const store = new KeyringSecretStore({ entryFactory: kc.factory, now: () => t });
    const key = cred('anthropicApiKey');

    expect(await store.get(key)).toBe('sk-live');
    expect(await store.get(key)).toBe('sk-live');
    expect(await store.get(key)).toBe('sk-live');
    expect(kc.getCalls).toBe(1);

    t += POSITIVE_TTL_MS_OVER;
    expect(await store.get(key)).toBe('sk-live');
    expect(kc.getCalls).toBe(2);
  });

  it('set updates the cache without an extra read and persists the value', async () => {
    const kc = new FakeKeychain();
    const t = 0;
    const store = new KeyringSecretStore({ entryFactory: kc.factory, now: () => t });
    const key = cred('openaiApiKey');

    await store.set(key, 'sk-2');
    expect(kc.store.get('providerCredential:openaiApiKey')).toBe('sk-2');

    const readsBefore = kc.getCalls;
    expect(await store.get(key)).toBe('sk-2');
    expect(kc.getCalls).toBe(readsBefore);
  });

  it('lets the active backend overwrite stale migration values', async () => {
    const kc = new FakeKeychain();
    kc.store.set('providerCredential:openaiApiKey', 'stale-keyring-value');
    const store = new KeyringSecretStore({ entryFactory: kc.factory });

    await store.importEntries(
      new Map([['providerCredential:openaiApiKey', 'active-file-value']]),
      true,
    );

    expect(await store.get(cred('openaiApiKey'))).toBe('active-file-value');
  });

  it('collapses a locked-keyring read storm into a single probe (no prompt loop)', async () => {
    const kc = new FakeKeychain();
    kc.store.set('providerCredential:anthropicApiKey', 'sk-live');
    kc.locked = true; // value exists but the collection is locked → would prompt
    let t = 0;
    const store = new KeyringSecretStore({ entryFactory: kc.factory, now: () => t });
    const key = cred('anthropicApiKey');

    // Simulate the ~per-minute fan-out hammering the same key.
    for (let i = 0; i < 25; i++) {
      t += 100; // 2.5s total — well inside the initial backoff window
      await expect(store.get(key)).rejects.toThrow(/keychain is unavailable/);
    }
    // Exactly one real keyring round-trip → exactly one unlock prompt, not 25.
    expect(kc.getCalls).toBe(1);
  });

  it('recovers once the keyring is unlocked and the backoff window elapses', async () => {
    const kc = new FakeKeychain();
    kc.store.set('providerCredential:githubToken', 'gh-live');
    kc.locked = true;
    let t = 0;
    const store = new KeyringSecretStore({ entryFactory: kc.factory, now: () => t });
    const key = cred('githubToken');

    await expect(store.get(key)).rejects.toThrow(/keychain is unavailable/);
    expect(kc.getCalls).toBe(1);

    kc.locked = false;
    t += 20_000; // past the 15s initial backoff
    expect(await store.get(key)).toBe('gh-live');
    expect(kc.getCalls).toBe(2);
  });

  it('escalates the backoff window on repeated failure', async () => {
    const kc = new FakeKeychain();
    kc.locked = true;
    let t = 0;
    const store = new KeyringSecretStore({ entryFactory: kc.factory, now: () => t });
    const key = cred('braveSearchApiKey');

    await expect(store.get(key)).rejects.toThrow(); // read #1 → backoff 15s
    expect(kc.getCalls).toBe(1);

    t = 14_000;
    await expect(store.get(key)).rejects.toThrow(); // still inside 15s window → cached
    expect(kc.getCalls).toBe(1);

    t = 15_001;
    await expect(store.get(key)).rejects.toThrow(); // elapsed → read #2
    expect(kc.getCalls).toBe(2);

    t = 44_000;
    await expect(store.get(key)).rejects.toThrow(); // inside 30s window → cached
    expect(kc.getCalls).toBe(2);

    t = 46_000;
    await expect(store.get(key)).rejects.toThrow(); // elapsed → read #3
    expect(kc.getCalls).toBe(3);
  });
});

describe('KeyringSecretStore device identity migration', () => {
  const identityScope = '0123456789abcdef';
  const identityKey: SecretKey = { kind: 'deviceIdentity', scope: identityScope };

  it('keeps the scoped identity out of the legacy global index', async () => {
    const kc = new FakeKeychain();
    const store = new KeyringSecretStore({
      entryFactory: kc.factory,
      identityScope,
    });

    await store.set(identityKey, 'private-key');

    expect(kc.store.get(`deviceIdentity:${identityScope}`)).toBe('private-key');
    expect(kc.store.has('__gezel_index__')).toBe(false);
  });

  it('exports the current scoped identity even though it is absent from the global index', async () => {
    const kc = new FakeKeychain();
    const store = new KeyringSecretStore({
      entryFactory: kc.factory,
      identityScope,
    });
    await store.set(identityKey, 'private-key');

    expect(await store.exportEntries()).toEqual(
      new Map([[`deviceIdentity:${identityScope}`, 'private-key']]),
    );
  });

  it('falls back to the legacy identity during a backend migration', async () => {
    const kc = new FakeKeychain();
    kc.store.set('deviceIdentity', 'legacy-private-key');
    const store = new KeyringSecretStore({
      entryFactory: kc.factory,
      identityScope,
    });

    expect(await store.exportEntries()).toEqual(
      new Map([['deviceIdentity', 'legacy-private-key']]),
    );
  });

  it('imports a legacy file-backed identity directly into the scoped account', async () => {
    const kc = new FakeKeychain();
    const store = new KeyringSecretStore({
      entryFactory: kc.factory,
      identityScope,
    });

    await store.importEntries(new Map([['deviceIdentity', 'legacy-private-key']]), true);

    expect(kc.store.get(`deviceIdentity:${identityScope}`)).toBe('legacy-private-key');
    expect(kc.store.has('deviceIdentity')).toBe(false);
    expect(kc.store.has('__gezel_index__')).toBe(false);
  });

  it('prefers an already-scoped identity when a migration source contains both forms', async () => {
    const kc = new FakeKeychain();
    const store = new KeyringSecretStore({
      entryFactory: kc.factory,
      identityScope,
    });

    await store.importEntries(
      new Map([
        ['deviceIdentity', 'legacy-private-key'],
        [`deviceIdentity:${identityScope}`, 'scoped-private-key'],
      ]),
      true,
    );

    expect(kc.store.get(`deviceIdentity:${identityScope}`)).toBe('scoped-private-key');
    expect(kc.store.has('deviceIdentity')).toBe(false);
  });
});

describe('probeKeyringAvailable', () => {
  it('uses a unique account and ignores a retained fixed probe item', () => {
    const kc = new FakeKeychain();
    kc.store.set('__gezel_probe__', 'retained-by-an-old-build');

    expect(probeKeyringAvailable({ entryFactory: kc.factory, probeId: 'test-run' })).toBeNull();
    expect(kc.store.get('__gezel_probe__')).toBe('retained-by-an-old-build');
    expect(kc.store.has('__gezel_probe__:test-run')).toBe(false);
  });
});
