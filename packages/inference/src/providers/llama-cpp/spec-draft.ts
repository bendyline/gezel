/**
 * Speculative-decoding draft resolution, extracted from the chat/manager
 * launcher so it can be unit-tested in isolation.
 *
 * A catalog entry can ask for a separate draft GGUF two ways: a `draftModel`
 * sidecar installed beside the weights, or a `spec.draftModelId` naming another
 * catalog model. engine-flags passes `--spec-draft-model` verbatim, and a draft
 * algorithm with no draft model is a FATAL llama-server launch, so this has to
 * be settled BEFORE the argv is built. This module owns that decision, and
 * applies the catalog's per-backend overlay first so everything downstream of
 * it reads one spec:
 *
 *   - global `config.llamaCppDraftModelPath` set → operator's own path wins,
 *     nothing to resolve.
 *   - sidecar installed → use it.
 *   - manifest draft id resolves to an installed path → rewrite `draftModelId`
 *     to that path.
 *   - manifest-driven spec with no draft on disk → fall back so the launch
 *     decodes the way it would without the drafter instead of crashing. A live
 *     Gilde update reaches this: the new manifest takes effect at once, and the
 *     drafter arrives only when the person updates the model. The +decode win
 *     is opportunistic on the draft being present, never a hard dependency.
 *   - operator explicitly forced a draft `config.llamaCppSpecType` but no draft
 *     path resolves → leave it and warn; the operator owns it.
 */
import { llamaCppSpecForBackend, llamaCppSpecNeedsDraftModel } from '@bendyline/gezel';
import type { PerModelLlamaCppEngineConfig } from './engine-flags.js';

export interface SpecDraftResolveInput {
  /** The catalog manifest's `tuning.engine.llamaCpp` block, if any. */
  perModel: PerModelLlamaCppEngineConfig | undefined;
  /** The llama-server build's backend, for the manifest's `spec.byBackend`. */
  backend?: string | undefined;
  /** Global `config.llamaCppSpecType`, if the operator set one. */
  configSpecType?: string | undefined;
  /** Global `config.llamaCppDraftModelPath`, if the operator set one. */
  configDraftModelPath?: string | undefined;
  /** The catalog `draftModel` sidecar on disk beside the weights, if any. */
  installedDraftModelPath?: string | undefined;
  /** Resolve a catalog draft id → installed GGUF path (null if not installed). */
  resolveDraftPath: (id: string) => Promise<string | null>;
}

/**
 * Whether the sidecar beside the weights is what this launch loads. A separate
 * MTP assistant loads whenever MTP runs. A DFlash drafter sits beside a target
 * that may have its own head, or on a backend its catalog entry did not turn it
 * on for; handing it to MTP through `--spec-draft-model` would load the wrong
 * file. `perBackend` is the manifest carrying a `spec.byBackend` table.
 */
export function llamaCppSidecarLoads(input: {
  specType: string | undefined;
  targetHasMtp: boolean;
  perBackend: boolean;
}): boolean {
  const { specType, targetHasMtp, perBackend } = input;
  if (llamaCppSpecNeedsDraftModel(specType)) return true;
  if (specType && specType !== 'draft-mtp') return false;
  return !targetHasMtp && !perBackend;
}

/**
 * Engine and drafter pairs that took an engine down, so a later launch in this
 * daemon goes without instead of failing the same way first. Keyed by both,
 * because a drafter that one engine build cannot load may suit the next.
 */
export const brokenDrafters = new Set<string>();

/** The parts of a KV plan a drafter must not change. */
export interface DrafterKvPlan {
  kvCacheType: string;
  ctxCapTokens?: number | undefined;
}

/**
 * Whether a drafter would cost the session something it runs out of. The
 * target window and KV precision outlast a faster decode: a drafter that
 * makes the plan cap the target, drop to a coarser KV cache, or stop fitting
 * at all is left out. Adaptive growth above the target and slots pay for it,
 * as they do for every resident cost.
 */
export function drafterCostsContext(
  withDrafter: DrafterKvPlan,
  withoutDrafter: DrafterKvPlan,
  fitsWithDrafter: boolean,
): boolean {
  return (
    !fitsWithDrafter ||
    withDrafter.kvCacheType !== withoutDrafter.kvCacheType ||
    withDrafter.ctxCapTokens !== withoutDrafter.ctxCapTokens
  );
}

