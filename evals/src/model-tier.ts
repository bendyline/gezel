/**
 * Model-tier classification for eval reporting (Theme E / E1-B).
 *
 * Stamps each trial with the capability tier of the model that ran it, so
 * the reporting layer can render tiny-tier cells as raw counts rather than
 * pass-rates (at a ~50% base rate, n=1 at tiny tier is a coin flip). Tier
 * is used ONLY for eval reporting here — never for routing — so a drift
 * from the service breakpoints mis-labels a report row, it does not
 * mis-route a trial.
 *
 * The service owns the runtime classifier
 * (`packages/service/src/chat/local-model-tier.ts`) but its `exports` map
 * is closed to the eval package, so the two `parseBillions*` helpers and
 * the breakpoints below are copied verbatim from it — keep them in sync.
 */

import type { ModelTier } from '@bendyline/gezel';
import { modelParameterSize } from './chat-model-manifest.ts';
import { type ChatProvider, isLocalEngine } from './providers.ts';

// mirrors packages/service/src/chat/local-model-tier.ts:parseBillionsFromModelId
function parseBillionsFromModelId(modelId: string | undefined): number | undefined {
  if (!modelId) return undefined;
  const m = modelId.match(/(?:^|[:_\-/])(e)?(\d+(?:\.\d+)?)b(?![A-Za-z0-9])/i);
  if (!m) return undefined;
  const billions = Number(m[2]);
  return m[1] ? billions * 2 : billions; // Gemma "effective params" → double
}

// mirrors packages/service/src/chat/local-model-tier.ts:parseBillionsFromParameterSize
function parseBillionsFromParameterSize(parameterSize: string | undefined): number | undefined {
  if (!parameterSize) return undefined;
  const match = parameterSize.match(/(\d+(?:\.\d+)?)\s*([BMK]?)/i);
  if (!match) return undefined;
  const num = Number(match[1]);
  if (!Number.isFinite(num)) return undefined;
  const unit = (match[2] ?? 'B').toUpperCase();
  if (unit === 'M') return num / 1000;
  if (unit === 'K') return num / 1_000_000;
  return num;
}

/**
 * Resolve the model's total parameter count for eval launch sizing.
 *
 * Catalog metadata is authoritative when present; the model id remains a
 * fallback for hand-installed and synthetic models. Keeping this resolution
 * beside tier classification prevents launch safeguards from growing a list
 * of exact size tags that misses newly cataloged models such as 122B.
 */
export function modelBillionsForEval(modelId: string): number | undefined {
  return (
    parseBillionsFromParameterSize(modelParameterSize(modelId)) ?? parseBillionsFromModelId(modelId)
  );
}

/**
 * Classify the trial's model into a capability tier. Non-local engines
 * (cloud-sdk / cli-wrapper) → `cloud`. Local engines resolve size from the
 * catalog `parameterSize` (authoritative for tag-silent ids like
 * `qwen3.6`), falling back to the model id; unknown size → `tiny`.
 * Breakpoints mirror the service: `<5→tiny, <12→small, <45→medium,
 * else large`.
 */
export function classifyEvalModelTier(args: {
  engine: ChatProvider;
  modelId: string;
}): ModelTier {
  if (!isLocalEngine(args.engine)) return 'cloud';
  const billions = modelBillionsForEval(args.modelId);
  if (billions === undefined) return 'tiny';
  if (billions < 5) return 'tiny';
  if (billions < 12) return 'small';
  if (billions < 45) return 'medium';
  return 'large';
}
