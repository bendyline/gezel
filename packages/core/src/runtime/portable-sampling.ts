import type { PortableSampling } from '../mobile/inference.js';
import type { ChatModelTuning } from '../schemas/model-tuning.js';
import { type ResolvedTuning, resolveTuning } from '../tuning-resolve.js';
import type { PortableCatalogModel } from './content.js';

export interface PortableSamplingInput {
  /** The downloaded model's catalog entry; an imported file has none. */
  catalog?: Pick<PortableCatalogModel, 'tuning' | 'reasoningFormat'> | undefined;
  /** `config.modelTuning[modelId]`. */
  installDefault?: ChatModelTuning | undefined;
  /** The gezel's frontmatter `tuning`. */
  override?: ChatModelTuning | undefined;
  tuningProfileId?: string | undefined;
  installDefaultProfileId?: string | undefined;
  suggestedProfileId?: string | undefined;
}

/**
 * A model's tuning resolved for one phone turn through the layers the desktop
 * uses (gezel override > install default > profile > catalog), or undefined
 * when nothing sets any. Structured chat writes it onto the request exactly as
 * the desktop's llama.cpp session does.
 */
export function portableTuning(input: PortableSamplingInput): ResolvedTuning | undefined {
  if (!input.catalog?.tuning && !input.installDefault && !input.override) return undefined;
  return resolveTuning({
    ...(input.catalog?.tuning ? { catalog: input.catalog.tuning } : {}),
    ...(input.installDefault ? { installDefault: input.installDefault } : {}),
    ...(input.override ? { override: input.override } : {}),
    ...(input.tuningProfileId ? { tuningProfileId: input.tuningProfileId } : {}),
    ...(input.installDefaultProfileId
      ? { installDefaultProfileId: input.installDefaultProfileId }
      : {}),
    ...(input.suggestedProfileId ? { suggestedProfileId: input.suggestedProfileId } : {}),
    ...(input.catalog?.reasoningFormat
      ? { styleReasoningFormat: input.catalog.reasoningFormat }
      : {}),
  });
}

/**
 * The sampling a phone gives its engine for one turn: {@link portableTuning}'s
 * sampling, keeping only fields the native bridge implements, clamped to what
 * it accepts so a catalog value can never fail a turn; the reply-length budget
 * stays the phone's own. With no catalog entry and no override, the engine
 * default stands.
 */
export function portableSampling(input: PortableSamplingInput): PortableSampling | undefined {
  const sampling = portableTuning(input)?.sampling;
  if (!sampling) return undefined;
  const out: PortableSampling = {};
  const within = (value: unknown, min: number, max: number): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
  if (within(sampling.temperature, 0, 2)) out.temperature = sampling.temperature;
  if (within(sampling.topK, 0, 1000)) out.topK = Math.round(sampling.topK);
  if (within(sampling.topP, 0.01, 1)) out.topP = sampling.topP;
  if (within(sampling.minP, 0, 0.99)) out.minP = sampling.minP;
  if (within(sampling.repetitionPenalty, 1, 2)) out.repetitionPenalty = sampling.repetitionPenalty;
  if (within(sampling.repetitionContext, 0, 4096))
    out.repetitionContext = Math.round(sampling.repetitionContext);
  if (typeof sampling.seed === 'number' && Number.isInteger(sampling.seed) && sampling.seed >= 0)
    out.seed = sampling.seed % 2 ** 31;
  return Object.keys(out).length ? out : undefined;
}
