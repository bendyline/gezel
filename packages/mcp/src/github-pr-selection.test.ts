import { describe, expect, it } from 'vitest';
import { prioritizePullsForCurrentBranch } from './github-pr-selection.js';

describe('prioritizePullsForCurrentBranch', () => {
  const pulls = [
    { number: 19, headRef: 'feature/other' },
    { number: 23, headRef: 'codex/pr-review' },
    { number: 7, headRef: 'feature/older' },
  ];

  it('moves the checked-out branch PR to the front', () => {
    const result = prioritizePullsForCurrentBranch(pulls, 'codex/pr-review');

    expect(result.pulls.map((pull) => pull.number)).toEqual([23, 19, 7]);
    expect(result.currentBranch).toBe('codex/pr-review');
    expect(result.matchingCount).toBe(1);
    expect(pulls.map((pull) => pull.number)).toEqual([19, 23, 7]);
  });

  it('reports ambiguity while preserving provider order among matches', () => {
    const result = prioritizePullsForCurrentBranch(
      [
        { number: 5, headRef: 'same' },
        { number: 8, headRef: 'other' },
        { number: 3, headRef: 'same' },
      ],
      'same',
    );

    expect(result.pulls.map((pull) => pull.number)).toEqual([5, 3, 8]);
    expect(result.matchingCount).toBe(2);
  });

  it('keeps the provider order when the branch is unknown or unmatched', () => {
    expect(prioritizePullsForCurrentBranch(pulls).pulls).toEqual(pulls);
    expect(prioritizePullsForCurrentBranch(pulls, 'missing')).toMatchObject({
      pulls,
      currentBranch: 'missing',
      matchingCount: 0,
    });
  });
});
