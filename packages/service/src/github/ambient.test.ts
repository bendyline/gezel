import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AmbientGithubAuth } from './ambient.js';

describe('AmbientGithubAuth', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('prefers GH_TOKEN over GITHUB_TOKEN', async () => {
    const auth = new AmbientGithubAuth({
      env: { GH_TOKEN: 'gho_primary', GITHUB_TOKEN: 'gho_secondary' },
      ghToken: async () => null,
    });
    expect(await auth.getToken()).toEqual({ token: 'gho_primary', source: 'env' });
  });

  it('falls back to GITHUB_TOKEN and trims whitespace', async () => {
    const auth = new AmbientGithubAuth({
      env: { GITHUB_TOKEN: '  gho_ci\n' },
      ghToken: async () => null,
    });
    expect(await auth.getToken()).toEqual({ token: 'gho_ci', source: 'env' });
  });

  it('ignores empty env vars and falls through to the gh CLI', async () => {
    const auth = new AmbientGithubAuth({
      env: { GH_TOKEN: '   ' },
      ghToken: async () => 'gho_from_cli',
    });
    expect(await auth.getToken()).toEqual({ token: 'gho_from_cli', source: 'gh' });
  });

  it('returns null when no source has a token', async () => {
    const auth = new AmbientGithubAuth({ env: {}, ghToken: async () => null });
    expect(await auth.getToken()).toBeNull();
  });

  it('treats a gh lookup failure as a miss instead of throwing', async () => {
    const auth = new AmbientGithubAuth({
      env: {},
      ghToken: async () => {
        throw new Error('keyring exploded');
      },
    });
    expect(await auth.getToken()).toBeNull();
  });

  it('caches a gh hit for the token TTL, then re-asks', async () => {
    const ghToken = vi.fn(async () => 'gho_cached');
    const auth = new AmbientGithubAuth({ env: {}, ghToken, tokenTtlMs: 1000 });
    await auth.getToken();
    await auth.getToken();
    expect(ghToken).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1001);
    await auth.getToken();
    expect(ghToken).toHaveBeenCalledTimes(2);
  });

  it('caches a miss for the (shorter) miss TTL', async () => {
    const ghToken = vi.fn(async () => null);
    const auth = new AmbientGithubAuth({ env: {}, ghToken, missTtlMs: 500 });
    await auth.getToken();
    await auth.getToken();
    expect(ghToken).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(501);
    await auth.getToken();
    expect(ghToken).toHaveBeenCalledTimes(2);
  });

  it('single-flights concurrent gh lookups', async () => {
    let resolveToken!: (t: string) => void;
    const ghToken = vi.fn(
      () =>
        new Promise<string | null>((resolve) => {
          resolveToken = resolve;
        }),
    );
    const auth = new AmbientGithubAuth({ env: {}, ghToken });
    const [a, b] = [auth.getToken(), auth.getToken()];
    resolveToken('gho_shared');
    expect(await a).toEqual({ token: 'gho_shared', source: 'gh' });
    expect(await b).toEqual({ token: 'gho_shared', source: 'gh' });
    expect(ghToken).toHaveBeenCalledTimes(1);
  });

  it('invalidate() drops the cache so the next call re-asks gh', async () => {
    const ghToken = vi.fn(async () => 'gho_x');
    const auth = new AmbientGithubAuth({ env: {}, ghToken });
    await auth.getToken();
    auth.invalidate();
    await auth.getToken();
    expect(ghToken).toHaveBeenCalledTimes(2);
  });
});
