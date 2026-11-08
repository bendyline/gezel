import { describe, expect, it } from 'vitest';
import {
  MAX_DEEP_LINK_LENGTH,
  gezelDeepLinkUrl,
  isGezelDeepLink,
  parseGezelDeepLink,
} from './deep-links.js';

describe('parseGezelDeepLink', () => {
  it('reads the three targets the site links to', () => {
    expect(parseGezelDeepLink('gezel://app/meal-planner')).toEqual({
      kind: 'app',
      id: 'meal-planner',
    });
    expect(parseGezelDeepLink('gezel://craftbook/fact-check')).toEqual({
      kind: 'craftbook',
      id: 'fact-check',
    });
    expect(parseGezelDeepLink('gezel://docs/model-scorecard')).toEqual({
      kind: 'docs',
      id: 'model-scorecard',
    });
  });

  it('tolerates what browsers and shells add', () => {
    // Windows hands the URL over with a trailing slash; some hosts uppercase
    // the scheme or the target.
    expect(parseGezelDeepLink('GEZEL://App/word-clues/')).toEqual({
      kind: 'app',
      id: 'word-clues',
    });
    expect(parseGezelDeepLink('  gezel://app/word-clues  ')).toEqual({
      kind: 'app',
      id: 'word-clues',
    });
  });

  it('ignores anything that is not a gezel URL', () => {
    expect(parseGezelDeepLink('--inspect')).toBeNull();
    expect(parseGezelDeepLink('/Users/me/model.gezmodel')).toBeNull();
    expect(parseGezelDeepLink('https://gezel.com/apps/meal-planner/')).toBeNull();
  });

  it('opens Home for a gezel URL it does not understand, never a guess', () => {
    expect(parseGezelDeepLink('gezel://open')).toEqual({ kind: 'home' });
    expect(parseGezelDeepLink('gezel://')).toEqual({ kind: 'home' });
    expect(parseGezelDeepLink('gezel://settings/security')).toEqual({ kind: 'home' });
    expect(parseGezelDeepLink('gezel://app/')).toEqual({ kind: 'home' });
    expect(parseGezelDeepLink('gezel://app/a/b')).toEqual({ kind: 'home' });
    expect(parseGezelDeepLink('gezel://app/Meal Planner')).toEqual({ kind: 'home' });
    expect(parseGezelDeepLink('gezel://app/..%2F..%2Fetc')).toEqual({ kind: 'home' });
    expect(parseGezelDeepLink('gezel://app/%E0%A4%A')).toEqual({ kind: 'home' });
    expect(parseGezelDeepLink(`gezel://app/${'a'.repeat(MAX_DEEP_LINK_LENGTH)}`)).toEqual({
      kind: 'home',
    });
  });

  it('carries nothing from the query string', () => {
    expect(parseGezelDeepLink('gezel://craftbook/fact-check?topic=wire%20money')).toEqual({
      kind: 'craftbook',
      id: 'fact-check',
    });
  });
});

describe('isGezelDeepLink', () => {
  it('accepts only the shapes the parser produces', () => {
    expect(isGezelDeepLink({ kind: 'home' })).toBe(true);
    expect(isGezelDeepLink({ kind: 'docs', id: 'cli-reference' })).toBe(true);
    expect(isGezelDeepLink({ kind: 'docs' })).toBe(false);
    expect(isGezelDeepLink({ kind: 'app', id: '../x' })).toBe(false);
    expect(isGezelDeepLink({ kind: 'run', id: 'x' })).toBe(false);
    expect(isGezelDeepLink('gezel://app/x')).toBe(false);
    expect(isGezelDeepLink(null)).toBe(false);
  });
});

describe('gezelDeepLinkUrl', () => {
  it('round-trips through the parser', () => {
    for (const link of [
      { kind: 'home' },
      { kind: 'app', id: 'meal-planner' },
      { kind: 'craftbook', id: 'powerpoint-deck' },
      { kind: 'docs', id: 'whats-new-1.26' },
    ] as const) {
      expect(parseGezelDeepLink(gezelDeepLinkUrl(link))).toEqual(link);
    }
  });
});
