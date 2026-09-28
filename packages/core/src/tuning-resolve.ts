/**
 * Resolve a model's per-turn sampling / reasoning / structured-output tuning
 * from its layers: per-gezel override > install default > profile > catalog.
 *
 * Pure, so the desktop daemon and the portable (phone) runtime resolve a
 * model the same way. The phone runtime once kept its own path and passed no
 * sampling at all, so every phone reply was greedy whatever the catalog said
 * (2026-09-27). Provider request mapping stays in the service
 * (model-profile/tuning.ts `applyTuning`).
 */

import type { ChatModelTuning, SamplingBlock } from './schemas/model-tuning.js';
import {
  DEFAULT_TUNING_PROFILE_ID,
  profileKind,
  resolveProfileChain,
} from './schemas/tuning-profile-registry.js';

/**
 * Sampling fields after sampling + samplingWhenThinking are merged. The
 * `wasThinking` flag is for diagnostic logging only — provider request
 * builders don't care.
 */
export interface ResolvedTuning {
  sampling: SamplingBlock;
  reasoning: NonNullable<ChatModelTuning['reasoning']>;
  output: NonNullable<ChatModelTuning['output']>;
  toolChoice?: NonNullable<ChatModelTuning['toolChoice']>;
  promptTags: NonNullable<ChatModelTuning['promptTags']>;
  /** True when `samplingWhenThinking` was merged in. Diagnostic only. */
  wasThinking: boolean;
  /**
   * The tuning profile id the resolver actually applied, after walking the
   * canonical fallback chain. Undefined when no profile was requested, the
   * requested id wasn't canonical, or the chain found no match in the
   * model's `tuning.profiles`. Diagnostic only — surfaced in the
   * TuningPanel UI chip and in debug bundles.
   */
  resolvedTuningProfile?: string;
}

/**
 * Deep merge for sparse partials. Right-hand wins per leaf. Nested objects
 * (e.g. `sampling`, `reasoning`) merge recursively; primitives and arrays
 * replace.
 */
function deepMerge<T extends Record<string, unknown>>(a: T, b: Partial<T>): T {
  const out: Record<string, unknown> = { ...a };
  for (const [key, value] of Object.entries(b)) {
    if (value === undefined) continue;
    const existing = out[key];
    if (
      existing &&
      typeof existing === 'object' &&
      !Array.isArray(existing) &&
      value &&
      typeof value === 'object' &&
      !Array.isArray(value)
    ) {
      out[key] = deepMerge(existing as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      out[key] = value;
    }
  }
  return out as T;
}

/**
 * Merge a stack of sparse `ChatModelTuning` partials, highest-priority first.
 * Lower entries fill in fields the higher entries didn't set.
 */
function mergeTuningStack(layers: Array<ChatModelTuning | undefined>): ChatModelTuning {
  let out: ChatModelTuning = {};
  // Walk lowest-priority-first so deep-merge's "right wins" lands the
  // highest layer last.
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i];
    if (layer) out = deepMerge(out, layer);
  }
  return out;
}

/**
 * Decide whether the current turn should fold `samplingWhenThinking` on
 * top of `sampling`. True when ANY of:
 *  - The merged tuning explicitly sets `reasoning.enableThinking === true`.
 *  - The gezel has a configured `reasoningEffort` AND the model's
 *    `style.reasoningFormat` is anything other than `'none'` (i.e. the
 *    model actually has a thinking mode).
 *  - The latest user prompt contains the `enableThinkingTag` from the
 *    catalog's `promptTags` (e.g. Qwen's `/think`), and not the
 *    `disableThinkingTag`.
 *
 * Returns `false` when none apply or when the model is in `style.reasoningFormat: 'none'`.
 */
