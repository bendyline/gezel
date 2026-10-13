import type { ResolvedModelProfile } from '../../model-profile/types.js';

/**
 * Behaviors which assume Gezel owns the surrounding agent/tool loop.
 *
 * Connected-app inference is deliberately different: Codex, Pi, OpenCode, or
 * an Ollama client owns its transcript, tools, retries, and completion policy.
 * Provider compatibility behaviors remain valuable there, but Gezel must not
 * abort a turn because the caller's model has not used a tool soon enough.
 */
const GEZEL_OWNED_LOOP_BEHAVIORS = new Set(['turn.ramble-detection']);

/**
 * Keep model/provider compatibility behaviors while removing interventions
 * whose recovery contract only makes sense inside a persisted Gezel chat.
 * Returns the original object when no filtering is necessary.
 */
export function profileForCallerOwnedInference(
  profile: ResolvedModelProfile,
): ResolvedModelProfile {
  const behaviors = profile.behaviors.filter((entry) => !GEZEL_OWNED_LOOP_BEHAVIORS.has(entry.id));
  return behaviors.length === profile.behaviors.length ? profile : { ...profile, behaviors };
}
