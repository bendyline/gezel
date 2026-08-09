import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LicenseResolver,
  isPermissive,
  normalizeSpdx,
  parseGitHubOwnerRepo,
} from './license-resolver.js';

describe('parseGitHubOwnerRepo', () => {
  it('extracts owner/repo from a typical https URL', () => {
    expect(parseGitHubOwnerRepo('https://github.com/acme/widget')).toEqual({
      owner: 'acme',
      repo: 'widget',
    });
  });

  it('strips a trailing .git', () => {
    expect(parseGitHubOwnerRepo('https://github.com/acme/widget.git')).toEqual({
      owner: 'acme',
      repo: 'widget',
    });
  });

  it('handles ssh-style urls', () => {
    expect(parseGitHubOwnerRepo('git@github.com:acme/widget.git')).toEqual({
      owner: 'acme',
      repo: 'widget',
    });
  });

  it('returns null for non-github urls', () => {
    expect(parseGitHubOwnerRepo('https://gitlab.com/acme/widget')).toBeNull();
    expect(parseGitHubOwnerRepo(undefined)).toBeNull();
  });
});

describe('normalizeSpdx', () => {
  it('returns the canonical id for common shapes', () => {
    expect(normalizeSpdx('MIT')).toBe('MIT');
    expect(normalizeSpdx('mit')).toBe('MIT');
    expect(normalizeSpdx('Apache-2.0')).toBe('Apache-2.0');
    expect(normalizeSpdx('apache-2.0')).toBe('Apache-2.0');
  });

  it('extracts the first id from compound expressions', () => {
    expect(normalizeSpdx('(MIT OR Apache-2.0)')).toBe('MIT');
  });

  it('returns null on garbage', () => {
    expect(normalizeSpdx('')).toBeNull();
    expect(normalizeSpdx('   ')).toBeNull();
  });
});

describe('isPermissive', () => {
  it('accepts the expected SPDX ids', () => {
    for (const id of [
      'MIT',
      'Apache-2.0',
      'BSD-2-Clause',
      'BSD-3-Clause',
      'ISC',
      '0BSD',
      'MPL-2.0',
    ]) {
      expect(isPermissive(id)).toBe(true);
    }
  });

  it('rejects copyleft and unknown', () => {
    for (const id of ['GPL-3.0', 'AGPL-3.0', 'SSPL-1.0', 'BUSL-1.1', 'NOASSERTION', '']) {
      expect(isPermissive(id)).toBe(false);
    }
  });
});

describe('LicenseResolver caching', () => {
  let cacheDir: string;
  const url = 'https://github.com/acme/widget';

  function reply(status: number, body: unknown = {}, headers: Record<string, string> = {}) {
    return new Response(JSON.stringify(body), { status, headers });
  }

  beforeEach(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), 'gezel-license-'));
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(cacheDir, { recursive: true, force: true });
  });

  it('caches a resolved license so a repeat lookup makes no request', async () => {
    const fetchMock = vi.fn(async () => reply(200, { license: { spdx_id: 'MIT' } }));
    vi.stubGlobal('fetch', fetchMock);
    const resolver = new LicenseResolver({ cacheDir });

    expect(await resolver.resolveForGitHub(url)).toEqual({
      kind: 'resolved',
      spdx: 'MIT',
      source: 'github',
    });
    await resolver.resolveForGitHub(url);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('caches a 404 — a missing repo is a fact, not a hiccup', async () => {
    const fetchMock = vi.fn(async () => reply(404));
    vi.stubGlobal('fetch', fetchMock);
    const resolver = new LicenseResolver({ cacheDir });

    await resolver.resolveForGitHub(url);
    await resolver.resolveForGitHub(url);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('never caches a 403 — a throttle must not become a permanent verdict', async () => {
    const fetchMock = vi.fn(async () => reply(403));
    vi.stubGlobal('fetch', fetchMock);
    const resolver = new LicenseResolver({ cacheDir });

    const first = await resolver.resolveForGitHub(url);
    expect(first.kind).toBe('unknown');
    await resolver.resolveForGitHub(url);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('re-resolves after a transient failure instead of serving the failure', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(reply(403))
      .mockResolvedValueOnce(reply(200, { license: { spdx_id: 'Apache-2.0' } }));
    vi.stubGlobal('fetch', fetchMock);
    const resolver = new LicenseResolver({ cacheDir });

    expect((await resolver.resolveForGitHub(url)).kind).toBe('unknown');
    expect(await resolver.resolveForGitHub(url)).toEqual({
      kind: 'resolved',
      spdx: 'Apache-2.0',
      source: 'github',
    });
  });

  it('retries a rate-limited 403 rather than surfacing it', async () => {
    const limited = () => reply(403, {}, { 'x-ratelimit-remaining': '0' });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(limited())
      .mockResolvedValueOnce(reply(200, { license: { spdx_id: 'ISC' } }));
    vi.stubGlobal('fetch', fetchMock);
    const resolver = new LicenseResolver({ cacheDir });

    expect(await resolver.resolveForGitHub(url)).toEqual({
      kind: 'resolved',
      spdx: 'ISC',
      source: 'github',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
