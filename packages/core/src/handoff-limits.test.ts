import { describe, expect, it } from 'vitest';
import { checkHandoffChain, findAskCycleOrDepth } from './handoff-limits.js';

describe('checkHandoffChain', () => {
  const limits = { maxDepth: 3, maxCount: 6 };
  it('allows a fresh chain', () => {
    expect(checkHandoffChain({ ancestors: [], target: 'b', count: 0 }, limits)).toBeNull();
  });
  it('refuses a target already on the chain', () => {
    expect(checkHandoffChain({ ancestors: ['a', 'b'], target: 'a', count: 0 }, limits)).toEqual({
      kind: 'cycle',
    });
  });
  it('refuses past the depth', () => {
    expect(checkHandoffChain({ ancestors: ['a', 'b', 'c'], count: 0 }, limits)).toEqual({
      kind: 'depth',
      limit: 3,
    });
  });
  it('refuses past the count, and ignores count when unbounded', () => {
    expect(checkHandoffChain({ ancestors: [], count: 6 }, limits)).toEqual({
      kind: 'count',
      limit: 6,
    });
    expect(checkHandoffChain({ ancestors: [], count: 99 }, { maxDepth: 5 })).toBeNull();
  });
});

describe('findAskCycleOrDepth', () => {
  const edges = [
    { askerGezelId: 'a', targetGezelId: 'b' },
    { askerGezelId: 'b', targetGezelId: 'c' },
  ];
  it('is fine when the target does not lead back', () => {
    expect(findAskCycleOrDepth(edges, 'a', 'd', 5)).toEqual({ kind: 'ok' });
  });
  it('sees a cycle through in-flight edges', () => {
    expect(findAskCycleOrDepth(edges, 'c', 'a', 5)).toEqual({ kind: 'cycle' });
  });
  it('sees a chain that would run too deep', () => {
    expect(findAskCycleOrDepth(edges, 'x', 'a', 2)).toEqual({ kind: 'depth', maxDepth: 2 });
  });
});
