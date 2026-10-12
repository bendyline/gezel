import type { ConfigResponse } from '@bendyline/gezel-client';
import { api } from '../api.js';

/**
 * Whether the on-device engine still has to be fetched before a llama.cpp
 * model can answer, and which build to fetch.
 *
 * The daemon fetches llama-server lazily, the first time a turn needs it.
 * Chat is held until the model is on disk, so the first message sent after
 * "I'm ready" was the turn that started the engine download, and it failed
 * with "the engine is downloading — try again in a moment". First run now
 * lasts until both the model and the engine are in place.
 *
 * Null when nothing is needed: another provider, a build with no pinned
 * engine release (the daemon could not fetch one anyway), an engine already
 * resolved, or a daemon too old to say.
 */
export async function llamaEngineNeed(
  config: Pick<ConfigResponse, 'provider' | 'llamaCppBackendOverride'> | null,
): Promise<{ variant?: string } | null> {
  if (config?.provider !== 'llama-cpp') return null;
  const status = await api.getNativeEngineStatus().catch(() => null);
  if (!status?.pinned) return null;
  const llama = status.engines.find((engine) => engine.name === 'llama-server');
  if (!llama || llama.installed) return null;
  const override = config.llamaCppBackendOverride;
  const variant = override && override !== 'auto' ? override : status.llamaBackend;
  return variant ? { variant } : {};
}
