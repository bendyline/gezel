import { describe, expect, it } from 'vitest';
import { extractPageElementsFromYaml, scorePageElementMatch } from './browser-page-elements.js';

describe('browser page elements', () => {
  it('extracts interactive refs and ignores structural or duplicate rows', () => {
    const yaml = [
      '- navigation "Primary" [ref=e1]',
      '  - textbox "Search the catalog" [ref=e2]',
      '  - button "Search" [ref=e3]',
      '  - button "Search" [ref=e3]',
      '  - link "Seattle result" [ref=e4]',
    ].join('\n');

    expect(extractPageElementsFromYaml(yaml)).toEqual([
      { role: 'textbox', name: 'Search the catalog', ref: 'e2' },
      { role: 'button', name: 'Search', ref: 'e3' },
      { role: 'link', name: 'Seattle result', ref: 'e4' },
    ]);
  });

  it('ranks an exact role hint ahead of name-only matches', () => {
    const description = 'search';
    const textboxScore = scorePageElementMatch(
      { role: 'textbox', name: 'Search the catalog', ref: 'e2' },
      description,
      'textbox',
    );
    const buttonScore = scorePageElementMatch(
      { role: 'button', name: 'Search', ref: 'e3' },
      description,
      'textbox',
    );

    expect(textboxScore).toBeGreaterThan(buttonScore);
  });
});
