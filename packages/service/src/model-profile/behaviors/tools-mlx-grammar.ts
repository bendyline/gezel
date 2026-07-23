/**
 * `tools.mlx-grammar` — opts a model in to decode-time tool-call grammar
 * constraint on the MLX engine.
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
 * constrains the tool-call *function name* to the advertised tools (v1 =
 * name-only, arguments left free). See
 * [tool-grammar.ts](../tool-grammar.ts) and
 * [providers/mlx/python/tool_grammar.py](../../providers/mlx/python/tool_grammar.py).
 *
 * MLX engine only (llama.cpp already has its own grammar via `--jinja`).
 * Flag-only: the provider checks `profileHasBehavior(profile,
 * 'tools.mlx-grammar')` at request-build time. Complements — never
 * replaces — the salvage layer, which stays as the post-hoc safety net.
 */

import type { Behavior } from '../types.js';

export const ToolsMlxGrammar: Behavior = {
  id: 'tools.mlx-grammar',
  description:
    'Constrains MLX tool-call generation at sampling time via an llguidance grammar (function name limited to the advertised tools) so quantized models cannot hallucinate/mangle tool names. MLX engine only; the provider derives the grammar format from style.family and the server builds it.',
};
