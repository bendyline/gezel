/**
 * Pure presentation helpers for the Growth tab. Lives separately from
 * `GrowthPanel.tsx` so unit tests can import the math without pulling
 * in `api.ts` (window-touching at module scope, not Node-safe).
 */

import type { GrowthProposal, GrowthSignals } from '@bendyline/gezel';
import { CANONICAL_PROFILES, growthCosmeticById, isKnownProfileId } from '@bendyline/gezel';

/**
 * Progress through the CURRENT level as 0–100. `floor` is the XP that
 * earned the current level, `ceil` the next threshold. Clamped — XP can
 * sit above the ceiling while a level-up is pending resolution.
 */
export function xpPercent(xp: number, floor: number, ceil: number): number {
  if (ceil <= floor) return 100;
  const pct = ((xp - floor) / (ceil - floor)) * 100;
  return Math.max(0, Math.min(100, Math.round(pct)));
}

/** `2026-06-01` → `Jun 1` (memory evidence day chips). */
export function formatDay(day: string): string {
  const [y, m, d] = day.split('-').map((s) => Number.parseInt(s, 10));
  if (!y || !m || !d) return day;
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export const MEMORY_KIND_LABELS: Record<string, string> = {
  fact: 'Fact',
  decision: 'Decision',
  pref: 'Preference',
  status: 'Status',
};

export interface CounterTile {
  label: string;
  value: number;
  /** Short explanation of where the points come from. */
  hint: string;
}

/**
 * Character-sheet counters — one tile per XP signal. Honest state only:
 * these are the actual ratcheted XP components, not synthesized counts.
 */
export function counterTiles(signals: GrowthSignals): CounterTile[] {
  return [
    {
      label: 'Memories',
      value: signals.memoryXp,
      hint: 'Distinct deduplicated memories — preferences and decisions weigh most.',
    },
    {
      label: 'Lessons',
      value: signals.lessonsXp,
      hint: 'Times the distilled lessons file was refined.',
    },
    {
      label: 'Task work',
      value: signals.taskXp,
      hint: 'Completed task steps and finished tasks.',
    },
    {
      label: 'Consults',
      value: signals.consultXp,
      hint: 'Delivered gezel-to-gezel consultations (daily-capped).',
    },
  ];
}

/** localStorage latch key so a level-up celebration never replays. */
export function celebrationKey(gezelId: string, level: number): string {
  return `gezel-growth-celebrated:${gezelId}:${level}`;
}

/** Accept-button label for a proposal card. */
export function proposalActionLabel(proposal: GrowthProposal): string {
  switch (proposal.kind) {
    case 'trait':
      return 'Adopt this trait';
    case 'tuning':
      if (proposal.action.type === 'profile') {
        const id = proposal.action.profile;
        const label = isKnownProfileId(id) ? CANONICAL_PROFILES[id].label : id;
        return `Switch to ${label}`;
      }
      return proposal.action.delta > 0 ? 'Run a little warmer' : 'Run a little cooler';
    case 'cosmetic': {
      const cosmetic = growthCosmeticById(proposal.cosmeticId);
      return cosmetic ? `Unlock ${cosmetic.label.toLowerCase()}` : 'Mark the milestone';
    }
  }
}
