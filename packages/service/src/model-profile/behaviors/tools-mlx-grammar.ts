/**
 * `tools.mlx-grammar` — opts a model in to decode-time tool-call grammar
 * constraint on the MLX engine and reinforces the schema contract in the
 * system prompt.
 *
 * The MLX server does no server-side tool parsing, so a quantized model
 * that mangles the tool-call format (classically: a *parameter* name
 * emitted as the *function* name) sails into the TS salvage layer, gets
 * rejected as malformed/unknown, and the model apologizes and retries the
 * same bad call — no progress. llama.cpp avoids this because `--jinja`
 * derives a grammar from the chat template and constrains sampling.
 *
 * When this behavior is present, the MLX provider sends a `tool_grammar`
 * hint (derived from `style.family` via `familyToToolGrammarHint`) on the
 * request; the gezel MLX server builds an llguidance grammar that
 * constrains the tool-call function name and, for Hermes-family models,
 * parameter names plus required-field presence. See
 * [tool-grammar.ts](../tool-grammar.ts) and
 * [providers/mlx/python/tool_grammar.py](../../providers/mlx/python/tool_grammar.py).
 *
 * MLX engine only (llama.cpp already has its own grammar via `--jinja`).
 * The provider checks `profileHasBehavior(profile, 'tools.mlx-grammar')` at
 * request-build time. The prompt reminder keeps the required-field rule
 * format-neutral, then adds the Hermes JSON escape syntax only on MLX families
 * that need it for object/array arguments. The model's own chat template
 * supplies its ordinary native syntax. Complements — never replaces — the
 * salvage layer, which stays as the post-hoc safety net.
 */

import type { Behavior, PromptCtx } from '../types.js';

export const ToolsMlxGrammar: Behavior = {
  id: 'tools.mlx-grammar',
  description:
    'Constrains MLX tool-call generation at sampling time via an llguidance grammar (function names, parameter names, and required-field presence) and reinforces that schema contract in the prompt. MLX enforcement is family-derived.',

  promptAppend(ctx: PromptCtx): string | null {
    if (ctx.availableToolNames.size === 0) return null;
    const hermesJsonHint =
      ctx.providerName === 'mlx' && ['qwen', 'qwq', 'nemotron', 'granite'].includes(ctx.family)
        ? `

On this engine, a tool with an object or array argument must use the JSON envelope so its structure is preserved: \`<tool_call>{"name":"…","arguments":{"…":{}}}</tool_call>\`. Use the ordinary native parameter format shown by the tool template for scalar-only calls.`
        : '';
    return `

---

## Tool-call schema contract

Treat each tool schema as literal: every field listed in \`required\` must be present in that call. Optional fields may be omitted. Copy the function and parameter names exactly; an optional control does not replace a missing required input.${hermesJsonHint}`;
  },
};
