/**
 * Speculative-decoding draft resolution, extracted from the chat/manager
 * launcher so it can be unit-tested in isolation.
 *
 * A model manifest names its `draft-simple` draft by CATALOG id
 * (`spec.draftModelId`) so it stays portable across installs — a user's GGUF
 * path differs from any hardcoded one. But engine-flags passes
 * `--spec-draft-model` verbatim and a `draft-simple` spec with no draft model
 * is a FATAL llama-server launch, so the id must be resolved to the installed
 * GGUF path (or the spec disabled) BEFORE the argv is built. This module owns
 * exactly that decision:
 *
 *   - global `config.llamaCppDraftModelPath` set → operator's own path wins,
 *     nothing to resolve.
 *   - manifest draft resolves to an installed path → rewrite `draftModelId`
 *     to that path.
 *   - manifest-driven spec whose draft isn't installed → STRIP the spec so
 *     the launch falls back to plain decoding instead of crashing. The
 *     +decode win is opportunistic on the draft being present, never a hard
 *     dependency.
 *   - operator explicitly forced `config.llamaCppSpecType=draft-simple` but
 *     no draft path resolves → leave it and warn; the operator owns it.
 */
import type { PerModelLlamaCppEngineConfig } from './engine-flags.js';

export interface SpecDraftResolveInput {
  /** The catalog manifest's `tuning.engine.llamaCpp` block, if any. */
  perModel: PerModelLlamaCppEngineConfig | undefined;
  /** Global `config.llamaCppSpecType`, if the operator set one. */
  configSpecType?: string | undefined;
  /** Global `config.llamaCppDraftModelPath`, if the operator set one. */
  configDraftModelPath?: string | undefined;
  /** Resolve a catalog draft id → installed GGUF path (null if not installed). */
  resolveDraftPath: (id: string) => Promise<string | null>;
}

export interface SpecDraftResolution {
  /** The perModel to hand to `buildLlamaCppEngineArgs` (spec rewritten or stripped). */
  perModel: PerModelLlamaCppEngineConfig | undefined;
  /** A log line to emit, or null. */
  log: { level: 'info' | 'warn'; message: string } | null;
}

export async function resolveSpecDraft(input: SpecDraftResolveInput): Promise<SpecDraftResolution> {
  const { perModel, configSpecType, configDraftModelPath, resolveDraftPath } = input;
  const effectiveSpecType = configSpecType ?? perModel?.spec?.type;
  // Only the manifest-draftModelId path needs resolving. An explicit global
  // draft path, a non-draft-simple spec, or no draft id → nothing to do.
  if (
    effectiveSpecType !== 'draft-simple' ||
    !perModel?.spec?.draftModelId ||
    configDraftModelPath
  ) {
    return { perModel, log: null };
  }
  const draftId = perModel.spec.draftModelId;
  const draftPath = await resolveDraftPath(draftId).catch(() => null);
  if (draftPath) {
    return {
      perModel: { ...perModel, spec: { ...perModel.spec, draftModelId: draftPath } },
      log: {
        level: 'info',
        message: `[llama-cpp] speculative decoding: draft "${draftId}" → ${draftPath}`,
      },
    };
  }
  if (!configSpecType) {
    // Manifest-driven spec, draft absent → strip so we don't fatal-launch a
    // draft-simple with no draft model.
    const { spec: _spec, ...rest } = perModel;
    return {
      perModel: rest,
      log: {
        level: 'info',
        message: `[llama-cpp] speculative decoding (manifest draft "${draftId}") skipped: draft model not installed; running without it.`,
      },
    };
  }
  // Operator forced the spec type via global config but gave no resolvable
  // draft — leave it and let llama-server surface the error rather than
  // silently overriding an explicit request.
  return {
    perModel,
    log: {
      level: 'warn',
      message: `[llama-cpp] config.llamaCppSpecType=draft-simple but draft "${draftId}" is not installed and no llamaCppDraftModelPath is set; the launch may fail.`,
    },
  };
}
