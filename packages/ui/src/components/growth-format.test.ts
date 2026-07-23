import type { GrowthProposal } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import {
  celebrationKey,
  counterTiles,
  formatDay,
  proposalActionLabel,
  xpPercent,
} from './growth-format.js';

describe('xpPercent', () => {
  it('maps progress through the current level to 0–100', () => {
    expect(xpPercent(100, 100, 250)).toBe(0);
    expect(xpPercent(175, 100, 250)).toBe(50);
    expect(xpPercent(250, 100, 250)).toBe(100);
  });

  it('clamps when XP sits above the ceiling (pending level-up)', () => {
    // XP keeps accruing while a level-up awaits resolution — the bar
    // pins at full rather than overflowing.
    expect(xpPercent(400, 100, 250)).toBe(100);
  });

  it('clamps below the floor and tolerates a degenerate range', () => {
    expect(xpPercent(50, 100, 250)).toBe(0);
    expect(xpPercent(50, 100, 100)).toBe(100);
  });
});

describe('formatDay', () => {
  it('renders a memory day as a short chip', () => {
    expect(formatDay('2026-06-01')).toMatch(/Jun.*1/);
  });

  it('passes malformed input through untouched', () => {
    expect(formatDay('not-a-day')).toBe('not-a-day');
  });
});

describe('counterTiles', () => {
  it('produces one tile per XP signal with the raw ratcheted values', () => {
    const tiles = counterTiles({ memoryXp: 42, lessonsXp: 30, taskXp: 70, consultXp: 4 });
    expect(tiles.map((t) => t.label)).toEqual(['Memories', 'Lessons', 'Task work', 'Consults']);
    expect(tiles.map((t) => t.value)).toEqual([42, 30, 70, 4]);
  });
});

describe('celebrationKey', () => {
  it('is stable per (gezel, level) so the flourish never replays', () => {
    expect(celebrationKey('maya', 3)).toBe(celebrationKey('maya', 3));
    expect(celebrationKey('maya', 3)).not.toBe(celebrationKey('maya', 4));
    expect(celebrationKey('maya', 3)).not.toBe(celebrationKey('felix', 3));
  });
});

describe('proposalActionLabel', () => {
  it('labels trait proposals', () => {
    const p: GrowthProposal = {
      id: 'p1',
      kind: 'trait',
      title: 'T',
      traitText: 'Do the thing.',
      evidence: [{ day: '2026-06-01', kind: 'pref', excerpt: 'x'.repeat(30) }],
    };
    expect(proposalActionLabel(p)).toBe('Adopt this trait');
  });

  it('labels profile switches with the canonical profile label', () => {
    const p: GrowthProposal = {
      id: 'p2',
      kind: 'tuning',
      title: 'T',
      description: 'D',
      action: { type: 'profile', profile: 'thinking-coding' },
    };
    expect(proposalActionLabel(p)).toContain('Thinking — Coding');
  });

  it('labels temperature nudges by direction', () => {
    const up: GrowthProposal = {
      id: 'p3',
      kind: 'tuning',
      title: 'T',
      description: 'D',
      action: { type: 'temperature', delta: 0.1 },
    };
    const down: GrowthProposal = { ...up, action: { type: 'temperature', delta: -0.1 } };
    expect(proposalActionLabel(up)).toBe('Run a little warmer');
    expect(proposalActionLabel(down)).toBe('Run a little cooler');
  });

  it('labels cosmetics from the catalog and milestones generically', () => {
    const known: GrowthProposal = {
      id: 'p4',
      kind: 'cosmetic',
      title: 'T',
      cosmeticId: 'hat.straw',
    };
    const milestone: GrowthProposal = { ...known, id: 'p5', cosmeticId: 'level-4' };
    expect(proposalActionLabel(known)).toBe('Unlock straw hat');
    expect(proposalActionLabel(milestone)).toBe('Mark the milestone');
  });
});
