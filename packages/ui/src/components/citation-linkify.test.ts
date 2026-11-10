import { describe, expect, it } from 'vitest';
import { citationFromHref, linkifyCitations, replySources } from './citation-linkify.js';

const evidence = [
  { n: 1, kind: 'tool' as const, tool: 'wikipedia_read', title: 'Wikipedia: George Washington' },
  { n: 2, kind: 'retrieval' as const, ref: 'knowledge://wikipedia/en/martha#chunk=ab' },
];

const ledger = [
  {
    n: 2,
    kind: 'tool' as const,
    title: 'Wikipedia: Martha',
    ref: 'knowledge://wikipedia/en/martha#chunk=a',
  },
  { n: 3, kind: 'retrieval' as const, ref: 'knowledge://wikipedia/en/martha#chunk=b' },
  { n: 12, kind: 'retrieval' as const, title: 'Menu/menu.md', ref: 'Menu/menu.md' },
  {
    n: 13,
    kind: 'tool' as const,
    tool: 'read_file',
    title: 'Catering/policy.txt',
    ref: 'Catering/policy.txt',
  },
  {
    n: 14,
    kind: 'retrieval' as const,
    title: 'Catering/policy.txt',
    ref: './Catering/policy.txt',
  },
];

describe('linkifyCitations', () => {
  it('links markers whose evidence exists and leaves the rest as text', () => {
    expect(linkifyCitations('Born 1732 [1]. Married 1759 [1, 2]. Died [9].', evidence)).toBe(
      'Born 1732 [\\[1\\]](#cite:1 "Wikipedia: George Washington"). Married 1759 [\\[1\\]](#cite:1 "Wikipedia: George Washington")[\\[2\\]](#cite:2 "knowledge://wikipedia/en/martha#chunk=ab"). Died [9].',
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

  it('shows the number the reader counts, and one link per place in a marker', () => {
    const shownAs = new Map([
      [13, 1],
      [14, 1],
      [2, 2],
    ]);
    expect(linkifyCitations('Kept [13, 14]. Wed [2].', ledger, shownAs)).toBe(
      'Kept [\\[1\\]](#cite:13 "Catering/policy.txt"). Wed [\\[2\\]](#cite:2 "Wikipedia: Martha").',
    );
  });
});

describe('replySources', () => {
  // A first answer that cited one file read "[13]" under "13 sources".
  it('lists only what the reply cites, from 1, one source per place', () => {
    const { sources, shownAs } = replySources(
      'Refund up to 72 hours [13]. Deposit kept [14]. Who was Martha [3, 2]?',
      ledger,
    );
    expect(sources.map((s) => [s.n, s.items.map((i) => i.n)])).toEqual([
      [1, [13, 14]],
      [2, [3, 2]],
    ]);
    expect([...shownAs]).toEqual([
      [13, 1],
      [14, 1],
      [3, 2],
      [2, 2],
    ]);
  });

  it('lists what the turn read when the reply cites nothing, and ignores code', () => {
    const { sources } = replySources('Use `arr[13]` here.', ledger);
    expect(sources.map((s) => s.n)).toEqual([1, 2, 3]);
    expect(sources[0]!.items.map((i) => i.n)).toEqual([2, 3]);
    expect(replySources('Hello [1].', undefined).sources).toEqual([]);
  });
});
