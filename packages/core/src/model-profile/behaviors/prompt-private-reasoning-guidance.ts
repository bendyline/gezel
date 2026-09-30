/**
 * Retired compatibility marker for manifests that still reference
 * `prompt.private-reasoning-guidance`.
 *
 * Reasoning extraction belongs to provider/runtime handling, while action
 * discipline already lives in the universal conduct layer. The former prompt
 * mixed those concerns with task-specific HTML and eval coaching, so it no
 * longer injects system-prompt text. Keep the id registered until pinned and
 * older catalogs stop declaring it.
 */

import type { Behavior } from '../types.js';

export const PromptPrivateReasoningGuidance: Behavior = {
  id: 'prompt.private-reasoning-guidance',
  description:
    'Retired compatibility marker. Reasoning privacy is handled by the provider/runtime and action discipline by the universal conduct layer; injects no prompt text.',
};
