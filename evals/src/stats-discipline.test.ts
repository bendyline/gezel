import { describe, expect, it } from 'vitest';
import { MIN_TRIALS_FOR_RATE, formatPassClaim } from './stats-discipline.ts';

describe('formatPassClaim', () => {
  it('renders a rate at or above the minimum sample', () => {
    expect(formatPassClaim(3, 3)).toBe('3/3 (100.0%)');
    expect(formatPassClaim(3, 4)).toBe('3/4 (75.0%)');
    expect(formatPassClaim(0, 5)).toBe('0/5 (0.0%)');
  });

  it('refuses to claim a rate below the minimum sample', () => {
    const one = formatPassClaim(1, 1);
    expect(one).toContain(`n<${MIN_TRIALS_FOR_RATE}`);
    expect(one).toContain('count not rate');
    expect(one).not.toContain('100.0%');
    expect(one).not.toContain('%');
    expect(formatPassClaim(1, 2)).toContain('1/2 pass');
  });

  it('forceCount renders a count even at a large n (tiny tier)', () => {
    const claim = formatPassClaim(5, 10, { forceCount: true });
    expect(claim).toContain('5/10 pass');
    expect(claim).toContain('tiny tier');
    expect(claim).not.toContain('%');
  });

  it('handles the zero-trial case without dividing by zero', () => {
    expect(formatPassClaim(0, 0)).toBe('0/0 (no trials)');
  });

  it('MIN_TRIALS_FOR_RATE is the documented ≥3 discipline', () => {
    expect(MIN_TRIALS_FOR_RATE).toBe(3);
  });
});
