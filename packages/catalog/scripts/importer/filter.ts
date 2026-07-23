import type { NormalizedRegistryServer, RegistryPackage, RegistryServer } from './types.js';

/**
 * Outcome of pre-mapping filtering. The importer only ever drops
 * entries with no shot at producing a catalog manifest — license and
 * sha256 issues happen later because they require network calls.
 */
export type FilterDecision =
  | { kind: 'keep' }
  | { kind: 'drop'; reason: 'status-deleted' | 'no-runnable-package'; detail: string };

const SUPPORTED_REGISTRY_TYPES = new Set<string>(['npm']);
const SUPPORTED_TRANSPORT_TYPES = new Set<string>(['stdio']);

/**
 * Pick the first runnable npm/stdio package from a registry entry.
 * Returns null when no package matches — callers decide whether
 * `remotes[]` is an acceptable fallback.
 */
export function pickNpmStdioPackage(server: RegistryServer): RegistryPackage | null {
  if (!server.packages) return null;
  for (const pkg of server.packages) {
    if (!SUPPORTED_REGISTRY_TYPES.has(pkg.registryType)) continue;
    const transportType = pkg.transport?.type ?? 'stdio';
    if (!SUPPORTED_TRANSPORT_TYPES.has(transportType)) continue;
    if (!pkg.identifier || !pkg.version) continue;
    return pkg;
  }
  return null;
}

export function hasUsableRemote(server: RegistryServer): boolean {
  return Array.isArray(server.remotes) && server.remotes.length > 0 && !!server.remotes[0]?.url;
}

/**
 * Apply the cheap, no-network filters: status and shape. License /
 * sha256 / repository validity are decided later in the pipeline.
 */
export function classify(server: NormalizedRegistryServer): FilterDecision {
  const status = server.official?.status ?? 'active';
  if (status === 'deleted') {
    return { kind: 'drop', reason: 'status-deleted', detail: `status=${status}` };
  }
  if (pickNpmStdioPackage(server)) return { kind: 'keep' };
  if (hasUsableRemote(server)) return { kind: 'keep' };
  return {
    kind: 'drop',
    reason: 'no-runnable-package',
    detail: 'no npm/stdio package and no remotes[] entry',
  };
}

/**
 * True when the upstream marks this entry as deprecated (but not
 * deleted). Mapper passes this through so writer can record the
 * version in `yankedVersions`.
 */
export function isDeprecated(server: NormalizedRegistryServer): boolean {
  return server.official?.status === 'deprecated';
}
