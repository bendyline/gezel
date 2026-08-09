import { describe, expect, it } from 'vitest';
import {
  claimSegments,
  containsOnlyQualifiedClaim,
  containsUnqualifiedClaim,
} from './claim-guards.ts';

const COMPLETED_1843 = /engine[\s\S]{0,60}(?:built|completed|operational)[\s\S]{0,40}1843/i;
const NEGATED = /\b(?:not|never|nothing|no)\b|wasn['’]?t|isn['’]?t/i;

const FIRST_PROGRAMMER = /first (?:computer )?programmer/i;
const HEDGED = /debate|contested|shorthand|often described|historians? (?:differ|disagree)/i;

describe('claimSegments', () => {
  it('splits on sentence and line boundaries', () => {
    expect(claimSegments('One. Two!\n- Three\n\nFour')).toEqual([
      'One.',
      'Two!',
      '- Three',
      'Four',
    ]);
  });
});

describe('containsUnqualifiedClaim', () => {
  it('flags a bare forbidden claim', () => {
    expect(
      containsUnqualifiedClaim('The engine was completed in 1843.', COMPLETED_1843, NEGATED),
    ).toBe(true);
  });

  it('does not flag the same words under a negation in the same sentence', () => {
    expect(
      containsUnqualifiedClaim(
        'Nothing resembling the engine was completed in 1843.',
        COMPLETED_1843,
        NEGATED,
      ),
    ).toBe(false);
  });

  it('does not let a qualifier in a neighbouring sentence launder the claim', () => {
    expect(
      containsUnqualifiedClaim(
        'The machine was never built. The engine was completed in 1843.',
        COMPLETED_1843,
        NEGATED,
      ),
    ).toBe(true);
  });
});

describe('containsOnlyQualifiedClaim', () => {
  it('accepts a claim hedged in its own sentence', () => {
    expect(
      containsOnlyQualifiedClaim(
        'Lovelace is often described as the first programmer, a debated shorthand.',
        FIRST_PROGRAMMER,
        HEDGED,
      ),
    ).toBe(true);
  });

  it('rejects a bare assertion even when a hedge appears elsewhere', () => {
    expect(
      containsOnlyQualifiedClaim(
        'Historians debate her role. Lovelace was the first programmer.',
        FIRST_PROGRAMMER,
        HEDGED,
      ),
    ).toBe(false);
  });

  it('rejects text that never makes the claim at all', () => {
    expect(containsOnlyQualifiedClaim('She wrote Note G.', FIRST_PROGRAMMER, HEDGED)).toBe(false);
  });
});
