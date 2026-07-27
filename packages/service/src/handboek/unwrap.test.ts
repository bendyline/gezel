import { describe, expect, it } from 'vitest';
import { unwrapSoftBreaks } from './unwrap.js';

describe('unwrapSoftBreaks', () => {
  it('folds a hard-wrapped paragraph into one line', () => {
    const src = 'A project is a scoped workspace: one goal,\none set of files, one crew.';
    expect(unwrapSoftBreaks(src)).toBe(
      'A project is a scoped workspace: one goal, one set of files, one crew.',
    );
  });

  it('keeps paragraph boundaries', () => {
    const src = 'first\nparagraph\n\nsecond\nparagraph';
    expect(unwrapSoftBreaks(src)).toBe('first paragraph\n\nsecond paragraph');
  });

  it('leaves fenced code untouched', () => {
    const src = ['before', '', '```', 'line one', 'line two', '```', '', 'after'].join('\n');
    expect(unwrapSoftBreaks(src)).toBe(src);
  });

  it('keeps list items apart but folds their continuations', () => {
    const src = [
      '- **About** — a plain-language',
      '  description of the project',
      '- Second item',
    ].join('\n');
    expect(unwrapSoftBreaks(src)).toBe(
      '- **About** — a plain-language description of the project\n- Second item',
    );
  });

  it('leaves headings, tables, blockquotes, and macro directives on their own lines', () => {
    const src = [
      '# Title',
      '',
      '| Tier | Good at |',
      '| --- | --- |',
      '| small | short tasks |',
      '',
      '> quoted line',
      '',
      '::handboek-craftbook-list',
    ].join('\n');
    expect(unwrapSoftBreaks(src)).toBe(src);
  });

  it('leaves indented code blocks untouched', () => {
    const src = ['before', '', '    ~/.gezel/', '      config.json', '', 'after'].join('\n');
    expect(unwrapSoftBreaks(src)).toBe(src);
  });

  it('is idempotent and preserves every word', () => {
    const src = 'one two\nthree four\n\n- item one\n  wrapped\n\n```\nkeep\nthis\n```';
    const once = unwrapSoftBreaks(src);
    expect(unwrapSoftBreaks(once)).toBe(once);
    expect(once.split(/\s+/).filter(Boolean)).toEqual(src.split(/\s+/).filter(Boolean));
  });
});
