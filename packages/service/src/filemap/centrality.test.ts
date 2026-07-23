import { describe, expect, it } from 'vitest';
import { computeImportance } from './centrality.js';

describe('computeImportance', () => {
  it('returns empty for no paths', () => {
    expect(computeImportance([], []).size).toBe(0);
  });

  it('returns all zeros when there are no edges', () => {
    const r = computeImportance(['a.ts', 'b.ts'], []);
    expect(r.get('a.ts')).toBe(0);
    expect(r.get('b.ts')).toBe(0);
  });

  it('scores the hub of a star 1.0 and leaves equal', () => {
    const paths = ['hub.ts', 'a.ts', 'b.ts', 'c.ts', 'd.ts'];
    const edges = ['a.ts', 'b.ts', 'c.ts', 'd.ts'].map((src) => ({ src, dst: 'hub.ts' }));
    const r = computeImportance(paths, edges);
    expect(r.get('hub.ts')).toBe(1);
    const leaves = ['a.ts', 'b.ts', 'c.ts', 'd.ts'].map((p) => r.get(p)!);
    for (const v of leaves) {
      expect(v).toBeLessThan(1);
      expect(v).toBeCloseTo(leaves[0]!, 12);
    }
  });

  it('is transitive along a chain (c > b > a for a→b→c)', () => {
    const r = computeImportance(
      ['a.ts', 'b.ts', 'c.ts'],
      [
        { src: 'a.ts', dst: 'b.ts' },
        { src: 'b.ts', dst: 'c.ts' },
      ],
    );
    expect(r.get('c.ts')!).toBeGreaterThan(r.get('b.ts')!);
    expect(r.get('b.ts')!).toBeGreaterThan(r.get('a.ts')!);
  });

  it('ranks a hub imported by important nodes above one imported by leaves', () => {
    // h1 is imported by x and y, which are themselves imported (important);
    // h2 is imported by two isolated leaves. Equal fan-in, different weight.
    const paths = ['h1.ts', 'h2.ts', 'x.ts', 'y.ts', 'l1.ts', 'l2.ts', 'p.ts', 'q.ts'];
    const edges = [
      { src: 'x.ts', dst: 'h1.ts' },
      { src: 'y.ts', dst: 'h1.ts' },
      { src: 'p.ts', dst: 'x.ts' },
      { src: 'q.ts', dst: 'y.ts' },
      { src: 'l1.ts', dst: 'h2.ts' },
      { src: 'l2.ts', dst: 'h2.ts' },
    ];
    const r = computeImportance(paths, edges);
    expect(r.get('h1.ts')!).toBeGreaterThan(r.get('h2.ts')!);
  });

  it('gives a symmetric cycle equal top rank', () => {
    const r = computeImportance(
      ['a.ts', 'b.ts', 'c.ts'],
      [
        { src: 'a.ts', dst: 'b.ts' },
        { src: 'b.ts', dst: 'c.ts' },
        { src: 'c.ts', dst: 'a.ts' },
      ],
    );
    expect(r.get('a.ts')).toBe(1);
    expect(r.get('b.ts')).toBe(1);
    expect(r.get('c.ts')).toBe(1);
  });

  it('ignores self-edges, duplicate edges, and unknown endpoints', () => {
    const r = computeImportance(
      ['a.ts', 'b.ts'],
      [
        { src: 'a.ts', dst: 'a.ts' },
        { src: 'a.ts', dst: 'b.ts' },
        { src: 'a.ts', dst: 'b.ts' },
        { src: 'ghost.ts', dst: 'b.ts' },
        { src: 'a.ts', dst: 'ghost.ts' },
      ],
    );
    expect(r.get('b.ts')).toBe(1);
    expect(r.get('a.ts')!).toBeLessThan(1);
  });

  it('is deterministic under input reordering', () => {
    const paths = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'hub.ts'];
    const edges = [
      { src: 'a.ts', dst: 'hub.ts' },
      { src: 'b.ts', dst: 'hub.ts' },
      { src: 'c.ts', dst: 'd.ts' },
      { src: 'd.ts', dst: 'hub.ts' },
    ];
    const r1 = computeImportance(paths, edges);
    const r2 = computeImportance([...paths].reverse(), [...edges].reverse());
    for (const p of paths) expect(r2.get(p)).toBe(r1.get(p));
  });
});
