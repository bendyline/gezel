/**
 * Namespacing for remote model ids. A single `remote` provider fronts every
 * paired server; the specific server + model are encoded in the id as
 * `remote:<remoteId>/<bLocalId>` where `<remoteId>` selects the connection and
 * `<bLocalId>` is the model id as B knows it (opaque to A). Example:
 *   remote:a1b2c3d4/llama-cpp:qwen2.5-72b
 */

const PREFIX = 'remote:';

export function isRemoteModelId(id: string | undefined | null): id is string {
  return typeof id === 'string' && id.startsWith(PREFIX);
}

export function makeRemoteModelId(remoteId: string, modelId: string): string {
  return `${PREFIX}${remoteId}/${modelId}`;
}

/**
 * Split `remote:<remoteId>/<bLocalId>` → `{ remoteId, modelId }`. The model id
 * may itself contain `:` and `/` (e.g. `llama-cpp:qwen2.5-72b`) — only the
 * FIRST `/` after the remoteId is the separator. Returns null if not a remote id.
 */
export function parseRemoteModelId(id: string): { remoteId: string; modelId: string } | null {
  if (!isRemoteModelId(id)) return null;
  const rest = id.slice(PREFIX.length);
  const slash = rest.indexOf('/');
  if (slash <= 0 || slash >= rest.length - 1) return null;
  return { remoteId: rest.slice(0, slash), modelId: rest.slice(slash + 1) };
}
