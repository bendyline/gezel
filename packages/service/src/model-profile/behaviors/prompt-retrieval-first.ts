/**
 * `prompt.retrieval-first` — marker behavior that appends one imperative
 * line to the `### Workspace files` block steering the model toward the
 * indexed retrieval tools (`search_code` by meaning, `search_files` by
 * pattern) instead of readFile-walking the listing. File-walking is the
 * classic local-model failure: each read burns a turn and floods the
 * context with whole files the model then attends to instead of the task.
 *
 * No hooks — `buildInstructions` gates the line on this flag AND on the
 * retrieval tools actually being in the session's tool surface (a nudge
 * toward a tool the allowlist evicted would be a fabrication invitation).
 *
 * Tier-default for tiny/small/medium local models; large/cloud navigate
 * listings efficiently enough that the extra standing line isn't earned.
 * A/B via GEZEL_FORCE_BEHAVIORS / GEZEL_REMOVE_BEHAVIORS.
 */

import type { Behavior } from '../types.js';

export const PromptRetrievalFirst: Behavior = {
  id: 'prompt.retrieval-first',
  description:
    'Appends a one-line "locate with search_code/search_files, don\'t readFile-walk" steer to the workspace-files block, gated on the tools actually being available. No hooks; buildInstructions checks the flag. Tier-default tiny/small/medium.',
};
