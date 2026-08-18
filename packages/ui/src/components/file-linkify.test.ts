import type { ReferencedFile } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { fileRefFromHref, linkifyFileRefs } from './file-linkify.js';

const artifact = (path: string): ReferencedFile => ({ kind: 'artifact', path });
const workspace = (path: string): ReferencedFile => ({ kind: 'workspace', path });

describe('linkifyFileRefs', () => {
  it('links a code span matching an artifact', () => {
    expect(linkifyFileRefs('see `notes.md` for detail', [artifact('notes.md')])).toBe(
      'see [notes.md](#artifact:notes.md) for detail',
    );
  });

  it('links a workspace file under its own scheme', () => {
    expect(linkifyFileRefs('two `docs/API.md` omissions', [workspace('docs/API.md')])).toBe(
      'two [docs/API.md](#workspace:docs/API.md) omissions',
    );
  });

  it('links a span carrying a line locator, keeping the locator in the label', () => {
    expect(
      linkifyFileRefs('(`packages/cli/src/commands/image.ts:84,230`)', [
        workspace('packages/cli/src/commands/image.ts'),
      ]),
    ).toBe(
      '([packages/cli/src/commands/image.ts:84,230](#workspace:packages/cli/src/commands/image.ts))',
    );
  });

  it('resolves a bare basename with a locator to its nested file', () => {
    expect(
      linkifyFileRefs('`useFrameCapture.ts:1633` forwards layout', [
        workspace('src/hooks/useFrameCapture.ts'),
      ]),
    ).toBe('[useFrameCapture.ts:1633](#workspace:src/hooks/useFrameCapture.ts) forwards layout');
  });

  it('leaves prose and unknown spans alone', () => {
    const md = 'the `--title` flag and imaginary.md';
    expect(linkifyFileRefs(md, [artifact('notes.md')])).toBe(md);
  });

  it('does not rewrite inside fenced code blocks', () => {
    const md = '```\nread `notes.md`\n```\nand `notes.md`';
    expect(linkifyFileRefs(md, [artifact('notes.md')])).toBe(
      '```\nread `notes.md`\n```\nand [notes.md](#artifact:notes.md)',
    );
  });

  it('is a no-op with no referenced files', () => {
    expect(linkifyFileRefs('see `notes.md`', [])).toBe('see `notes.md`');
  });

  it('leaves an ambiguous basename unlinked', () => {
    const md = 'check `Header.tsx`';
    expect(linkifyFileRefs(md, [workspace('a/Header.tsx'), workspace('b/Header.tsx')])).toBe(md);
  });

  it('percent-encodes path segments but keeps separators readable', () => {
    expect(linkifyFileRefs('`my docs/a b.md`', [artifact('my docs/a b.md')])).toBe(
      '[my docs/a b.md](#artifact:my%20docs/a%20b.md)',
    );
  });
});

describe('fileRefFromHref', () => {
  it('round-trips both schemes', () => {
    expect(fileRefFromHref('#artifact:reports/pr-review.md')).toEqual(
      artifact('reports/pr-review.md'),
    );
    expect(fileRefFromHref('#workspace:docs/API.md')).toEqual(workspace('docs/API.md'));
  });

  it('decodes escaped segments', () => {
    expect(fileRefFromHref('#workspace:my%20docs/a%20b.md')).toEqual(workspace('my docs/a b.md'));
  });

  it('ignores unrelated hrefs', () => {
    expect(fileRefFromHref('https://example.com')).toBeNull();
    expect(fileRefFromHref('#section')).toBeNull();
  });
});
