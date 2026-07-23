/**
 * Deprecated compatibility alias for manifests that still reference
 * `prompt.verbose-reasoning-hint-think`.
 *
 * Historically this prompt named a concrete reasoning wrapper format.
 * That proved brittle: models that do not natively embrace the format
 * try to imitate it and leak malformed marker text. Keep the old id
 * registered, but emit the shared format-neutral guidance.
 */

import type { Behavior } from '../types.js';
import { privateReasoningGuidancePrompt } from './prompt-private-reasoning-guidance.js';

export const PromptVerboseReasoningHintThink: Behavior = {
  id: 'prompt.verbose-reasoning-hint-think',
  description:
    'Deprecated alias for prompt.private-reasoning-guidance. Kept so older manifests no longer inject tag-format instructions.',
  promptAppend: privateReasoningGuidancePrompt,
};
