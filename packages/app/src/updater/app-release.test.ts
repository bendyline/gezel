import { describe, expect, it, vi } from 'vitest';
import {
  appReleaseFeedConfiguration,
  discoverLatestAppRelease,
  isNewerAppVersion,
  latestPublishedAppRelease,
} from './app-release.js';

function releases(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

describe('app release discovery', () => {
  it('finds the greatest stable app release among newer package and native releases', async () => {
    const fetch = vi.fn().mockResolvedValue(
      releases([
        { tag_name: '@bendyline/gezel-service@1.0.2', draft: false, prerelease: false },
        { tag_name: 'native-v0.1.36', draft: false, prerelease: true },
        { tag_name: 'v1.26224.48', draft: false, prerelease: false },
        { tag_name: 'v1.26219.46', draft: false, prerelease: false },
      ]),
    );

    await expect(discoverLatestAppRelease({ fetch })).resolves.toEqual({
      version: '1.26224.48',
      tagName: 'v1.26224.48',
      downloadBaseUrl: 'https://github.com/bendyline/gezel/releases/download/v1.26224.48/',
    });
    expect(fetch).toHaveBeenCalledWith(
      'https://api.github.com/repos/bendyline/gezel/releases?per_page=100',
      expect.objectContaining({ headers: expect.objectContaining({ Accept: expect.any(String) }) }),
    );
  });

  it('excludes drafts, prereleases, and lookalike tags from the app channel', () => {
    expect(
      latestPublishedAppRelease([
        { tag_name: 'v9.0.0', draft: true, prerelease: false },
        { tag_name: 'v8.0.0', draft: false, prerelease: true },
        ...['v2.0.0-beta.1', 'app-v2.0.0', 'v02.0.0', 'v2.0'].map((tag_name) => ({
          tag_name,
          draft: false,
          prerelease: false,
        })),
      ]),
    ).toBeNull();
  });

  it('returns null when the repository has no published release yet', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));

    await expect(discoverLatestAppRelease({ fetch })).resolves.toBeNull();
  });

  it('fails closed for an API failure or malformed body', async () => {
    await expect(
      discoverLatestAppRelease({ fetch: vi.fn().mockResolvedValue(releases({}, 403)) }),
    ).rejects.toThrow('HTTP 403');

    await expect(
      discoverLatestAppRelease({
        fetch: vi.fn().mockResolvedValue(releases({ releases: [] })),
      }),
    ).rejects.toThrow('invalid response body');
  });
});

describe('app release feed', () => {
  it('roots electron-updater at the exact tagged release', () => {
    expect(
      appReleaseFeedConfiguration({
        version: '1.2.3',
        tagName: 'v1.2.3',
        downloadBaseUrl: 'https://github.com/bendyline/gezel/releases/download/v1.2.3/',
      }),
    ).toEqual({
      provider: 'generic',
      url: 'https://github.com/bendyline/gezel/releases/download/v1.2.3/',
      useMultipleRangeRequest: false,
    });
  });
});

describe('app release version comparison', () => {
  it('detects only a strictly newer release', () => {
    expect(isNewerAppVersion('1.26224.49', '1.26224.48')).toBe(true);
    expect(isNewerAppVersion('1.26225.0', '1.26224.99')).toBe(true);
    expect(isNewerAppVersion('2.0.0', '1.99999.999')).toBe(true);
    expect(isNewerAppVersion('1.26224.48', '1.26224.48')).toBe(false);
    expect(isNewerAppVersion('1.26224.47', '1.26224.48')).toBe(false);
  });

  it('fails closed for non-release versions', () => {
    expect(() => isNewerAppVersion('1.2.3-beta.1', '1.2.2')).toThrow(/strict x\.y\.z/);
    expect(() => isNewerAppVersion('1.2.3', 'dev')).toThrow(/strict x\.y\.z/);
  });
});
