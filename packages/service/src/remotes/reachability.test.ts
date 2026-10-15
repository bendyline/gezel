import { describe, expect, it, vi } from 'vitest';
import type { inspectRemoteIdentity } from './pairing.js';
import {
  REMOTE_FRESH_MS,
  REMOTE_OFFLINE_RECHECK_MS,
  createRemoteReachability,
  relocateRemote,
} from './reachability.js';
import type { PairedRemote, RemotesRegistry } from './registry.js';

const FP = 'ab'.repeat(32);

function remote(overrides: Partial<PairedRemote> = {}): PairedRemote {
  return {
    remoteId: FP,
    baseUrl: 'https://192.168.1.20:6229',
    displayName: 'Werkbank',
    token: 'token',
    pinnedIdentityKey: 'pem',
    pinnedIdentityFingerprint: FP,
    scopes: ['remote-inference'],
    pairedAt: 1,
    ...overrides,
  };
}

function fakeRegistry(entries: PairedRemote[]): RemotesRegistry & { touched: string[] } {
  const map = new Map(entries.map((e) => [e.remoteId, e]));
  const touched: string[] = [];
  return {
    touched,
    list: () => [...map.values()],
    get: (id) => map.get(id) ?? null,
    add: async (r) => {
      map.set(r.remoteId, r);
    },
    setEphemeral: (r) => {
      map.set(r.remoteId, r);
    },
    removeEphemeral: (id) => map.delete(id),
    update: async (id, patch) => {
      const existing = map.get(id);
      if (!existing) return false;
      map.set(id, { ...existing, ...patch, remoteId: id });
      return true;
    },
    remove: async (id) => map.delete(id),
    touch: (id) => {
      touched.push(id);
    },
  };
}

const refused = () =>
  new TypeError('fetch failed', {
    cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
  });

