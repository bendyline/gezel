import {
  MAX_KNOWLEDGE_ASSETS_TOTAL_BYTES,
  MAX_KNOWLEDGE_ASSET_BYTES,
  MAX_KNOWLEDGE_ASSET_COUNT,
} from '@bendyline/gezk';
import { describe, expect, it } from 'vitest';
import { FIXTURE_PNG } from '../test/fixture.js';
import { omitSkippedAssetReferences, prepareAssets } from './assets.js';

describe('tolerant asset preparation', () => {
  it('warns once per invalid image and keeps valid assets', () => {
    const warnings: string[] = [];
    const result = prepareAssets(
      [
        { path: 'assets/f5-logo.png', content: Buffer.from([0xff, 0xd8, 0xff]) },
        { path: 'assets/good.png', content: FIXTURE_PNG },
        { path: 'assets/corrupt.png', content: Buffer.from('not an image') },
      ],
      {},
      { invalidAssets: 'warn', onWarning: (message) => warnings.push(message) },
    );
    expect(result.assets.map((asset) => asset.path)).toEqual(['assets/good.png']);
    expect([...result.skippedPaths]).toEqual(['assets/f5-logo.png', 'assets/corrupt.png']);
    expect(warnings).toEqual([
      'asset assets/f5-logo.png: the leading bytes say jpeg, the extension says png; skipped (references replaced with their text)',
      'asset assets/corrupt.png: the leading bytes say unknown, the extension says png; skipped (references replaced with their text)',
    ]);
  });

  it('omits active SVG and oversized images instead of shipping invalid content', () => {
    const result = prepareAssets(
      [
        {
          path: 'assets/live.svg',
          content: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>'),
        },
        { path: 'assets/huge.png', content: Buffer.alloc(MAX_KNOWLEDGE_ASSET_BYTES + 1) },
      ],
      {},
      { invalidAssets: 'warn' },
    );
    expect(result.assets).toEqual([]);
    expect([...result.skippedPaths]).toEqual(['assets/live.svg', 'assets/huge.png']);
  });

  it('still rejects invalid paths, duplicates, and ambiguous inputs in warning mode', () => {
    const options = { invalidAssets: 'warn' as const };
    expect(() =>
      prepareAssets([{ path: 'assets/../mark.png', content: FIXTURE_PNG }], {}, options),
    ).toThrow(/invalid asset path/);
    expect(() =>
      prepareAssets(
        [
          { path: 'assets/Mark.png', content: Buffer.from('bad') },
          { path: 'assets/mark.png', content: FIXTURE_PNG },
        ],
        {},
        options,
      ),
    ).toThrow(/duplicate asset path/);
    expect(() =>
      prepareAssets(
        [{ path: 'assets/mark.png', content: FIXTURE_PNG, absPath: '/x' }],
        {},
        options,
      ),
    ).toThrow(/exactly one/);
  });

  it('keeps the aggregate asset limits in warning mode', () => {
    const image = Buffer.alloc(MAX_KNOWLEDGE_ASSET_BYTES);
    FIXTURE_PNG.copy(image);
    const assets = Array.from(
      { length: Math.floor(MAX_KNOWLEDGE_ASSETS_TOTAL_BYTES / image.byteLength) + 1 },
      (_, i) => ({ path: `assets/image-${i}.png`, content: image }),
    );
    expect(() => prepareAssets(assets, {}, { invalidAssets: 'warn' })).toThrow(
      /assets exceed .* bytes in total/,
    );
    expect(() =>
      prepareAssets(
        Array.from({ length: MAX_KNOWLEDGE_ASSET_COUNT + 1 }, (_, i) => ({
          path: `assets/image-${i}.png`,
          content: FIXTURE_PNG,
        })),
        {},
        { invalidAssets: 'warn' },
      ),
    ).toThrow(/assets exceed the limit/);
  });

  it('replaces skipped references with labels and preserves unrelated links', () => {
    const markdown = [
      '[site](https://example.test) ![good](assets/good.png) ![F5 [logo]](assets/f5-logo.png)',
      '![F5](<assets/f5-logo.png> "Title") [download](assets/f5-logo.png)',
      '![empty]() ![](assets/f5-logo.png)',
    ].join('\n');
    expect(omitSkippedAssetReferences(markdown, new Set(['assets/f5-logo.png']))).toBe(
      [
        '[site](https://example.test) ![good](assets/good.png) F5 [logo]',
        'F5 download',
        '![empty]() ',
      ].join('\n'),
    );
  });
});
