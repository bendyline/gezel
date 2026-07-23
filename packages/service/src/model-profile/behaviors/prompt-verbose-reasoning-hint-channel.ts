/**
 * Deprecated compatibility alias for manifests that still reference
 * `prompt.verbose-reasoning-hint-channel`.
 *
 * Historically this prompt named the gpt-oss channel wrapper format.
 * Gemma-family local models can detokenize that instruction into
 * malformed visible text, so the prompt now delegates to the shared
 * format-neutral guidance while the strip/capture behavior continues
 * to recognize native or leaked channel markers.
 */

import type { Behavior } from '../types.js';
import { privateReasoningGuidancePrompt } from './prompt-private-reasoning-guidance.js';

export const PromptVerboseReasoningHintChannel: Behavior = {
  id: 'prompt.verbose-reasoning-hint-channel',
  description:
    'Deprecated alias for prompt.private-reasoning-guidance. Kept so older manifests no longer inject tag-format instructions.',
  promptAppend: privateReasoningGuidancePrompt,
};
