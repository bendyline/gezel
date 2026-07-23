/**
 * Capability tier for chat models — the canonical taxonomy that scales
 * prompt verbosity, schema relaxation, and tool-allowlist filtering to
 * what the model can actually handle.
 *
 *   tiny    < 5B            Gemma 4 E2B, Llama 3.2 1B/3B,
 *                           Qwen 3.5 2B/4B. Needs the full cookbook +
 *                           schema relaxation + arg defaulting.
 *   small   5–11.99B        Llama 8B, Mistral 7B, Qwen 3.5 9B, DeepSeek
 *                           R1 8B, Gemma 4 E4B (~8B total params despite
 *                           the "E4B" effective-active label).
 *                           Condensed anti-fabrication rules only; no
 *                           schema relaxation.
 *   medium  12–44.99B       Mixtral / Qwen 27B / Gemma 31B / GPT-OSS
 *                           20B. Frontier-style strict surface, no
 *                           localHints tax.
 *   large   ≥45B (local)    Llama 70B+, DeepSeek V3 (when run on
 *                           sufficient local VRAM). The high end of
 *                           what an enthusiast can run locally.
 *   cloud   any cloud       gpt-4o / claude-opus / Copilot / etc. —
 *           provider        effectively running on >512GB of GPU
 *                           memory we don't pay for. Today
 *                           behaviorally identical to `large`, but
 *                           kept distinct so cloud-only behaviors
 *                           (provider-specific tool formats,
 *                           cost-aware scheduling, etc.) can branch
 *                           on it without conflating with a 70B
 *                           local.
 *
 * Tier breakpoints chosen empirically: the daily-driver Gemma 4 E4B
 * lives in `small` (its ~8B total params behave like a small model,
 * even though the "E4B" tag advertises 4B effective-active);
 * popular 7-9B locals in `small`; modern flagship locals (Qwen 27B,
 * Gemma 31B) in `medium`; Llama 70B class in `large`. Cloud is its
 * own bucket.
 *
 * Unknown size on a LOCAL provider → `tiny` (conservative — better to
 * apply the cookbook and waste a few hundred tokens than miss a real
 * tool-use regression on a small model whose tag we couldn't parse).
 *
 * The type name was `LocalModelTier` historically (when cloud → 'capable'
 * collapsed it into the local taxonomy). Renamed to `ModelTier` once
 * cloud got its own bucket — the classification covers every model,
 * not just locals.
 */

import type { ModelTier, ProviderName } from '@bendyline/gezel';
import { MODEL_TIER_ORDER, createLogger, isLocalProvider } from '@bendyline/gezel';

const log = createLogger('chat');

/**
 * The tier union is now declared canonically in `@bendyline/gezel`
 * (packages/core/src/roles/tier.ts) so core-level role declarations can
 * reference a `capabilityFloor` without depending on the service. Re-
 * exported here under the same name; this module still owns the
 * model→tier *classification* below.
 */
export type { ModelTier };

/**
 * Backwards-compatible alias. New code should import `ModelTier`.
 * Keeping the old name exported so downstream imports don't break in
 * the same patch that adds the `cloud` bucket.
 */
export type LocalModelTier = ModelTier;

/**
 * Parse a parameter-count hint out of a model id.
 *
 *   qwen3.5:9b       → 9
 *   gemma4:e4b       → 8       (MatFormer "effective 4B active"; ~8B total)
 *   llama3.2:3b      → 3
 *   deepseek-r1:8b   → 8
 *   gemma4-e4b-mlx   → 8       (mlx repo naming, same MatFormer doubling)
 *   gemma4-e2b-mlx   → 4       (E2B has ~5B total, rounded down by the 2x rule)
 *   meta-llama/Llama-3-70B → 70
 *   model_8b_q4      → 8
 *   qwen3.6          → undefined (no size in tag)
 *   gpt-4o           → undefined (no size in id)
 *
 * The Gemma `e<N>b` "effective" notation is doubled because Gemma 3n's
 * MatFormer architecture loads the full model into memory even though
 * only N billion params are activated at inference. The actual file on
 * disk reflects the total, not the effective count — Q8_0 E4B is ~8GB,
 * consistent with ~8B params. Doubling lands E4B in `small` (where its
 * behavior actually lives) instead of `tiny`. E2B stays in `tiny` (4
 * still < 5B threshold) which matches how it actually performs.
 *
 * Returns undefined when the tag has no parseable size hint. Callers
 * that need to default-to-conservative on unknown size should treat
 * undefined → tiny tier (see {@link classifyModelTier}).
 *
 * Tag-only parsing is a fallback. When a `parameterSize` string is
 * available (catalog manifest, ollama `details.parameter_size`), prefer
 * {@link parseBillionsFromParameterSize} — it's authoritative for any
 * model whose tag drops the size suffix (e.g. `qwen3.6` is 27B but the
 * tag never says so).
 */
