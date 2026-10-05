import { describe, expect, it } from 'vitest';
import { citationFromHref, linkifyCitations } from './citation-linkify.js';

const evidence = [
  { n: 1, kind: 'tool' as const, tool: 'wikipedia_read', title: 'Wikipedia: George Washington' },
  { n: 2, kind: 'retrieval' as const, ref: 'knowledge://wikipedia/en/martha#chunk=ab' },
];

describe('linkifyCitations', () => {
  it('links markers whose evidence exists and leaves the rest as text', () => {
    expect(linkifyCitations('Born 1732 [1]. Married 1759 [1, 2]. Died [9].', evidence)).toBe(
      'Born 1732 [[1]](#cite:1 "Wikipedia: George Washington"). Married 1759 [[1]](#cite:1 "Wikipedia: George Washington")[[2]](#cite:2 "knowledge://wikipedia/en/martha#chunk=ab"). Died [9].',
    );
  });

  it('leaves code, existing links, and messages without evidence alone', () => {
    expect(linkifyCitations('Use `arr[1]` and [1](https://x).', evidence)).toBe(
      'Use `arr[1]` and [1](https://x).',
    );
    expect(linkifyCitations('Born 1732 [1].', undefined)).toBe('Born 1732 [1].');
  });

  it('reads the number back from a clicked link', () => {
    expect(citationFromHref('#cite:12')).toBe(12);
    expect(citationFromHref('#artifact:x')).toBeNull();
  });
});
