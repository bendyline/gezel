import { poppetjeFromSeed, seedFromKey } from '@bendyline/gezel';
import { describe, expect, it, vi } from 'vitest';
import { createHandboekMediaProvider } from './HandboekMediaProvider.js';

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
