/**
 * Maps a model's family to the MLX decode-time tool-call grammar hint
 * sent to the gezel MLX server (the `tool_grammar` request field). The
 * server builds an llguidance grammar that constrains the tool-call
 * *function name* to the advertised tools — see
 * [providers/mlx/python/tool_grammar.py](../providers/mlx/python/tool_grammar.py).
 *
 * Keyed on `style.family`, NOT `style.toolCallFormat`: Qwen and Nemotron's
 * catalog `toolCallFormat` is the coarse `function-call`, but on the MLX
 * textual path Qwen 3.5/3.6 and Nemotron 3.5 Lightning emit the Hermes nesting
 * `<tool_call>\n<function=NAME>\n<parameter=...>...</function>\n</tool_call>`
 * (verified against the installed Qwen 3.6 chat template) — so the grammar
 * format is `hermes`, NOT the legacy `<tool_call>{json}</tool_call>`.
 *
 * Conservative on purpose: only families whose MLX textual tool-call
 * format has been verified return a hint. Everything else returns null
 * and falls back to the TS salvage layer (no regression). Add families
 * here as their MLX format is confirmed.
 */

import type { ModelStyle } from '@bendyline/gezel';

/**
 * Tool-call wrapper formats the MLX server's grammar builder supports.
 * `hermes` (Qwen 3.5/3.6) and `glm` (GLM-4.5/4.6) are token-verified —
 * both split the same way: `<tool_call>`/`</tool_call>` are single special
 * tokens, the inner markup (`<function=` / `<arg_key>`) is ordinary bytes.
 * Gemma's special-token format is a fast-follow pending the same
 * verification against a Gemma tokenizer (see tool_grammar.py /
 * tool_grammar_modeltest.py).
 */
export type ToolGrammarFormat = 'hermes' | 'gemma' | 'glm';

export interface ToolGrammarHint {
  format: ToolGrammarFormat;
  /**
   * Enforcement tier. `name-and-params` (tier 2) pins the function name
   * AND each `<parameter=KEY>` key to the chosen tool's declared params;
   * `name-only` (tier 1) pins just the function name. Both leave argument
   * values free (no value-schema recursion → no ParserTooComplex risk).
   */
  mode: 'name-only' | 'name-and-params';
}

export function familyToToolGrammarHint(style: ModelStyle | undefined): ToolGrammarHint | null {
  switch (style?.family) {
    case 'qwen':
    case 'qwq': // Qwen 3.5/3.6 + QwQ emit the Hermes <function=NAME> nesting
    case 'nemotron': // Nemotron 3.5 Lightning uses the same qwen3_coder XML template
      return { format: 'hermes', mode: 'name-and-params' };
    case 'gemma':
      // Gemma 4 emits `<|tool_call>call:NAME{...}<tool_call|>`. Name-only
      // (tier 1) pins the function name to the known-tool enum — proven at the
      // token level against the Gemma tokenizers (tool_grammar_modeltest.py).
      // The `parse.gemma-special-token` TS salvage layer stays on as the
      // post-hoc arg-repair safety net.
      return { format: 'gemma', mode: 'name-only' };
    case 'glm':
      // GLM-4.5/4.6 emit `<tool_call>NAME<arg_key>K</arg_key><arg_value>V</arg_value></tool_call>`.
      // `<tool_call>`/`</tool_call>` are single special tokens; the bare NAME
      // sits right after the opener (no `<function=` wrapper) and the
      // `<arg_key>`/`<arg_value>` body is ordinary bytes — so name-only (tier
      // 1) pins the function name and leaves args free. The GLM TS salvage
      // layer stays on as the post-hoc arg-parse safety net.
      return { format: 'glm', mode: 'name-only' };
    default:
      return null;
  }
}
