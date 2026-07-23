/**
 * Gezel growth — purposeful gamification. Gezels accumulate XP from real
 * learning signals (deduplicated kind-tagged memories, distilled lessons,
 * completed task work, delivered consultations); crossing a level
 * threshold creates a pending level-up whose 2–4 proposals the USER
 * resolves: evidence-grounded traits (prompt changes), bounded tuning
 * nudges, or cosmetic unlocks. The system never edits a gezel without
 * that consent.
 *
 * The level curve lives here (core) so the service computes and the UI
 * renders progress from the same math.
 */

import { z } from 'zod';
import { TuningProfileIdSchema } from './tuning-profile-registry.js';

/** A verbatim excerpt from a real gezel-scope memory entry. */
export const GrowthEvidenceSchema = z.object({
  /** Memory-file day (YYYY-MM-DD) — rewritten server-side from the matched entry. */
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  kind: z.enum(['fact', 'decision', 'pref', 'status']),
  excerpt: z.string().min(1).max(400),
});
export type GrowthEvidence = z.infer<typeof GrowthEvidenceSchema>;

export const TraitProposalSchema = z.object({
  id: z.string(),
  kind: z.literal('trait'),
  title: z.string().min(1).max(80),
  /** One imperative second-person sentence destined for the prompt. */
  traitText: z.string().min(1).max(200),
  evidence: z.array(GrowthEvidenceSchema).min(1).max(3),
});
export type TraitProposal = z.infer<typeof TraitProposalSchema>;

export const TuningActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('profile'), profile: TuningProfileIdSchema }),
  /** Resolved + clamped at accept time against the then-current frontmatter. */
  z.object({ type: z.literal('temperature'), delta: z.union([z.literal(0.1), z.literal(-0.1)]) }),
]);
export type TuningAction = z.infer<typeof TuningActionSchema>;

export const TuningProposalSchema = z.object({
  id: z.string(),
  kind: z.literal('tuning'),
  title: z.string().max(80),
  description: z.string().max(300),
  action: TuningActionSchema,
});
export type TuningProposal = z.infer<typeof TuningProposalSchema>;

export const CosmeticProposalSchema = z.object({
  id: z.string(),
  kind: z.literal('cosmetic'),
  title: z.string().max(80),
  /** Key into GROWTH_COSMETICS, or a generic `level-N` milestone marker. */
  cosmeticId: z.string(),
});
export type CosmeticProposal = z.infer<typeof CosmeticProposalSchema>;

export const GrowthProposalSchema = z.discriminatedUnion('kind', [
  TraitProposalSchema,
  TuningProposalSchema,
  CosmeticProposalSchema,
]);
export type GrowthProposal = z.infer<typeof GrowthProposalSchema>;

export const PendingLevelUpSchema = z.object({
  toLevel: z.number().int().min(2),
  proposals: z.array(GrowthProposalSchema).min(1).max(5),
  createdAt: z.string(),
});
export type PendingLevelUp = z.infer<typeof PendingLevelUpSchema>;

/**
 * Per-signal lifetime XP. Ratcheted (per-field max against recomputed
 * values) so memory compaction merging old entries never lowers XP.
 */
export const GrowthSignalsSchema = z.object({
  memoryXp: z.number().int().nonnegative().default(0),
  lessonsXp: z.number().int().nonnegative().default(0),
  taskXp: z.number().int().nonnegative().default(0),
  consultXp: z.number().int().nonnegative().default(0),
});
export type GrowthSignals = z.infer<typeof GrowthSignalsSchema>;

export const AdoptedTraitRecordSchema = z.object({
  traitId: z.string(),
  text: z.string(),
  level: z.number().int(),
  adoptedAt: z.string(),
  evidence: z.array(GrowthEvidenceSchema),
  /** Set when the user later retires the trait — kept for the character sheet. */
  removedAt: z.string().optional(),
});
export type AdoptedTraitRecord = z.infer<typeof AdoptedTraitRecordSchema>;

export const DeclinedProposalRecordSchema = z.object({
  kind: z.enum(['trait', 'tuning', 'cosmetic']),
  title: z.string(),
  /** Used for never-re-offer matching on trait proposals. */
  traitText: z.string().optional(),
  level: z.number().int(),
  declinedAt: z.string(),
});
export type DeclinedProposalRecord = z.infer<typeof DeclinedProposalRecordSchema>;

export const GezelGrowthStateSchema = z.object({
  version: z.literal(1).default(1),
  level: z.number().int().min(1).default(1),
  xp: z.number().int().nonnegative().default(0),
  signals: GrowthSignalsSchema.prefault({}),
  lastComputedAt: z.string().optional(),
  pendingLevelUp: PendingLevelUpSchema.optional(),
  adoptedTraits: z.array(AdoptedTraitRecordSchema).default([]),
  declinedProposals: z.array(DeclinedProposalRecordSchema).default([]),
  unlockedCosmetics: z.array(z.object({ id: z.string(), at: z.string() })).default([]),
});
export type GezelGrowthState = z.infer<typeof GezelGrowthStateSchema>;

/** Lightweight growth summary inlined on gezel list/detail responses. */
export const GezelGrowthSummarySchema = z.object({
  level: z.number().int().min(1),
  /** True when a level-up is waiting for the user's choice. */
  pending: z.boolean().optional(),
});
export type GezelGrowthSummary = z.infer<typeof GezelGrowthSummarySchema>;

/**
 * Cumulative XP required to REACH each level (index = level - 1).
 * Gaps: 100, 150, 250, 400, 600, 900, 1300, 1800, 2500 — a gezel logging
 * ~10 deduplicated memories a day plus occasional task work reaches L2 in
 * days, L5 in weeks, L10 in months. Beyond 10: +3000/level.
 */
export const LEVEL_THRESHOLDS = [0, 100, 250, 500, 900, 1500, 2400, 3700, 5500, 8000] as const;
const BEYOND_10_STEP = 3000;

/** Cumulative XP required to reach `level` (level 1 = 0). */
export function xpForLevel(level: number): number {
  if (level <= 1) return 0;
  if (level <= LEVEL_THRESHOLDS.length) return LEVEL_THRESHOLDS[level - 1]!;
  return (
    LEVEL_THRESHOLDS[LEVEL_THRESHOLDS.length - 1]! +
    (level - LEVEL_THRESHOLDS.length) * BEYOND_10_STEP
  );
}

/** Highest level whose threshold `xp` meets. Open-ended above 10. */
export function levelForXp(xp: number): number {
  let level = 1;
  while (xp >= xpForLevel(level + 1)) level++;
  return level;
}
