/**
 * Deprecated compatibility alias for manifests that still reference
 * `prompt.verbose-reasoning-hint-channel`.
 *
 * Historically this prompt named the gpt-oss channel wrapper format. Prompt
 * coaching is now retired: provider/runtime handling owns reasoning capture
 * and stripping. Keep the id registered until older manifests age out.
 */

import type { Behavior } from '../types.js';

export const PromptVerboseReasoningHintChannel: Behavior = {
  id: 'prompt.verbose-reasoning-hint-channel',
  description:
    'Retired compatibility alias for prompt.private-reasoning-guidance; injects no prompt text.',
};
