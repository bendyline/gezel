/**
 * `provider.flatten-tool-transcript` — marker behavior for models whose
 * chat template enforces strict user/assistant alternation (Mistral
 * family: `Conversation roles must alternate user/assistant/...`).
 *
 * When this behavior is on the resolved profile, the llama-cpp session
 * initializes `flattenToolMessagesForStrictAlternation = true` in its
 * constructor (via `profileHasBehavior`), so it flattens the
 * `assistant(tool_calls) -> tool` transcript into alternating
 * user/assistant turns from the FIRST request — instead of letting each
 * gezel's first tool turn fail with an HTTP 500 and recover reactively
 * ([provider.ts] `tryParseStrictAlternationTemplateError`). In a
 * multi-gezel run the reactive path burns one 500 + retry per gezel;
 * this marker makes it zero.
 *
 * Pure marker — no prompt/hook surface. The logic lives in the llama-cpp
 * provider constructor. OFF by default; attached to mistral-family
 * manifests. The reactive fallback remains for any unmarked model whose
 * template turns out to be strict.
 */

import type { Behavior } from '../types.js';

export const ProviderFlattenToolTranscript: Behavior = {
  id: 'provider.flatten-tool-transcript',
  description:
    'Marks a model whose chat template requires strict user/assistant alternation (Mistral family). The llama-cpp session flattens tool transcripts into alternating turns from the first request, avoiding the per-gezel "Conversation roles must alternate" 500.',
};