describe('createRemoteReachability', () => {
  it('probes a server it has not heard from, then trusts the answer while it is fresh', async () => {
    let now = 1_000_000;
    const registry = fakeRegistry([remote()]);
    const probe = vi.fn(async () => {});
    const reach = createRemoteReachability({
      registry,
      probe,
      relocate: async () => null,
      now: () => now,
    });
    expect(reach.status(FP)).toBe('unknown');
    await expect(reach.check(FP)).resolves.toBe('online');
    expect(probe).toHaveBeenCalledTimes(1);
    expect(registry.touched).toEqual([FP]);

    now += REMOTE_FRESH_MS - 1;
    await expect(reach.check(FP)).resolves.toBe('online');
    expect(probe).toHaveBeenCalledTimes(1);

    now += 2;
    await reach.check(FP);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('marks a server that cannot be reached offline, and re-probes only after a pause', async () => {
    let now = 1_000_000;
    const probe = vi.fn(async (): Promise<void> => {
      throw refused();
    });
    const reach = createRemoteReachability({
      registry: fakeRegistry([remote()]),
      probe,
      relocate: async () => null,
      now: () => now,
    });
    await expect(reach.check(FP)).resolves.toBe('offline');
    await expect(reach.check(FP)).resolves.toBe('offline');
    expect(probe).toHaveBeenCalledTimes(1);
    now += REMOTE_OFFLINE_RECHECK_MS;
    probe.mockResolvedValueOnce(undefined);
    await expect(reach.check(FP)).resolves.toBe('online');
  });

  it('treats a server that answered with an error as reachable', async () => {
    const reach = createRemoteReachability({
      registry: fakeRegistry([remote()]),
      probe: async () => {
        throw new Error('remote identity refresh returned HTTP 500');
      },
      relocate: async () => null,
    });
    await expect(reach.check(FP)).resolves.toBe('online');
  });

  it('follows a server that moved to a new address', async () => {
    const registry = fakeRegistry([remote()]);
    const probe = vi.fn(async (r: PairedRemote) => {
      if (r.baseUrl.includes('192.168.1.20')) throw refused();
    });
    const relocate = vi.fn(async (r: PairedRemote) => {
      await registry.update(r.remoteId, { baseUrl: 'https://192.168.1.77:6229' });
      return 'https://192.168.1.77:6229';
    });
    const reach = createRemoteReachability({ registry, probe, relocate });
    await expect(reach.check(FP)).resolves.toBe('online');
    expect(registry.get(FP)?.baseUrl).toBe('https://192.168.1.77:6229');
  });

  it('coalesces concurrent checks into one probe', async () => {
    let release!: () => void;
    const probe = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const reach = createRemoteReachability({
      registry: fakeRegistry([remote()]),
      probe,
      relocate: async () => null,
    });
    const a = reach.check(FP);
    const b = reach.check(FP);
    release();
    await expect(Promise.all([a, b])).resolves.toEqual(['online', 'online']);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("never probes this computer's own machine engine", async () => {
    const probe = vi.fn(async () => {});
    const reach = createRemoteReachability({
      registry: fakeRegistry([remote({ managed: 'machine-engine' })]),
      probe,
    });
    await expect(reach.check(FP)).resolves.toBe('online');
    expect(probe).not.toHaveBeenCalled();
  });

  it('follows a sighting at a new address, and ignores one at the known address', async () => {
    const relocate = vi.fn(async () => 'https://192.168.1.77:6229');
    const reach = createRemoteReachability({
      registry: fakeRegistry([remote()]),
      probe: async () => {},
      relocate,
    });
    reach.noteSighting(FP, 'https://192.168.1.20:6229');
    expect(relocate).not.toHaveBeenCalled();
    reach.noteSighting(FP, 'https://192.168.1.77:6229');
    await vi.waitFor(() => expect(reach.status(FP)).toBe('online'));
    expect(relocate).toHaveBeenCalledWith(
      expect.objectContaining({ remoteId: FP }),
      'https://192.168.1.77:6229',
    );
  });
});

describe('relocateRemote', () => {
  it('adopts the new address only when the server there proves the pinned identity', async () => {
    const { generateKeyPairSync } = await import('node:crypto');
    const { fingerprintOfPublicKeyPem } = await import(
      '@bendyline/gezel-inference/internal/remotes/identity'
    );
    const { publicKey } = generateKeyPairSync('ed25519');
    const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const fp = fingerprintOfPublicKeyPem(pem);
    const registry = fakeRegistry([remote({ remoteId: fp, pinnedIdentityFingerprint: fp })]);
    const inspect = vi.fn(async () => ({
      deviceId: 'srv',
      publicKeyPem: pem,
      fingerprint: fp,
      tlsCertPem: 'NEW-CERT',
    })) as unknown as typeof inspectRemoteIdentity;

    const moved = await relocateRemote(registry.get(fp)!, {
      registry,
      browser: null,
      candidate: 'https://192.168.1.77:6229',
      inspect,
    });
    expect(moved).toBe('https://192.168.1.77:6229');
    expect(registry.get(fp)).toMatchObject({
      baseUrl: 'https://192.168.1.77:6229',
      tlsCertPem: 'NEW-CERT',
    });
  });

  it('refuses a device announcing a fingerprint it cannot prove', async () => {
    const { generateKeyPairSync } = await import('node:crypto');
    const impostorKey = generateKeyPairSync('ed25519')
      .publicKey.export({ type: 'spki', format: 'pem' })
      .toString();
    const registry = fakeRegistry([remote()]);
    // Claims the paired fingerprint, but its own key hashes to something else.
    const inspect = vi.fn(async () => ({
      deviceId: 'impostor',
      publicKeyPem: impostorKey,
      fingerprint: FP,
      tlsCertPem: 'IMPOSTOR-CERT',
    })) as unknown as typeof inspectRemoteIdentity;
    const moved = await relocateRemote(registry.get(FP)!, {
      registry,
      browser: null,
      candidate: 'https://192.168.1.66:6229',
      inspect,
    });
    expect(moved).toBeNull();
    expect(registry.get(FP)?.baseUrl).toBe('https://192.168.1.20:6229');
  });
});
