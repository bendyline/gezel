/**
 * `turn.preamble-folding` — marker behavior that opts a model in to
 * the pre-tool-call preamble fold inside the tool loop. When this
 * behavior is on the resolved profile, the provider tool loop calls
 * `foldPreToolPreamble()` to drop the model's reasoning preamble
 * ("Let me check the URL", "The user wants…") on iterations that
 * produced a tool call OR fired ask_user_question earlier in the same
 * turn.
 *
 * No hooks — the existing `foldPreToolPreamble()` helper in
 * [providers/local-tool-call-salvage.ts](../../providers/local-tool-call-salvage.ts)
 * carries the actual logic, including all the runtime flags
 * (`toolCallsFired`, `askedQuestionThisTurn`) that don't fit our hook
 * surface. Step 5 swaps the call sites in
 * [providers/ollama.ts](../../providers/ollama.ts),
 * [providers/llama-cpp/provider.ts](../../providers/llama-cpp/provider.ts),
 * and [providers/mlx/provider.ts](../../providers/mlx/provider.ts)
 * from a `leaksUntaggedReasoning(modelId)` substring check to
 * `profile.behaviors.some(b => b.id === 'turn.preamble-folding')`.
 *
 * Pair with the reasoning-strip behaviors: preamble-folding drops
 * the prose between tool iterations; reasoning-strip captures the
 * prose wrapped in tags. Most verbose-family models opt into both.
 */

import type { Behavior } from '../types.js';

export const TurnPreambleFolding: Behavior = {
  id: 'turn.preamble-folding',
  description:
    'Opts a model in to the per-iteration pre-tool-call preamble fold. When set, providers drop visible prose emitted before a tool call (the private reasoning trail that should not be visible). Verbose-family local models only - non-verbose models emitting "I will..." prose are doing so deliberately.',
};
