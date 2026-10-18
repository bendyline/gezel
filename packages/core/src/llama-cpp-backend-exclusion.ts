/**
 * Whether a catalog llama.cpp source may run on a given llama-server backend.
 * One owner for the verdict so the download list, the install refusal, the
 * launch refusal and first-run recommendations cannot disagree.
 */

export type LlamaCppBackendName = 'cuda' | 'vulkan' | 'metal' | 'cpu';

export interface LlamaCppBackendExclusionSource {
  excludeBackends?: readonly string[] | undefined;
  excludeReason?: string | undefined;
}

const BACKEND_LABELS: Record<LlamaCppBackendName, string> = {
  cuda: 'NVIDIA (CUDA)',
  vulkan: 'Vulkan',
  metal: 'Apple Metal',
  cpu: 'CPU-only',
};

export function llamaCppBackendLabel(backend: string): string {
  return BACKEND_LABELS[backend as LlamaCppBackendName] ?? backend;
}

/**
 * The reason this source is excluded on `backend`, or null when it may run
 * there. An unknown backend (an external server, a host whose probe has not
 * run) is never excluded: the verdict only refuses what it knows is wrong.
 */
export function llamaCppBackendExclusion(
  source: LlamaCppBackendExclusionSource | null | undefined,
  backend: string | null | undefined,
): string | null {
  if (!source || !backend) return null;
  if (!source.excludeBackends?.includes(backend)) return null;
  return (
    source.excludeReason ??
    `This model is not built for the ${llamaCppBackendLabel(backend)} llama.cpp engine.`
  );
}
