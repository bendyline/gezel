import { describe, expect, it } from 'vitest';
import { buildLetterIndex, letterKeyFor, showsLetterIndex } from './letter-index.js';

describe('letter index', () => {
  it('files initials under their base Latin letter, everything else under #', () => {
    expect(letterKeyFor('m')).toBe('M');
    expect(letterKeyFor('M')).toBe('M');
    expect(letterKeyFor('é')).toBe('E');
    expect(letterKeyFor('1')).toBe('#');
    expect(letterKeyFor('ж')).toBe('#');
    expect(letterKeyFor('')).toBe('#');
  });

  it('keeps every key in order and points each at its first document', () => {
    const entries = buildLetterIndex([
      { initial: '1', offset: 0, count: 12 },
      { initial: '2', offset: 12, count: 3 },
      { initial: 'a', offset: 15, count: 40 },
      { initial: 'c', offset: 55, count: 9 },
      { initial: 'é', offset: 64, count: 1 },
      { initial: 'e', offset: 65, count: 4 },
    ]);
    expect(entries).toHaveLength(27);
    expect(entries[0]).toEqual({ key: '#', offset: 0 });
    expect(entries.find((e) => e.key === 'A')).toEqual({ key: 'A', offset: 15 });
    expect(entries.find((e) => e.key === 'B')).toEqual({ key: 'B', offset: null });
    expect(entries.find((e) => e.key === 'E')).toEqual({ key: 'E', offset: 64 });
  });

  it('only shows for a listing longer than a page that spans two letters', () => {
    const spread = buildLetterIndex([
      { initial: 'a', offset: 0, count: 40 },
      { initial: 'b', offset: 40, count: 40 },
    ]);
    expect(showsLetterIndex(spread, 80, 50)).toBe(true);
    expect(showsLetterIndex(spread, 50, 50)).toBe(false);
    expect(
      showsLetterIndex(buildLetterIndex([{ initial: 'a', offset: 0, count: 80 }]), 80, 50),
    ).toBe(false);
    expect(showsLetterIndex(buildLetterIndex([]), 300, 50)).toBe(false);
  });
});
