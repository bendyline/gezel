/**
 * Shared helper for the multimodal provider managers: given a model id, decide
 * whether it targets a paired remote server and, if so, return the connection
 * details (the paired record + a cert-pinned fetch). Returns null for local
 * model ids so the manager falls back to its local provider.
 */

import { getPairedRemoteFetch } from '../../remotes/pinned-fetch.js';
import type { PairedRemote, RemotesRegistry } from '../../remotes/registry.js';
import { parseRemoteModelId } from './model-id.js';

export interface RemoteTarget {
  remote: PairedRemote;
  fetch: typeof fetch;
}

export function resolveRemoteTarget(
  model: string | undefined,
  remotes: RemotesRegistry | undefined,
): RemoteTarget | null {
  const parsed = model ? parseRemoteModelId(model) : null;
  if (!parsed || !remotes) return null;
  const remote = remotes.get(parsed.remoteId);
  if (!remote) return null;
  const fetchImpl = getPairedRemoteFetch(remote, remotes);
  return { remote, fetch: fetchImpl };
}
