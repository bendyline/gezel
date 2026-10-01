/**
 * `provider.merge-system-messages` — marker behavior for models whose
 * chat template enforces a SINGLE system message at the start of the
 * conversation (Qwen 3.x family: the template `raise_exception`s with
 * "System message must be at the beginning of the conversation" the moment
 * a second `role:'system'` turn appears at index > 0).
 *
 * gezel's layered-prefix-cache seeds the per-session "volatile band" as a
 * SEPARATE system message right after the stable system prompt
 * ([provider.ts] constructor) — two system turns — which Qwen's template
 * rejects with an HTTP 500 on the very first request, poisoning the gezel's
 * session before it can land a tool call. When this behavior is on the
 * resolved profile, the llama-cpp session initializes
 * `mergeSystemMessages = true` in its constructor (via `profileHasBehavior`),
 * collapsing every system turn into one leading system message from the
 * FIRST request — instead of letting each gezel's first turn 500 and
 * recover reactively ([provider.ts] `tryParseSystemMessageOrderingError`).
 * In a multi-gezel run the reactive path burns one 500 + retry per gezel;
 * this marker makes it zero.
 *
 * Pure marker — no prompt/hook surface. The logic lives in the llama-cpp
 * provider. OFF by default; attached to Qwen-family manifests. The reactive
 * fallback remains for any unmarked model whose template turns out to
 * require a single leading system message.
 */

import type { Behavior } from '../types.js';

export const ProviderMergeSystemMessages: Behavior = {
  id: 'provider.merge-system-messages',
  description:
    'Marks a model whose chat template requires a single system message at the start (Qwen 3.x family). The llama-cpp session collapses all system turns into one leading system message from the first request, avoiding the per-gezel "System message must be at the beginning" 500.',
};
