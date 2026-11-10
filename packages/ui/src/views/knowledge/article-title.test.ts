import { describe, expect, it } from 'vitest';
import { withoutRepeatedTitle } from './article-title.js';

describe('withoutRepeatedTitle', () => {
  // "What is gezel?" sat in the reader's header and again, larger, as the
  // article's own first heading (2026-11-09).
  it('drops a first heading that repeats the title', () => {
    expect(withoutRepeatedTitle('# What is gezel?\n\nGezel is Dutch…', 'What is gezel?')).toBe(
      'Gezel is Dutch…',
    );
  });

  it('matches past case, emphasis and closing punctuation, and keeps frontmatter', () => {
    expect(
      withoutRepeatedTitle('---\nid: a\n---\n\n# **Dovetail joints**\n\nTails.', 'Dovetail Joints'),
    ).toBe('---\nid: a\n---\n\nTails.');
  });

  it('keeps a heading that says something else, and a later one', () => {
    const differs = '# Joinery basics\n\nTails.';
    expect(withoutRepeatedTitle(differs, 'Dovetail Joints')).toBe(differs);
    const later = 'Intro.\n\n# Dovetail Joints\n';
    expect(withoutRepeatedTitle(later, 'Dovetail Joints')).toBe(later);
    const second = '## Dovetail Joints\n\nTails.';
    expect(withoutRepeatedTitle(second, 'Dovetail Joints')).toBe(second);
  });
});
