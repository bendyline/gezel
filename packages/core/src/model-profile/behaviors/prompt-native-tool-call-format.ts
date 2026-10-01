/**
 * `prompt.native-tool-call-format` — states a model's OWN tool-call
 * syntax in the system prompt, positively and by example.
 *
 * Why this exists: on the MLX engine there is no function-calling
 * channel. The gezel MLX server does no server-side tool extraction by
 * design — every tool call arrives as text and the TS salvage layer
 * promotes it. A model that drifts off its trained tool-call syntax
 * therefore produces nothing callable at all.
 *
 * Wild-caught on LFM2.5-2.6B (MLX, tiny tier). Given a bare prompt the
 * model emits its trained pythonic call flawlessly:
 *
 *     <|tool_call_start|>[write_file(path='x.txt', content='hi')]<|tool_call_end|>
 *
 * Under gezel's assembled ~5.5K-token system prompt it instead emits a
 * fenced *bare arguments object* with the function name dropped
 * entirely — `{"path": "x.txt", "content": "hi"}` — which is
 * unattributable to any tool, so nothing runs. Measured over 8 trials
 * per arm on the real prompt: 0/8 native. Adding this block: 8/8. The
 * effect is not one bad instruction — dropping any single prompt section
 * (including the whole cookbook) left it at 0/8; format adherence simply
 * degrades as the prompt grows, and this block restores the prior.
 *
 * Why a config rather than a family switch: the correct example is
 * per-model, and a model whose format is already pinned by a decode-time
 * grammar (`tools.mlx-grammar`, keyed on `style.family`) does not need
 * it. Config-required, mirroring `tools.mlx-template-fix`: enabling
 * without an `example` resolves to a no-op, so toggling it through
 * `GEZEL_FORCE_BEHAVIORS` in an A/B cannot silently diverge the arms.
 *
 * Complements — never replaces — the salvage layer. Reach for the
 * grammar first when the model's family has one; this is the lever for
 * models that fall through `familyToToolGrammarHint` to null.
 */

import { z } from 'zod';

import type { Behavior, PromptCtx } from '../types.js';

const PromptNativeToolCallFormatConfigSchema = z.object({
  /**
   * A literal one-line call in the model's own trained syntax, complete
   * enough to copy. Rendered verbatim, so it must be the real token
   * sequence the model was trained to emit.
   */
  example: z.string().min(1),
});

export type PromptNativeToolCallFormatConfig = z.infer<
  typeof PromptNativeToolCallFormatConfigSchema
>;

export const PromptNativeToolCallFormat: Behavior<PromptNativeToolCallFormatConfig> = {
  id: 'prompt.native-tool-call-format',
  description:
    "States the model's own tool-call syntax in the system prompt, by example. For local models whose format adherence degrades under a long prompt and that have no decode-time grammar. Config-required (`example`); without it, a no-op.",
  configSchema: PromptNativeToolCallFormatConfigSchema,

  promptAppend(_ctx: PromptCtx, config?: PromptNativeToolCallFormatConfig): string | null {
    const example = config?.example?.trim();
    if (!example) return null;
    return `

---

## Tool-call format

Emit every tool call in exactly this format:

${example}

A tool call written any other way does not run — not a \`\`\`json fenced block, not a bare arguments object without the tool's name. If you decide to call a tool, the call goes out in the format above, in this turn.`;
  },
};