export function isReasoningEngaged(opts: {
  tuning: ChatModelTuning;
  styleReasoningFormat?: 'think' | 'channel' | 'inline' | 'none';
  reasoningEffort?: string;
  latestUserPrompt?: string;
}): boolean {
  const { tuning, styleReasoningFormat, reasoningEffort, latestUserPrompt } = opts;
  if (styleReasoningFormat === 'none') return false;
  if (tuning.reasoning?.enableThinking === true) return true;
  if (tuning.reasoning?.enableThinking === false) return false;
  if (reasoningEffort && styleReasoningFormat) return true;
  const tags = tuning.promptTags;
  if (tags && latestUserPrompt) {
    if (tags.disableThinkingTag && latestUserPrompt.includes(tags.disableThinkingTag)) return false;
    if (tags.enableThinkingTag && latestUserPrompt.includes(tags.enableThinkingTag)) return true;
  }
  return false;
}

export interface ResolveTuningInput {
  /** Catalog identity tuning, if any (typically from `ChatModelManifest.tuning`). */
  catalog?: ChatModelTuning;
  /**
   * Install-wide per-model override (from `GezelConfig.modelTuning[<modelId>]`).
   * Sits BETWEEN the gezel override and the catalog default in the
   * resolution stack — the user's "I want this on every gezel that
   * uses Gemma 4" knob, without having to fork the catalog.
   */
  installDefault?: ChatModelTuning;
  /** Per-gezel override (from gezel frontmatter `tuning`). */
  override?: ChatModelTuning;
  /**
   * Named tuning profile the gezel selected (frontmatter `tuningProfile`).
   * The resolver looks it up in `catalog.profiles`, walks the canonical
   * fallback chain if absent, and inserts the matched profile as a layer
   * between `installDefault` and `catalog` base. Unknown / unresolved ids
   * are silently ignored — base tuning still applies.
   */
  tuningProfileId?: string;
  /**
   * Install-wide default profile (from `GezelConfig.modelTuningProfile[<modelId>]`).
   * Only consulted when `tuningProfileId` is absent — the per-gezel pick
   * always wins. Same resolution: looked up in `catalog.profiles` with
   * canonical-chain fallback; unmatched ids fall through to base tuning.
   */
  installDefaultProfileId?: string;
  /**
   * Role/template-suggested profile (from gezel frontmatter
   * `suggestedTuningProfile`, populated by the gilde template). A soft
   * default consulted ONLY when the user hasn't expressed a preference —
   * i.e. neither the per-gezel `tuningProfileId` nor the install
   * `installDefaultProfileId` is set. Sits above the app-wide
   * `DEFAULT_TUNING_PROFILE_ID` fallback. Lets a role default to a
   * sensible profile (coordinators → `thinking-precise`) while staying
   * fully overridable. Same lookup: resolved against `catalog.profiles`
   * with canonical-chain fallback; unmatched ids fall through to base.
   */
  suggestedProfileId?: string;
  /** Style reasoning format for the active model — used to gate `samplingWhenThinking`. */
  styleReasoningFormat?: 'think' | 'channel' | 'inline' | 'none';
  /** Gezel-configured reasoning effort, if any. */
  reasoningEffort?: string;
  /** Latest user-prompt text (used for `/think` / `/no_think` tag detection). */
  latestUserPrompt?: string;
}

/**
 * Build the request-time tuning for a turn. Walks the resolution stack
 *
 *   override  >  installDefault  >  profile  >  catalog
 *
 * where `profile` is the catalog-declared preset (e.g. `thinking-coding`)
 * the gezel selected via `tuningProfile`, resolved against the model's
 * `tuning.profiles` map with canonical-chain fallback. The profile layer
 * is omitted when no id was requested, the requested id isn't canonical,
 * or no fallback matches what the model implements.
 *
 * Decides thinking-vs-not and folds `samplingWhenThinking` in when
 * applicable — UNLESS the active profile is `kind: 'thinking'`, in which
 * case the profile's sampling already carries the right thinking values
 * and folding the legacy overlay on top would double-apply.
 */
