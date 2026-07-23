/**
 * `prompt.workspace-gestalt` — marker behavior that turns on the
 * index-derived "Workspace map" block in the system prompt: the project's
 * deep-pass architecture note, folder purposes, and entry points from the
 * content index (see index-store/area-pass.ts). The block gives the model a
 * pre-digested orientation so it reaches for `search_code`/`map_repo`
 * instead of burning turns walking the raw file listing.
 *
 * No hooks — `PromptCtx` carries no project/index handle, so the block text
 * is computed in `ChatManager.buildSessionOpts` (where ContentIndex is
 * reachable) and this behavior is purely the toggle, exactly like
 * `prompt.executor-context-trim`. The block renders in the VOLATILE band
 * (index data drifts as the repo evolves) and is empty until the deep pass
 * has produced summaries, so it costs nothing on un-enriched projects.
 *
 * Tier-default for medium + large local models (attention budget is fine
 * and retrieval scaffolding pays there); OFF for tiny/small (every standing
 * token competes with the deliverable) and cloud (vendor models orient well
 * unaided) pending A/B via GEZEL_FORCE_BEHAVIORS.
 */

import type { Behavior } from '../types.js';

export const PromptWorkspaceGestalt: Behavior = {
  id: 'prompt.workspace-gestalt',
  description:
    'Injects the index-derived "Workspace map" block (architecture note + folder purposes + entry points from the deep-pass rollups) into the volatile prompt band. No hooks; ChatManager computes the block and gates it on this flag. Tier-default medium/large; A/B via GEZEL_FORCE_BEHAVIORS.',
};