export function parseBillionsFromModelId(modelId: string | undefined): number | undefined {
  if (!modelId) return undefined;
  // Match `<sep><optional 'e'><N>b` boundaries so we catch:
  //   - ollama-style:   `llama3.1:8b`, `qwen2.5:7b`, `gemma4:e4b`
  //   - mlx-style:      `gemma4-e4b-mlx`, `gemma4-e2b-mlx`
  //   - hf-style:       `meta-llama/Llama-3-70B`, `mistralai/Mistral-7B-v0.1`
  //   - underscore:     `model_8b_q4`
  // The leading 'e' covers Gemma's "effective parameters" notation and
  // is captured so we can double it (see docblock).
  // Trailing terminator is `(?![A-Za-z0-9])` rather than `\b` so an
  // underscore after the size suffix still ends the match — `\b`
  // wouldn't fire on `b_` because both `b` and `_` are word chars.
  const m = modelId.match(/(?:^|[:_\-/])(e)?(\d+(?:\.\d+)?)b(?![A-Za-z0-9])/i);
  if (!m) return undefined;
  const billions = Number(m[2]);
  return m[1] ? billions * 2 : billions;
}

/**
 * Parse a billions count out of a `parameterSize` string in the form
 * the catalog manifests and Ollama's API use:
 *
 *   "27B"    → 27
 *   "30.7B"  → 30.7
 *   "2.3B"   → 2.3
 *   "9B"     → 9
 *   "500M"   → 0.5
 *   "9b"     → 9       (case-insensitive)
 *
 * Returns undefined for empty / unparseable strings. Authoritative
 * source for {@link classifyModelTier} when available — the tag-based
 * fallback {@link parseBillionsFromModelId} can't see sizes that aren't
 * encoded in the model id (e.g. `qwen3.6` is 27B but the tag is silent).
 */
export function parseBillionsFromParameterSize(
  parameterSize: string | undefined,
): number | undefined {
  if (!parameterSize) return undefined;
  const match = parameterSize.match(/(\d+(?:\.\d+)?)\s*([BMK]?)/i);
  if (!match) return undefined;
  const num = Number(match[1]);
  if (!Number.isFinite(num)) return undefined;
  const unit = (match[2] ?? 'B').toUpperCase();
  if (unit === 'B') return num;
  if (unit === 'M') return num / 1000;
  if (unit === 'K') return num / 1_000_000;
  return num;
}

/**
 * Classify a model into a capability tier. See module docblock for the
 * tier definitions and rationale.
 *
 * Size resolution preference: explicit `parameterSize` (from the
 * catalog manifest or the provider's own metadata) wins over tag
 * parsing. This matters for any catalog model whose tag drops the
 * size suffix — e.g. `qwen3.6` (27B) classifies as `medium` when the
 * caller forwards `parameterSize: "27B"`, but as `tiny` when only the
 * bare tag is available. Callers that don't have a parameterSize
 * handy may pass undefined and get conservative tag-only behavior.
 */
let forcedTierWarned = false;

export function classifyModelTier(args: {
  providerName: ProviderName;
  modelId: string | undefined;
  parameterSize?: string | undefined;
}): ModelTier {
  // Dev/test seam: force every local classification to one tier so the
  // whole tier-conditioned stack (collapse, kits, caps, hints) can be
  // exercised without installing a model of that size. Loud on first
  // use — this must never be on in normal operation.
  const forced = process.env.GEZEL_FORCE_MODEL_TIER;
  if (forced && (MODEL_TIER_ORDER as readonly string[]).includes(forced)) {
    if (!forcedTierWarned) {
      forcedTierWarned = true;
      log.warn(`GEZEL_FORCE_MODEL_TIER=${forced} — overriding every local tier classification`);
    }
    if (isLocalProvider(args.providerName)) return forced as ModelTier;
  }
  if (!isLocalProvider(args.providerName)) return 'cloud';
  const billions =
    parseBillionsFromParameterSize(args.parameterSize) ?? parseBillionsFromModelId(args.modelId);
  if (billions === undefined) return 'tiny';
  if (billions < 5) return 'tiny';
  if (billions < 12) return 'small';
  if (billions < 45) return 'medium';
  return 'large';
}

/**
 * Backwards-compatible alias. New code should call `classifyModelTier`.
 */
export const classifyLocalModelTier = classifyModelTier;
