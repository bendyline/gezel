import { describe, expect, it } from 'vitest';
import { type LanguageProfile, scoreProjectTypes } from './detect.js';

function profile(
  extensions: Record<string, number>,
  modalities: Record<string, number> = {},
): LanguageProfile {
  const fileCount = Object.values(extensions).reduce((a, b) => a + b, 0);
  return { fileCount, extensions, modalities };
}

describe('scoreProjectTypes', () => {
  it('classifies an HTML/canvas game with a game-y about as browser-game', () => {
    const ranked = scoreProjectTypes({
      profile: profile({ html: 1, js: 2, css: 1 }),
      aboutText: 'Space Shooter Arcade — a game where the player shoots enemies to score points.',
    });
    expect(ranked[0]?.id).toBe('browser-game');
    expect(ranked[0]!.score).toBeGreaterThan(ranked.find((r) => r.id === 'web-app')!.score);
  });

  it('uses keywords to disambiguate shared extensions (api-service over library)', () => {
    const ranked = scoreProjectTypes({
      profile: profile({ ts: 8, js: 2 }),
      aboutText: 'A REST API backend with database-backed endpoints and webhooks.',
    });
    expect(ranked[0]?.id).toBe('api-service');
  });

  it('detects a data project from notebooks/CSV plus analysis keywords', () => {
    const ranked = scoreProjectTypes({
      profile: profile({ ipynb: 2, csv: 3, py: 1 }),
      aboutText: 'Analysis of a sales dataset: charts, statistics, and a metrics report.',
    });
    expect(ranked[0]?.id).toBe('data-analysis');
  });

  it('falls back to keyword signal when there is no index yet', () => {
    const ranked = scoreProjectTypes({
      profile: null,
      aboutText: 'A blog and marketing website with a landing page and SEO copy.',
    });
    expect(ranked[0]?.id).toBe('static-site');
  });

  it('returns nothing when there are no signals at all', () => {
    expect(scoreProjectTypes({ profile: null, aboutText: '' })).toEqual([]);
  });

  it('ranks deterministically (stable id tiebreak)', () => {
    const a = scoreProjectTypes({ profile: profile({ html: 1 }), aboutText: '' });
    const b = scoreProjectTypes({ profile: profile({ html: 1 }), aboutText: '' });
    expect(a).toEqual(b);
  });
});
