import type { CraftbookStepStage } from '../schemas/craftbook.js';

/** Where a step ran: on this computer's engine, or a hosted model. */
export type EtaEngine = 'device' | 'cloud';

/**
 * What a stage takes when this install has never timed one. Hand-set from
 * the October 2026 eval runs (a 12B–27B on-device model against a hosted
 * frontier model); `STEP_DURATION_SEEDS` refines them per book.
 */
export const STAGE_DURATION_SEEDS: Readonly<
  Record<EtaEngine, Readonly<Record<CraftbookStepStage, number>>>
> = {
  device: { intake: 2 * 60_000, make: 5 * 60_000, check: 3 * 60_000 },
  cloud: { intake: 30_000, make: 90_000, check: 45_000 },
};

/**
 * Shipped per-step medians, keyed `<bookId>:<stepId>`, for the first run of
 * a book on an install. Empty until the eval export fills it; a missing
 * entry falls through to this install's stage medians, then the stage seeds.
 */
export const STEP_DURATION_SEEDS: Readonly<
  Record<string, Readonly<Partial<Record<EtaEngine, number>>>>
> = {};
