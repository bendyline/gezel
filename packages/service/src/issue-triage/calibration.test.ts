import type { BoekwachterIssue, IssueVerdictEntry } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import {
  expectedRealScore,
  isLowConfidence,
  issueVerdictStats,
  issueVerdictStatsResponse,
  wilsonInterval,
} from './calibration.js';

let n = 0;
function verdict(over: Partial<IssueVerdictEntry>): IssueVerdictEntry {
  n += 1;
  return {
    id: `v${n}`,
    issueId: `i${n}`,
    fingerprint: 'f',
    ref: `BW-${n}`,
    path: 'src/a.ts',
    kind: 'not_a_bug',
    by: { kind: 'app', client: 'claude-code' },
    at: 'x',
    severity: 'minor',
    category: 'smell',
    message: 'm',
    reviewModel: 'qwen',
    ...over,
  };
}

const issue = (over: Partial<BoekwachterIssue> = {}): BoekwachterIssue => ({
  id: 'x',
  ref: 'BW-99',
  fingerprint: 'f',
  path: 'src/a.ts',
  severity: 'minor',
  category: 'smell',
  message: 'm',
  status: 'open',
  seen: false,
  stale: false,
  createdAt: 'x',
  lastSeenAt: 'x',
  reviewModel: 'qwen',
  ...over,
});

describe('how often the reviewer is right', () => {
  it('counts nits as true leads and only not-a-bug as wrong', () => {
    const stats = issueVerdictStats([
      verdict({ kind: 'fixed' }),
      verdict({ kind: 'nit' }),
      verdict({ kind: 'not_a_bug' }),
      verdict({ kind: 'unsure' }),
    ]);
    expect(stats.overall).toEqual({ decided: 3, actionable: 1, valid: 2, wrong: 1 });
  });

  it('counts the latest verdict per issue, and a reopening against the app it undid', () => {
    const stats = issueVerdictStats([
      verdict({ issueId: 'a', kind: 'not_a_bug' }),
      verdict({ issueId: 'a', kind: 'reopened', by: { kind: 'person' } }),
      verdict({ issueId: 'b', kind: 'not_a_bug' }),
      verdict({ issueId: 'b', kind: 'confirmed', by: { kind: 'person' } }),
    ]);
    expect(stats.overall).toEqual({ decided: 1, actionable: 1, valid: 1, wrong: 0 });
    expect(stats.apps.get('claude-code')).toEqual({
      decided: 2,
      dismissed: 2,
      reopenedByPerson: 1,
    });
  });

  it('ranks a category that is often real above one that rarely is', () => {
    const stats = issueVerdictStats([
      ...Array.from({ length: 10 }, () => verdict({ category: 'bug', kind: 'confirmed' })),
      ...Array.from({ length: 10 }, () => verdict({ category: 'smell', kind: 'not_a_bug' })),
    ]);
    expect(expectedRealScore(stats, issue({ category: 'bug' }))).toBeGreaterThan(
      expectedRealScore(stats, issue({ category: 'smell' })),
    );
    // With no verdicts at all, every issue gets the same prior.
    expect(expectedRealScore(issueVerdictStats([]), issue())).toBeCloseTo(0.3);
  });

  it('sets a category aside only on plenty of evidence, and never a major issue', () => {
    const few = issueVerdictStats(Array.from({ length: 20 }, () => verdict({})));
    expect(isLowConfidence(few, issue())).toBe(false);
    const many = issueVerdictStats(Array.from({ length: 45 }, () => verdict({})));
    expect(isLowConfidence(many, issue())).toBe(true);
    expect(isLowConfidence(many, issue({ severity: 'major' }))).toBe(false);
    expect(isLowConfidence(many, issue({ reviewModel: 'another-model' }))).toBe(false);
    expect(issueVerdictStatsResponse(many).categories[0]).toMatchObject({
      category: 'smell',
      decided: 45,
      lowConfidence: true,
    });
  });

  it('computes a Wilson interval that is honest about small samples', () => {
    const [lo, hi] = wilsonInterval(3, 20);
    expect(lo).toBeGreaterThan(0.04);
    expect(hi).toBeLessThan(0.38);
    expect(wilsonInterval(0, 0)).toEqual([0, 1]);
  });
});
