/**
 * Which speculative decoding a catalog entry asks for on a given llama-server
 * backend. One owner, so the download list, the "update available" check, the
 * memory plan and the launch cannot disagree about whether a drafter is in use.
 *
 * Speculation is measured per backend, not per model: a DFlash2 drafter that
 * gains 1.8x on CUDA is reported at about 1.1x on ROCm, and halves prefill on
 * Vulkan for at least one model. A catalog entry therefore turns a drafter on
 * for the backends it was tested on and leaves every other backend alone.
 */

export interface LlamaCppSpecOverlay {
  type?: string | undefined;
  nMax?: number | undefined;
  sampling?: 'greedy' | 'probabilistic' | undefined;
}

export interface LlamaCppSpecBlock extends LlamaCppSpecOverlay {
  mtp?: boolean | undefined;
  draftModelId?: string | undefined;
  byBackend?: Partial<Record<string, LlamaCppSpecOverlay | undefined>> | undefined;
}

/**
 * The spec block as it applies on `backend`, without its `byBackend` table.
 * An unknown backend (an external server, a host whose probe has not run) gets
 * the base block: the overlay is a claim about a tested backend, and nothing
 * is known about this one.
 */
export function llamaCppSpecForBackend<T extends LlamaCppSpecBlock>(
  spec: T | undefined,
  backend: string | null | undefined,
): Omit<T, 'byBackend'> | undefined {
  if (!spec) return undefined;
  const { byBackend, ...base } = spec;
  const overlay = backend ? byBackend?.[backend] : undefined;
  if (!overlay) return base;
  const defined = Object.fromEntries(
    Object.entries(overlay).filter(([, value]) => value !== undefined),
  );
  return { ...base, ...defined };
}

/** Spec types that load a separate GGUF through `--spec-draft-model`. */
export function llamaCppSpecNeedsDraftModel(type: string | null | undefined): boolean {
  return type === 'draft-simple' || type === 'draft-dflash' || type === 'draft-eagle3';
}

/**
 * Whether a catalog drafter belongs in this install. A drafter limited to some
 * backends is skipped on the rest, and on an unknown backend, where the launch
 * would fall back to the base spec anyway.
 */
export function llamaCppDraftModelApplies(
  draftModel: { backends?: readonly string[] | undefined } | null | undefined,
  backend: string | null | undefined,
): boolean {
  if (!draftModel) return false;
  if (!draftModel.backends) return true;
  return !!backend && draftModel.backends.includes(backend);
}

/**
 * The catalog's measured cost for the drafter installed at `installedPath`.
 * Undefined when the catalog has moved on to another file, which the install
 * has not fetched yet: that figure describes a different drafter.
 */
export function llamaCppDraftResidentBytes(
  draftModel: { filename: string; residentBytes?: number | undefined } | null | undefined,
  installedPath: string | null | undefined,
): number | undefined {
  if (!draftModel?.residentBytes || !installedPath) return undefined;
  const name = (path: string) => path.split(/[\\/]/).pop();
  return name(draftModel.filename) === name(installedPath) ? draftModel.residentBytes : undefined;
}
