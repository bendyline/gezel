import { describe, expect, it } from 'vitest';
import { plainInlineMarkdown, plainStatement } from './plain-markdown.js';

describe('plainInlineMarkdown', () => {
  it('takes the inline marks off and keeps the words', () => {
    expect(
      plainInlineMarkdown('**Sunday** is the _busiest_ day, see [the sheet](a.xlsx) and `total`.'),
    ).toBe('Sunday is the busiest day, see the sheet and total.');
    expect(plainInlineMarkdown('*a* and ~~b~~ and ![logo](x.png)')).toBe('a and b and logo');
  });

  it('leaves arithmetic and words with underscores alone', () => {
    expect(plainInlineMarkdown('5 * 3 = 15 in snake_case_name')).toBe(
      '5 * 3 = 15 in snake_case_name',
    );
  });
});

describe('plainStatement', () => {
  it('drops citation markers too', () => {
    expect(plainStatement('**Sunday** edges out Saturday [16].')).toBe(
      'Sunday edges out Saturday.',
    );
    expect(plainStatement('Revenue [1, 2] grew [3-4]')).toBe('Revenue grew');
  });
});
