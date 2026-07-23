import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type PairedRemote, createRemotesRegistry } from './registry.js';

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-remotes-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true }).catch(() => {});
});

function sample(id: string): PairedRemote {
  return {
    remoteId: id,
    baseUrl: `https://host-${id}:43936`,
    displayName: `Server ${id}`,
    token: `tok-${id}`,
    pinnedIdentityKey: `KEY-${id}`,
    pinnedIdentityFingerprint: `fp-${id}`,
    scopes: ['remote-inference'],
    pairedAt: 1000,
  };
}

describe('RemotesRegistry', () => {
  it('adds, gets, and lists paired remotes', async () => {
    const reg = await createRemotesRegistry({ home });
    await reg.add(sample('a'));
    await reg.add(sample('b'));
    expect(reg.get('a')?.baseUrl).toBe('https://host-a:43936');
    expect(
      reg
        .list()
        .map((r) => r.remoteId)
        .sort(),
    ).toEqual(['a', 'b']);
    expect(reg.get('missing')).toBeNull();
  });

  it('persists across reload', async () => {
    const reg = await createRemotesRegistry({ home });
    await reg.add(sample('a'));
    const reloaded = await createRemotesRegistry({ home });
    expect(reloaded.get('a')?.token).toBe('tok-a');
    expect(reloaded.get('a')?.scopes).toEqual(['remote-inference']);
  });

  it('upserts on re-add (re-pairing replaces)', async () => {
    const reg = await createRemotesRegistry({ home });
    await reg.add(sample('a'));
    await reg.add({ ...sample('a'), token: 'tok-rotated', pinnedIdentityFingerprint: 'fp-new' });
    expect(reg.list()).toHaveLength(1);
    expect(reg.get('a')?.token).toBe('tok-rotated');
    expect(reg.get('a')?.pinnedIdentityFingerprint).toBe('fp-new');
  });

  it('atomically replaces an old identity record for the same base URL', async () => {
    const reg = await createRemotesRegistry({ home });
    await reg.add(sample('old'));
    await reg.add({ ...sample('new'), baseUrl: sample('old').baseUrl });
    expect(reg.get('old')).toBeNull();
    expect(reg.get('new')?.baseUrl).toBe(sample('old').baseUrl);
    expect(reg.list()).toHaveLength(1);
  });

  it('updates fields and refuses unknown ids', async () => {
    const reg = await createRemotesRegistry({ home });
    await reg.add(sample('a'));
    expect(await reg.update('a', { displayName: 'Renamed', tlsCertPem: 'PEM' })).toBe(true);
    expect(reg.get('a')?.displayName).toBe('Renamed');
    expect(reg.get('a')?.tlsCertPem).toBe('PEM');
    expect(reg.get('a')?.remoteId).toBe('a');
    expect(await reg.update('nope', { displayName: 'x' })).toBe(false);
  });

  it('removes and touches', async () => {
    const reg = await createRemotesRegistry({ home });
    await reg.add(sample('a'));
    reg.touch('a');
    expect(reg.get('a')?.lastSeenAt).toBeGreaterThan(0);
    expect(await reg.remove('a')).toBe(true);
    expect(await reg.remove('a')).toBe(false);
    expect(reg.list()).toHaveLength(0);
  });
});
