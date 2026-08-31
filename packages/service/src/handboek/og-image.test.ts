import { markdownToDoc } from '@bendyline/squisq/doc';
import { parseMarkdown } from '@bendyline/squisq/markdown';
import { describe, expect, it } from 'vitest';
import { GEZEL_SITE_THEME, OG_CARD_HEIGHT, OG_CARD_WIDTH, buildCardMarkdown } from './og-image.js';

describe('buildCardMarkdown', () => {
  it('produces exactly one bigText block, which is what focus-1 can hold', () => {
    const md = buildCardMarkdown({
      kicker: 'gezel · Craftbook',
      headline: 'Your crew proposes changes before they land.',
    });
    const doc = markdownToDoc(parseMarkdown(md));
    expect(doc.blocks).toHaveLength(1);
    expect(md).toContain('{[bigText]}');
  });

  it('keeps a kicker containing YAML metacharacters parseable', () => {
    // A colon plus a quote is the shape that breaks a bare YAML scalar, and
    // release kickers really do carry colons.
    const md = buildCardMarkdown({
      kicker: 'gezel · What\'s new: "1.26237"',
      headline: 'Changes you read first',
    });
    const doc = markdownToDoc(parseMarkdown(md));
    expect(doc.frontmatter?.title).toBe('gezel · What\'s new: "1.26237"');
  });

  it('strips characters that would let a headline escape its heading', () => {
    const md = buildCardMarkdown({
      kicker: 'gezel',
      headline: 'Fix {[statHighlight]} and ## more',
    });
    const doc = markdownToDoc(parseMarkdown(md));
    // One block still, and no second annotation smuggled in.
    expect(doc.blocks).toHaveLength(1);
    expect(md.match(/\{\[/g)).toHaveLength(1);
    expect(md).toContain('{[bigText]}');
  });

  it('collapses newlines so a multi-line summary cannot split the heading', () => {
    const md = buildCardMarkdown({
      kicker: 'gezel',
      headline: 'One line\n\n# A second heading',
    });
    expect(markdownToDoc(parseMarkdown(md)).blocks).toHaveLength(1);
  });

  it('refuses a headline that sanitizes away to nothing', () => {
    expect(() => buildCardMarkdown({ kicker: 'gezel', headline: '### {[]}' })).toThrow(
      /headline is empty/,
    );
  });
});

describe('GEZEL_SITE_THEME', () => {
  it('declares no persistent layers', () => {
    // The built-in themes layer a `noise` patternBackground. Noise is random
    // pixel data over the whole canvas and tripled the encoded card (736KB
    // against 213KB) for a texture invisible at preview size.
    expect(GEZEL_SITE_THEME.persistentLayers).toBeUndefined();
  });

  it('renders at the size every OG consumer expects', () => {
    expect([OG_CARD_WIDTH, OG_CARD_HEIGHT]).toEqual([1200, 630]);
  });
});
