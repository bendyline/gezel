/**
 * `turn.ramble-detection` — opts a model in to the per-iteration
 * ramble watchdog, with tunable cold + post-action thresholds.
 *
 * The watchdog measures prose-since-last-action: when the model
 * emits a tool-call signal (markup substring or structured delta),
 * the counter resets; if the next prose run exceeds the threshold
 * from that anchor, the iteration aborts. Catches the wild-caught
 * "Qwen 3.6 27B writes one tool, narrates 4000 chars about what it
 * would do next, never closes with another action" failure mode.
 *
 * Implementation lives in
 * [providers/ramble-detector.ts](../../providers/ramble-detector.ts).
 * This behavior is config-only — Step 5 reads the validated `config`
 * off the resolved profile and passes it to `new RambleDetector(...)`
 * inside each provider's tool loop (ollama / llama-cpp / mlx). When
 * the behavior is absent from the profile, the providers instantiate
 * the detector with `enabled: false` (preserving today's behavior
 * for non-verbose-family models).
 *
 * Parameterization:
 *   - `coldThreshold` — char cap before any tool-call signal has
 *     been seen this iteration. Defaults to 6000 (~1500 tokens at
 *     typical local tok/s, ~90s of "model is talking but hasn't
 *     engaged tools").
 *   - `postActionThreshold` — char cap once any tool-call signal
 *     has appeared. Tighter than `coldThreshold` so the model
 *     can't burn another full budget rambling after engaging tools.
 *     Defaults to 1500 (a quarter of the cold cap).
 *
 * The plan calls out tightening these on Gemma 26B
 * (`coldThreshold: 4000, postActionThreshold: 1000`) without
 * affecting Qwen — exactly the per-model knob the substring-match
 * gating couldn't express.
 */

import { z } from 'zod';
import type { Behavior } from '../types.js';

const TurnRambleDetectionConfigSchema = z.object({
  coldThreshold: z.number().int().min(500).max(50000),
  postActionThreshold: z.number().int().min(200).max(20000),
});

export type TurnRambleDetectionConfig = z.infer<typeof TurnRambleDetectionConfigSchema>;

export const TurnRambleDetection: Behavior<TurnRambleDetectionConfig> = {
  id: 'turn.ramble-detection',
  description:
    'Per-iteration ramble watchdog with tunable cold + post-action char thresholds. Aborts the iteration when the model produces too much prose without firing a tool. Verbose-family local models only.',
  configSchema: TurnRambleDetectionConfigSchema,
  defaultConfig: { coldThreshold: 6000, postActionThreshold: 1500 },
};
