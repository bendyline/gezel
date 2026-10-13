/**
 * EngineKey — the string handle that identifies a local-engine
 * instance in the ProviderPool. Composite: `${provider}:${modelId}:${replicaIdx}`.
 *
 * Cloud providers (copilot, openai, anthropic, anthropic-cli,
 * codex-cli, ollama, mock) are NOT pool-managed — they keep the
 * bare-provider-name keying ChatManager's `cloudProviders` map uses.
 */

export type LocalProviderName = 'llama-cpp' | 'mlx' | 'ds4';

export const LOCAL_PROVIDERS: readonly LocalProviderName[] = ['llama-cpp', 'mlx', 'ds4'] as const;

export function isLocalProvider(name: string): name is LocalProviderName {
  return (LOCAL_PROVIDERS as readonly string[]).includes(name);
}

export interface ParsedEngineKey {
  provider: LocalProviderName;
  modelId: string;
  replicaIdx: number;
}

export function makeEngineKey(
  provider: LocalProviderName,
  modelId: string,
  replicaIdx: number,
): string {
  if (replicaIdx < 0 || !Number.isInteger(replicaIdx)) {
    throw new Error(`invalid replicaIdx: ${replicaIdx}`);
  }
  if (!modelId || modelId.includes(':')) {
    throw new Error(`invalid modelId for engine key: ${JSON.stringify(modelId)}`);
  }
  return `${provider}:${modelId}:${replicaIdx}`;
}

export function parseEngineKey(key: string): ParsedEngineKey | null {
  // Split from the right so a modelId without `:` is unambiguous.
  // (We already reject modelIds containing `:` in makeEngineKey.)
  const lastColon = key.lastIndexOf(':');
  if (lastColon < 0) return null;
  const replicaStr = key.slice(lastColon + 1);
  const replicaIdx = Number.parseInt(replicaStr, 10);
  if (!Number.isInteger(replicaIdx) || String(replicaIdx) !== replicaStr) return null;
  const head = key.slice(0, lastColon);
  const firstColon = head.indexOf(':');
  if (firstColon < 0) return null;
  const provider = head.slice(0, firstColon);
  const modelId = head.slice(firstColon + 1);
  if (!isLocalProvider(provider) || !modelId) return null;
  return { provider, modelId, replicaIdx };
}
