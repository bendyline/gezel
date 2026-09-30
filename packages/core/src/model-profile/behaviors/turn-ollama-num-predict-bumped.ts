/**
 * `turn.ollama-num-predict-bumped` — overrides Ollama's per-turn
 * `num_predict` (output-token cap). Verbose-family models chew 2-4k
 * tokens of visible thinking before the actual tool call; the
 * default 16384 covers any normal turn including reasoning, but some
 * quants need more. Manifests can dial in their own value.
 *
 * Migrated from `chat/local-model-tuning.ts`'s `pickOllamaNumPredict`.
 * The legacy function had two regimes — bumped vs default — gated on
 * `leaksUntaggedReasoning(modelId)`. With per-model profiles, each
 * verbose-family manifest opts into this behavior with its own
 * config; non-verbose models simply don't opt in and get the
 * platform default elsewhere.
 *
 * Note: The legacy `DEFAULT_OLLAMA_NUM_PREDICT` (16384) and
 * `VERBOSE_FAMILY_OLLAMA_NUM_PREDICT` (also 16384) are equal today
 * — the bump amounts to "explicitly state the cap so the platform
 * default doesn't apply". Future tuning can diverge them.
 *
 * Config: `{ numPredict: number }` — the per-turn cap to forward
 * to Ollama.
 */

import { z } from 'zod';
import type { Behavior, ModelCtx } from '../types.js';

const TurnOllamaNumPredictBumpedConfig = z.object({
  /** Per-turn output cap (token count) to forward to Ollama. */
  numPredict: z.number().int().min(256).max(131072),
});

type TurnOllamaNumPredictBumpedConfig = z.infer<typeof TurnOllamaNumPredictBumpedConfig>;

export const TurnOllamaNumPredictBumped: Behavior<TurnOllamaNumPredictBumpedConfig> = {
  id: 'turn.ollama-num-predict-bumped',
  description:
    "Overrides Ollama's per-turn `num_predict` (output-token cap). Used by verbose-family models that emit reasoning prose before tool calls. Config: `{ numPredict: number }`.",
  configSchema: TurnOllamaNumPredictBumpedConfig,
  defaultConfig: { numPredict: 16384 },

  numPredict(_ctx: ModelCtx, config: TurnOllamaNumPredictBumpedConfig): number {
    return config.numPredict;
  },
};
