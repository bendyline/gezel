import { describe, expect, it, vi } from 'vitest';
import { searchWikimediaImages } from './wikimedia-images.js';
const signal = new AbortController().signal;
function page(title: string, index: number, changes = {}) {
  return {
    title,
    index,
    imageinfo: [
      {
        mime: 'image/jpeg',
        width: 2000,
        height: 1500,
        url: 'https://upload.wikimedia.org/original.jpg',
        thumburl: 'https://thumb.wikimedia.org/thumb.jpg',
        descriptionurl: 'https://commons.wikimedia.org/wiki/File:Building.jpg',
        extmetadata: {
          Artist: { value: '<a href="x">Photographer &amp; Co</a>' },
          LicenseShortName: { value: 'CC BY-SA 4.0' },
        },
        ...changes,
      },
    ],
  };
}
describe('Commons image discovery', () => {
  it('searches file namespace without credentials and returns ranked image and attribution metadata', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        Response.json({ query: { pages: { 1: page('Second', 2), 9: page('First', 1) } } }),
      );
    const result = await searchWikimediaImages(
      { query: 'American school exterior', limit: 2 },
      signal,
      fetcher,
    );
    const url = new URL(String(fetcher.mock.calls[0]![0]));
    expect(url.hostname).toBe('commons.wikimedia.org');
    expect(url.searchParams.get('gsrnamespace')).toBe('6');
    expect(url.searchParams.get('gsrsearch')).toBe('American school exterior');
    expect(url.searchParams.get('iiprop')).toContain('extmetadata');
    expect(result.map((r) => r.title)).toEqual(['First', 'Second']);
    expect(result[0]).toMatchObject({
      credit: 'Photographer & Co',
      license: 'CC BY-SA 4.0',
      imageUrl: 'https://thumb.wikimedia.org/thumb.jpg',
    });
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ signal, redirect: 'error' });
  });
  it('omits non-raster files and untrusted result URLs; does not invent missing licenses', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      Response.json({
        query: {
          pages: {
            1: page('SVG', 1, { mime: 'image/svg+xml' }),
            2: page('Bad', 2, { thumburl: 'http://127.0.0.1/private.png' }),
            3: page('No license', 3, { extmetadata: {} }),
          },
        },
      }),
    );
    const result = await searchWikimediaImages({ query: 'school' }, signal, fetcher);
    expect(result).toHaveLength(1);
    expect(result[0]!.license).toContain('Unknown');
  });
  it('surfaces API/HTTP errors and respects cancellation', async () => {
    await expect(
      searchWikimediaImages(
        { query: 'x' },
        signal,
        vi.fn().mockResolvedValue(new Response('', { status: 429 })),
      ),
    ).rejects.toThrow('429');
    await expect(
      searchWikimediaImages(
        { query: 'x' },
        signal,
        vi.fn().mockResolvedValue(Response.json({ error: { info: 'Bad query' } })),
      ),
    ).rejects.toThrow('Bad query');
    await expect(
      searchWikimediaImages(
        { query: 'x' },
        signal,
        vi.fn().mockRejectedValue(new DOMException('Aborted', 'AbortError')),
      ),
    ).rejects.toThrow('Aborted');
  });
});
