import { describe, expect, it } from 'vitest';
import { hash32, hueFromString, seeded } from './seed.js';

// Golden values: the decorative layer (rubble, roof vents, future trees) is
// positioned by these — a changed constant would silently rearrange every
// city on upgrade, so determinism is locked as a contract.
describe('hash32', () => {
  it('matches golden values', () => {
    expect(hash32('')).toBe(2166136261);
    expect(hash32('a')).toBe(3826002220);
    expect(hash32('packages/core/src/filemap/engine.ts')).toBe(4201531470);
  });

  it('is deterministic and spreads distinct inputs', () => {
    expect(hash32('foo/bar.ts')).toBe(hash32('foo/bar.ts'));
    expect(hash32('foo/bar.ts')).not.toBe(hash32('foo/baz.ts'));
  });
});

describe('seeded', () => {
  it('produces the same stream for the same seed', () => {
    const a = seeded(hash32('a'));
    expect(a()).toBeCloseTo(0.621685681398958, 12);
    expect(a()).toBeCloseTo(0.30822347407229245, 12);
    expect(a()).toBeCloseTo(0.36686075991019607, 12);
  });

  it('stays in [0, 1) and diverges across seeds', () => {
    const a = seeded(1);
    const b = seeded(2);
    let same = 0;
    for (let i = 0; i < 100; i++) {
      const va = a();
      const vb = b();
      expect(va).toBeGreaterThanOrEqual(0);
      expect(va).toBeLessThan(1);
      if (va === vb) same++;
    }
    expect(same).toBeLessThan(3);
  });
});

describe('hueFromString', () => {
  it('is stable and in range', () => {
    expect(hueFromString('typescript')).toBe(hueFromString('typescript'));
    const h = hueFromString('somelang');
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThan(360);
  });
});