export function resolveTuning(input: ResolveTuningInput): ResolvedTuning {
  const catalogProfiles = input.catalog?.profiles ?? {};
  // Precedence (first set wins):
  //   1. per-gezel pick (`tuningProfileId`) — explicit user choice
  //   2. install-wide preset (`installDefaultProfileId`) — explicit user choice
  //   3. role/template suggestion (`suggestedProfileId`) — soft default the
  //      gilde template declares; used only when the user hasn't picked
  //   4. app-wide default (`thinking-general`) — final fallback
  // All go through the same canonical fallback chain against the model's
  // declared profiles, so a model that doesn't implement the chosen id
  // falls through to its base tuning rather than being forced into a mode
  // it can't do.
  const requestedProfileId =
    input.tuningProfileId ??
    input.installDefaultProfileId ??
    input.suggestedProfileId ??
    DEFAULT_TUNING_PROFILE_ID;
  const resolvedProfileId = resolveProfileChain(requestedProfileId, Object.keys(catalogProfiles));
  const profileLayer: ChatModelTuning | undefined = resolvedProfileId
    ? (catalogProfiles[resolvedProfileId] as ChatModelTuning | undefined)
    : undefined;

  const merged = mergeTuningStack([
    input.override,
    input.installDefault,
    profileLayer,
    input.catalog,
  ]);
  // A THINKING profile must not lower the output ceiling below what the
  // model's own base tuning declares.
  //
  // A thinking profile spends part of its budget on reasoning BEFORE the
  // answer, so its ceiling has to cover reasoning plus the payload. Every
  // token the profile shaves off comes out of the deliverable. Yet 33
  // shipped manifests author `thinking-precise` *below* their base
  // (qwen3.8-27b: 6144 vs 12288; gemma4-26b: 4096 vs 8192) — and
  // `thinking-precise` is exactly what the Reviewer and Meester roles
  // select, the two that write the largest structured artifacts.
  //
  // Wild-caught on gezel/49: a Reviewer on qwen3.8-27b-q4 (262K context,
  // provider default cap 16384) ran at 6144 because of the profile, was
  // cut mid-`write_artifact`, and the turn ended after 62 minutes with an
  // empty reply. Raising a ceiling costs nothing on turns that stop early
  // — runaways are bounded by ramble detection and the tool-loop cap, not
  // by this number.
  //
  // Instruct-kind profiles are left alone: for `terse` ("short replies;
  // limited tokens") and `instruct`, a smaller ceiling IS the behavior
  // being selected, not an accident. An explicit per-gezel override or
  // install-wide preset is a deliberate user choice and still wins in
  // both directions.
  const explicitMaxTokens =
    input.override?.sampling?.maxTokens ?? input.installDefault?.sampling?.maxTokens;
  const catalogMaxTokens = input.catalog?.sampling?.maxTokens;
  const profileMaxTokens = profileLayer?.sampling?.maxTokens;
  if (
    profileKind(resolvedProfileId) === 'thinking' &&
    explicitMaxTokens === undefined &&
    typeof catalogMaxTokens === 'number' &&
    typeof profileMaxTokens === 'number' &&
    profileMaxTokens < catalogMaxTokens &&
    merged.sampling?.maxTokens === profileMaxTokens
  ) {
    merged.sampling = { ...merged.sampling, maxTokens: catalogMaxTokens };
  }
  const baseSampling: SamplingBlock = merged.sampling ?? {};
  const thinking = isReasoningEngaged({
    tuning: merged,
    styleReasoningFormat: input.styleReasoningFormat,
    reasoningEffort: input.reasoningEffort,
    latestUserPrompt: input.latestUserPrompt,
  });
  const skipThinkingFold = profileKind(resolvedProfileId) === 'thinking';
  const sampling: SamplingBlock =
    thinking && !skipThinkingFold
      ? deepMerge(baseSampling, merged.samplingWhenThinking ?? {})
      : baseSampling;
  return {
    sampling,
    reasoning: merged.reasoning ?? {},
    output: merged.output ?? {},
    ...(merged.toolChoice ? { toolChoice: merged.toolChoice } : {}),
    promptTags: merged.promptTags ?? {},
    wasThinking: thinking,
    ...(resolvedProfileId ? { resolvedTuningProfile: resolvedProfileId } : {}),
  };
}
