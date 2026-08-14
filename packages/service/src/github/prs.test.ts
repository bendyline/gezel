import { describe, expect, it } from 'vitest';
import { filterUnifiedDiffByPath, sliceTextPage } from './prs.js';

const DIFF = [
  'diff --git a/src/early.ts b/src/early.ts',
  '--- a/src/early.ts',
  '+++ b/src/early.ts',
  '@@ -1 +1 @@',
  '-old',
  '+early',
  'diff --git a/src/late api.ts b/src/late api.ts',
  '--- a/src/late api.ts',
  '+++ b/src/late api.ts',
  '@@ -1 +1 @@',
  '-old',
  '+export function assuredApi() {}',
  '',
].join('\n');

describe('pull-request review paging', () => {
  it('reports an explicit continuation until every character was delivered', () => {
    const first = sliceTextPage('abcdefghij', 0, 4);
    expect(first).toEqual({
      diff: 'abcd',
      offset: 0,
      returnedChars: 4,
      totalChars: 10,
      truncated: true,
      nextOffset: 4,
    });

    const last = sliceTextPage('abcdefghij', first.nextOffset, 20);
    expect(last).toMatchObject({
      diff: 'efghij',
      offset: 4,
      returnedChars: 6,
      totalChars: 10,
      truncated: false,
    });
    expect(last.nextOffset).toBeUndefined();
  });

  it('can retrieve a late changed path without sending the early prefix', () => {
    const selected = filterUnifiedDiffByPath(DIFF, 'src/late api.ts');
    expect(selected).toContain('assuredApi');
    expect(selected).not.toContain('early.ts');
  });

  it('returns an empty selection for a path that is not in the PR', () => {
    expect(filterUnifiedDiffByPath(DIFF, 'src/missing.ts')).toBe('');
  });
});
