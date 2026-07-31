import { describe, expect, it, vi } from 'vitest';
import { appReleaseFeedConfiguration, discoverLatestAppRelease } from './app-release.js';

function redirect(location?: string, status = 302): Response {
  return new Response(null, {
    status,
    headers: location ? { location } : undefined,
  });
}

describe('app release discovery', () => {
  it('resolves an exact v-prefixed application release', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(redirect('https://github.com/bendyline/gezel/releases/tag/v1.26211.27'));

    await expect(discoverLatestAppRelease({ fetch })).resolves.toEqual({
      version: '1.26211.27',
      tagName: 'v1.26211.27',
      downloadBaseUrl: 'https://github.com/bendyline/gezel/releases/download/v1.26211.27/',
    });
    expect(fetch).toHaveBeenCalledWith(
      'https://github.com/bendyline/gezel/releases/latest',
      expect.objectContaining({ redirect: 'manual' }),
    );
  });

  it('excludes a native release even when GitHub calls it latest', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        redirect('https://github.com/bendyline/gezel/releases/tag/native-v99.0.0'),
      );

    await expect(discoverLatestAppRelease({ fetch })).resolves.toBeNull();
  });

  it('excludes prerelease and lookalike tags from the stable app channel', async () => {
    for (const tag of ['v2.0.0-beta.1', 'app-v2.0.0', 'v02.0.0', 'v2.0']) {
      const fetch = vi
        .fn()
        .mockResolvedValue(redirect(`https://github.com/bendyline/gezel/releases/tag/${tag}`));
      await expect(discoverLatestAppRelease({ fetch })).resolves.toBeNull();
    }
  });

  it('returns null when the repository has no published release yet', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));

    await expect(discoverLatestAppRelease({ fetch })).resolves.toBeNull();
  });

  it('fails closed for missing, cross-origin, or malformed redirects', async () => {
    await expect(
      discoverLatestAppRelease({ fetch: vi.fn().mockResolvedValue(redirect()) }),
    ).rejects.toThrow('no redirect target');

    await expect(
      discoverLatestAppRelease({
        fetch: vi
          .fn()
          .mockResolvedValue(redirect('https://example.com/bendyline/gezel/releases/tag/v1.2.3')),
      }),
    ).rejects.toThrow('unexpected target');

    await expect(
      discoverLatestAppRelease({
        fetch: vi.fn().mockResolvedValue(new Response('unexpected', { status: 200 })),
      }),
    ).rejects.toThrow('HTTP 200');
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
