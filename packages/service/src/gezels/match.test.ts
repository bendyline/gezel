import { describe, expect, it } from 'vitest';
import { MATCH_THRESHOLD, rankCandidates, roleTokens, scoreCandidate } from './match.js';

describe('roleTokens', () => {
  it('lowercases + tokenizes + drops stopwords', () => {
    expect([...roleTokens('the Designer for a project')]).toEqual(['designer', 'project']);
  });

  it('collapses abbreviations to canonical forms', () => {
    expect([...roleTokens('dev')]).toEqual(['developer']);
    expect([...roleTokens('UX/UI designer')]).toEqual(['designer']);
    expect([...roleTokens('QA engineer')]).toEqual(['reviewer', 'developer']);
  });

  it('preserves unknown tokens as-is', () => {
    expect([...roleTokens('Senior marine biologist')]).toEqual(['senior', 'marine', 'biologist']);
  });
});

describe('scoreCandidate', () => {
  it('scores exact role matches at 1.0', () => {
    const res = scoreCandidate('designer', {
      id: 'maya',
      role: 'Designer',
      name: 'Maya',
    });
    expect(res.score).toBe(1);
  });

  it('collapses UX → designer via alias map', () => {
    const res = scoreCandidate('UX designer', {
      id: 'maya',
      role: 'Designer',
    });
    // Query tokens after expansion + dedup: { designer }. Candidate role
    // tokens: { designer }. Exact hit → 1.0 / 1 = 1.
    expect(res.score).toBe(1);
  });

  it('returns zero when nothing overlaps', () => {
    const res = scoreCandidate('designer', {
      id: 'leo',
      role: 'Voorman',
      name: 'Leo',
    });
    expect(res.score).toBe(0);
  });

  it('scores tag matches lower than role matches', () => {
    const roleHit = scoreCandidate('designer', { id: 'a', role: 'Designer' });
    const tagHit = scoreCandidate('designer', {
      id: 'b',
      role: 'Planner',
      tags: ['designer'],
    });
    expect(roleHit.score).toBeGreaterThan(tagHit.score);
  });

  it('scores description matches lowest', () => {
    const roleHit = scoreCandidate('designer', { id: 'a', role: 'Designer' });
    // Description uses the canonical singular ("designer") because our
    // tokenizer doesn't singularize — "designers" wouldn't collapse.
    const descHit = scoreCandidate('designer', {
      id: 'b',
      role: 'Voorman',
      description: 'Partner-facing designer co-pilot for brief reviews',
    });
    expect(roleHit.score).toBeGreaterThan(descHit.score);
    expect(descHit.score).toBeGreaterThan(0);
  });
});

describe('rankCandidates', () => {
  it('ranks the best fit first', () => {
    const ranked = rankCandidates('dev', [
      { id: 'maya', role: 'Designer' },
      { id: 'leo', role: 'Voorman' },
      { id: 'alex', role: 'Developer' },
    ]);
    expect(ranked[0]!.id).toBe('alex');
    expect(ranked[0]!.score).toBe(1);
  });

  it('uses stable id tie-breaker when scores tie', () => {
    const ranked = rankCandidates('planner', [
      { id: 'zoe', role: 'Planner' },
      { id: 'alex', role: 'Planner' },
      { id: 'maya', role: 'Planner' },
    ]);
    expect(ranked.map((r) => r.id)).toEqual(['alex', 'maya', 'zoe']);
  });

  it('places zero-score candidates at the end', () => {
    const ranked = rankCandidates('copywriter', [
      { id: 'leo', role: 'Voorman' },
      { id: 'cara', role: 'Copywriter' },
    ]);
    expect(ranked[0]!.id).toBe('cara');
    expect(ranked[1]!.score).toBe(0);
  });
});

describe('MATCH_THRESHOLD', () => {
  it('is a sane default (between 0 and 1)', () => {
    expect(MATCH_THRESHOLD).toBeGreaterThan(0);
    expect(MATCH_THRESHOLD).toBeLessThanOrEqual(1);
  });
});
