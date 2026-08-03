import { poppetjeFromSeed, seedFromKey } from '@bendyline/gezel';
import { describe, expect, it, vi } from 'vitest';
import { createHandboekMediaProvider, inlineBundledAssets } from './HandboekMediaProvider.js';

const capturedBlobs: Blob[] = [];
Object.assign(URL, {
  createObjectURL: vi.fn((blob: Blob) => {
    capturedBlobs.push(blob);
    return `blob:mock-${capturedBlobs.length}`;
  }),
  revokeObjectURL: vi.fn(),
});

describe('createHandboekMediaProvider', () => {
  const figure = {
    path: 'poppetje/adam.headshot.svg',
    gezelId: 'adam',
    name: 'Adam',
    variant: 'headshot' as const,
    poppetje: poppetjeFromSeed(seedFromKey('adam')),
  };

  it('resolves poppetje refs to standalone-valid SVG blob URLs', async () => {
    const provider = createHandboekMediaProvider([figure]);
    const url = await provider.resolveUrl('poppetje/adam.headshot.svg');
    expect(url).toMatch(/^blob:/);
    const svg = await capturedBlobs[capturedBlobs.length - 1]!.text();
    // A blob URL loads as a standalone SVG document: without the
    // namespace the browser parses generic XML and <img> renders 0×0
    // (the invisible-poppetjes incident).
    expect(svg).toContain('<svg xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain('width="160"');
    expect(capturedBlobs[capturedBlobs.length - 1]!.type).toBe('image/svg+xml');
  });

  it('passes unknown refs through untouched', async () => {
    const provider = createHandboekMediaProvider([figure]);
    expect(await provider.resolveUrl('assets/foo.png')).toBe('assets/foo.png');
    expect(await provider.resolveUrl('poppetje/ghost.headshot.svg')).toBe(
      'poppetje/ghost.headshot.svg',
    );
  });
});

describe('inlineBundledAssets', () => {
  // squisq paints the relative path before the provider answers, so a
  // surviving `../assets/…` src means a 404 request the app never needs.
  it('rewrites brand images to the bundled url', () => {
    const out = inlineBundledAssets('# Hi\n\n![gezel-mark](../assets/gezel-mark.png)\n');
    expect(out).not.toContain('../assets/gezel-mark.png');
    expect(out).toMatch(/!\[gezel-mark\]\(.+gezel-mark.*\)/);
  });

  it('leaves poppetje figures and unknown images alone', () => {
    const md =
      '![Adam](poppetje/adam.headshot.svg)\n![x](../assets/nope.png)\n[link](../assets/gezel-mark.png)';
    expect(inlineBundledAssets(md)).toBe(md);
  });
});
