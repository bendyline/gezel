/**
 * `parse.gemma-special-token` — marker behavior that opts a model in
 * to the Gemma "special-token" tool-call salvage path.
 *
 * Gemma 4 (especially under mlx-vlm) emits tool calls in a non-OpenAI
 * shape — `<|tool_call|>call:NAME{key:<|"|>value...}<tool_call|>` —
 * that the upstream chat-template parser only sometimes recognizes.
 * Tighter quants emit slight variants (missing pipes, asymmetric
 * close tag) that bypass the structured `tool_calls` event entirely;
 * the call is in the visible content but never runs.
 *
 * The actual parser (`parseGemmaToolCall` and supporting
 * `stripGemmaSpecialTokens` / `LeakyToolCallStripper`) lives in
 * [providers/local-tool-call-salvage.ts](../../providers/local-tool-call-salvage.ts).
 * This behavior is a flag — Step 5's wiring at the salvage entry
 * points checks `profile.behaviors.some(b => b.id ===
 * 'parse.gemma-special-token')` before running the parser. When the
 * behavior is absent, the parser is skipped entirely (saves the regex
 * scan on every iteration for non-Gemma models).
 *
 * Opt in only on Gemma-family manifests. The other formats (Qwen XML
 * `<tool_call>`, Hermes `<function=...>`, Anthropic
 * `<function_calls>`, generic prose-shaped salvage) stay universal —
 * they're cheap, narrow, and useful across families.
 */

import type { Behavior } from '../types.js';

export const ParseGemmaSpecialToken: Behavior = {
  id: 'parse.gemma-special-token',
  description:
    'Enables the Gemma special-token tool-call salvage parser. Decodes `<|tool_call|>call:NAME{...}<tool_call|>` (and its missing-pipe variants) into structured `tool_calls` events when the upstream chat-template parser misses them. Gemma 3 / Gemma 4 family only.',
};
