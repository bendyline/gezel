import { describe, expect, it } from 'vitest';
import { extractMarkdownLinks, normalizeLinkTarget } from './markdown-links.js';

describe('extractMarkdownLinks', () => {
  it('reads inline links, images, reference definitions and HTML attributes', () => {
    const md = [
      '# Guide',
      'See [setup](setup.md) and ![diagram](./img/flow.png "Flow").',
      'Back to [the readme](../README.md#top).',
      '[spec]: <docs/spec v2.md>',
      '<img src="assets/logo.svg" alt="">',
    ].join('\n');
    expect(extractMarkdownLinks(md).map((e) => e.raw)).toEqual([
      '../README.md',
      './assets/logo.svg',
      './docs/spec v2.md',
      './img/flow.png',
      './setup.md',
    ]);
  });

  it('leaves out the web, mail, anchors, and anything inside code', () => {
    const md = [
      '[site](https://example.com) [mail](mailto:a@b.c) [top](#top) [cdn](//cdn.example.com/x.js)',
      'Inline `[not](a-link.md)` code.',
      '```md',
      '[also not](fenced.md)',
      '```',
      '~~~',
      '[nor](tilde.md)',
      '~~~',
      '[kept](kept.md)',
    ].join('\n');
    expect(extractMarkdownLinks(md).map((e) => e.raw)).toEqual(['./kept.md']);
  });

  it('keeps root-absolute links and decodes escapes', () => {
    expect(normalizeLinkTarget('/docs/a%20b.md?raw=1')).toBe('/docs/a b.md');
    expect(normalizeLinkTarget('./')).toBeNull();
    expect(normalizeLinkTarget('C:\\notes.md')).toBeNull();
  });
});
