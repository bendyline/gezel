import { describe, expect, it } from 'vitest';
import { GezelGrowthStateSchema, LEVEL_THRESHOLDS, levelForXp, xpForLevel } from './growth.js';

describe('level curve', () => {
  it('level 1 costs nothing and thresholds are strictly increasing', () => {
    expect(xpForLevel(1)).toBe(0);
    expect(xpForLevel(0)).toBe(0);
    for (let lvl = 2; lvl <= 15; lvl++) {
      expect(xpForLevel(lvl)).toBeGreaterThan(xpForLevel(lvl - 1));
    }
  });

  it('gaps between levels widen (plateau gracefully)', () => {
    for (let lvl = 3; lvl <= LEVEL_THRESHOLDS.length; lvl++) {
      const gap = xpForLevel(lvl) - xpForLevel(lvl - 1);
      const prevGap = xpForLevel(lvl - 1) - xpForLevel(lvl - 2);
      expect(gap).toBeGreaterThanOrEqual(prevGap);
    }
  });

  it('levelForXp is the inverse of xpForLevel', () => {
    for (let lvl = 1; lvl <= 14; lvl++) {
      const xp = xpForLevel(lvl);
      expect(levelForXp(xp)).toBe(lvl);
      if (xp > 0) expect(levelForXp(xp - 1)).toBe(lvl - 1);
    }
  });

  it('extrapolates beyond the table', () => {
    expect(xpForLevel(11)).toBe(8000 + 3000);
    expect(xpForLevel(12)).toBe(8000 + 6000);
    expect(levelForXp(8000 + 3000)).toBe(11);
  });
});

describe('GezelGrowthStateSchema', () => {
  it('parses an empty object into level-1 defaults', () => {
    const state = GezelGrowthStateSchema.parse({});
    expect(state.level).toBe(1);
    expect(state.xp).toBe(0);
    expect(state.signals).toEqual({ memoryXp: 0, lessonsXp: 0, taskXp: 0, consultXp: 0 });
    expect(state.adoptedTraits).toEqual([]);
    expect(state.unlockedCosmetics).toEqual([]);
  });

  it('round-trips a populated state', () => {
    const state = GezelGrowthStateSchema.parse({
      level: 3,
      xp: 320,
      signals: { memoryXp: 200, lessonsXp: 30, taskXp: 80, consultXp: 10 },
      pendingLevelUp: {
        toLevel: 4,
        createdAt: '2026-06-11T00:00:00Z',
        proposals: [
          {
            id: 'prop-1',
            kind: 'trait',
            title: 'Tests first',
            traitText: 'Write failing tests before touching implementation code.',
            evidence: [
              { day: '2026-06-01', kind: 'pref', excerpt: 'User asked for tests before code.' },
            ],
          },
          {
            id: 'prop-2',
            kind: 'tuning',
            title: 'Tighter sampling',
            description: 'Lower temperature slightly.',
            action: { type: 'temperature', delta: -0.1 },
          },
          { id: 'prop-3', kind: 'cosmetic', title: 'Straw hat', cosmeticId: 'hat.straw' },
        ],
      },
    });
    expect(state.pendingLevelUp?.proposals).toHaveLength(3);
    expect(GezelGrowthStateSchema.parse(JSON.parse(JSON.stringify(state)))).toEqual(state);
  });
});