/**
 * Whether a drafter would push the launch past the graphics memory it has.
 * `gpuPoolBytes` is what a discrete card leaves this launch now (free memory
 * as device admission measures it, within the card's usable share), and
 * undefined elsewhere. Checked against the card's total alone, a drafter
 * stayed while admission refused the model it was meant to speed up: the
 * 74B Bolt and the 27B on a 32 GB card beside a desktop holding 6.5 GB, both
 * of which start without it (2026-11-07).
 */
export function drafterCostsGpuResidency(
  withDrafterBytes: number,
  gpuPoolBytes: number | undefined,
): boolean {
  return gpuPoolBytes !== undefined && withDrafterBytes > gpuPoolBytes;
}

export interface SpecDraftResolution {
  /** The perModel to hand to `buildLlamaCppEngineArgs` (spec rewritten or stripped). */
  perModel: PerModelLlamaCppEngineConfig | undefined;
  /** A log line to emit, or null. */
  log: { level: 'info' | 'warn'; message: string } | null;
}

/** The base spec with no overlay, or `perModel` with no spec at all. */
function withoutOverlay(
  perModel: PerModelLlamaCppEngineConfig,
): PerModelLlamaCppEngineConfig | undefined {
  const base = llamaCppSpecForBackend(perModel.spec, undefined);
  return base ? { ...perModel, spec: base } : perModel;
}

function withoutSpec(perModel: PerModelLlamaCppEngineConfig): PerModelLlamaCppEngineConfig {
  const { spec: _spec, ...rest } = perModel;
  return rest;
}

export async function resolveSpecDraft(input: SpecDraftResolveInput): Promise<SpecDraftResolution> {
  const { perModel, backend, configSpecType, configDraftModelPath } = input;
  const { installedDraftModelPath, resolveDraftPath } = input;
  if (!perModel?.spec) return { perModel, log: null };

  const overlay = backend ? perModel.spec.byBackend?.[backend] : undefined;
  // A person who forced another algorithm has not asked for this overlay's
  // tuning: MTP must not inherit a sampling mode chosen for a drafter.
  const overlayStands = !configSpecType || !overlay?.type || overlay.type === configSpecType;
  const spec = llamaCppSpecForBackend(perModel.spec, overlayStands ? backend : undefined);
  const applied = perModel.spec.byBackend ? { ...perModel, spec } : perModel;

  const effectiveSpecType = configSpecType ?? spec?.type;
  if (
    !llamaCppSpecNeedsDraftModel(effectiveSpecType) ||
    configDraftModelPath ||
    installedDraftModelPath
  ) {
    return { perModel: applied, log: null };
  }

  const draftId = spec?.draftModelId;
  const draftPath = draftId ? await resolveDraftPath(draftId).catch(() => null) : null;
  if (draftPath && spec) {
    return {
      perModel: { ...applied, spec: { ...spec, draftModelId: draftPath } },
      log: {
        level: 'info',
        message: `[llama-cpp] speculative decoding: draft "${draftId}" → ${draftPath}`,
      },
    };
  }

  const name = draftId ? `"${draftId}"` : 'sidecar';
  if (configSpecType) {
    // Operator forced the spec type via global config but gave no resolvable
    // draft — leave it and let llama-server surface the error rather than
    // silently overriding an explicit request.
    return {
      perModel: applied,
      log: {
        level: 'warn',
        message: `[llama-cpp] config.llamaCppSpecType=${configSpecType} but draft ${name} is not installed and no llamaCppDraftModelPath is set; the launch may fail.`,
      },
    };
  }

  // Manifest-driven spec, draft absent → the overlay's base if that decodes
  // without one, else no spec at all.
  const base = overlay ? withoutOverlay(perModel) : undefined;
  const fallback =
    base && !llamaCppSpecNeedsDraftModel(base.spec?.type) ? base : withoutSpec(perModel);
  return {
    perModel: fallback,
    log: {
      level: 'info',
      message: `[llama-cpp] speculative decoding (manifest draft ${name}) skipped: draft model not installed; running without it.`,
    },
  };
}
