import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { highlightTokens } from './highlight-tokens.js';

function marks(text: string, query: string): string[] {
  const { container } = render(<div>{highlightTokens(text, query)}</div>);
  return [...container.querySelectorAll('mark')].map((m) => m.textContent ?? '');
}

describe('highlightTokens', () => {
  it('marks every occurrence of every token, case-insensitively', () => {
    expect(marks('March 8, 2015 — Lesson 28, spring 2015', '2015')).toEqual(['2015', '2015']);
    expect(marks('Kim is Growing Up', 'kim growing')).toEqual(['Kim', 'Growing']);
  });

  it('keeps the untouched text intact around the marks', () => {
    const { container } = render(<div>{highlightTokens('a 2015 b', '2015')}</div>);
    expect(container.textContent).toBe('a 2015 b');
  });

  it('marks by split position, not by re-testing a sticky regex', () => {
    // `pattern.test()` on a /g regex carries `lastIndex` between calls, which
    // makes each part's fate depend on the parts before it.
    expect(marks('2015 2015 2015', '2015')).toEqual(['2015', '2015', '2015']);
  });

  it('ignores one-character and punctuation-only queries', () => {
    expect(marks('a 2015 b', 'a')).toEqual([]);
    expect(marks('a 2015 b', '---')).toEqual([]);
  });

  it('tokenizes on punctuation rather than matching it', () => {
    // Only letter/number runs of 2+ become tokens, so a punctuated query
    // marks its words and never leaks a regex metacharacter into the pattern.
    expect(marks('cost is c++ (approx)', 'c++')).toEqual([]);
    expect(marks('packages/catalog/src/gstack-import.ts', 'gstack-import')).toEqual([
      'gstack',
      'import',
    ]);
  });
});
