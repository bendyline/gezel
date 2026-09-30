/**
 * `turn.continuation-budget` — overrides the default per-send
 * continuation-nudge budget. Each user-initiated send can fire up to
 * N synthetic re-prompts before the chat manager gives up and shows
 * the (possibly-stalled) reply to the user. Tier-default for tiny is
 * 4; everyone else gets 2.
 *
 * Migrated from `chat/manager.ts`'s `maxContinuationsForTier`. The
 * tier-keyed magic number becomes per-model `config: { count }`, so
 * any model can declare its own budget without code changes.
 */

import { z } from 'zod';
import type { Behavior, ModelCtx } from '../types.js';

const TurnContinuationBudgetConfig = z.object({
  /** Max number of continuation nudges per user-initiated send. */
  count: z.number().int().min(0).max(10),
});

type TurnContinuationBudgetConfig = z.infer<typeof TurnContinuationBudgetConfig>;

export const TurnContinuationBudget: Behavior<TurnContinuationBudgetConfig> = {
  id: 'turn.continuation-budget',
  description:
    'Overrides the default 2-continuation-per-send budget. Used by tier:tiny models that need extra slack to land single-tool-per-turn rituals. Config: `{ count: number }`.',
  configSchema: TurnContinuationBudgetConfig,
  defaultConfig: { count: 2 },

  continuationBudget(_ctx: ModelCtx, config: TurnContinuationBudgetConfig): number {
    return config.count;
  },
};
