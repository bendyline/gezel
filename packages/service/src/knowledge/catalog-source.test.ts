import { describe, expect, it } from 'vitest';
import { huggingfaceDatasetResolveUrl } from './catalog-source.js';

describe('huggingfaceDatasetResolveUrl', () => {
  it('builds a commit-pinned dataset resolve URL with an encoded path', () => {
    expect(
      huggingfaceDatasetResolveUrl({
        repo: 'Bendyline/wikipedia-physics',
        revision: 'a'.repeat(40),
        path: 'releases/2026.9.1/wikipedia physics.gezk',
      }),
    ).toBe(
      `https://huggingface.co/datasets/Bendyline/wikipedia-physics/resolve/${'a'.repeat(40)}/releases/2026.9.1/wikipedia%20physics.gezk?download=true`,
    );
  });

  it('honors an explicit base URL without doubling slashes', () => {
    expect(
      huggingfaceDatasetResolveUrl(
        { repo: 'o/r', revision: 'b'.repeat(40), path: 'c.gezk' },
        'http://127.0.0.1:1234/',
      ),
    ).toBe(`http://127.0.0.1:1234/datasets/o/r/resolve/${'b'.repeat(40)}/c.gezk?download=true`);
  });
});
