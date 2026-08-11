/**
 * Resolve + apply per-model sampling / reasoning / structured-output knobs.
 *
 * Resolution order (highest wins):
 *   1. Gezel frontmatter `tuning` — sparse, deep-merged on top of (2).
 *   2. Catalog manifest `tuning` — recommended defaults from the gilde.
 *   3. Provider built-in default — left untouched in this module; caller
 *      is responsible for whatever the engine emits when a field is absent.
 *
 * Dual-mode sampling (Qwen3+, Nemotron Nano): `samplingWhenThinking` is a
 * sparse override of `sampling`, merged shallow when reasoning is engaged.
 * The runtime determines "is this a thinking turn" via
 * {@link isReasoningEngaged}.
 *
 * The {@link applyTuning} helper writes a `ResolvedTuning` into a request
 * body using a per-provider {@link TuningMap}. Fields a provider doesn't
 * support are silently dropped — the map's `null` entry signals "drop".
 */

import type { ChatModelTuning, ProviderName, SamplingBlock } from '@bendyline/gezel';
import { DEFAULT_TUNING_PROFILE_ID, profileKind, resolveProfileChain } from '@bendyline/gezel';

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

// ─────────────────────────────────────────────────────────────────────
// Per-provider mapping + applyTuning helper

/**
 * A {@link TuningMap} value: either a target key on the request body /
 * options dict (string), or `null` meaning "this provider doesn't support
 * this field — drop it." The flat key form covers 90% of the surface;
 * nested cases (DRY → three separate fields, structured output → a
 * compound object) carry their own writer functions.
 */
type SimpleMapEntry = { key: string };
type NestedMapEntry = { write: (target: Record<string, unknown>, value: unknown) => void };
type DroppedMapEntry = null;
export type TuningMapEntry = SimpleMapEntry | NestedMapEntry | DroppedMapEntry;

/**
 * Map a flat path inside `ResolvedTuning` to a write rule. Keys are dotted
 * paths (e.g. `'sampling.temperature'`). Absent paths in the map are
 * treated the same as `null` — silently dropped.
 */
export type TuningMap = Partial<Record<TuningPath, TuningMapEntry>>;

export type TuningPath =
  | 'sampling.temperature'
  | 'sampling.topP'
  | 'sampling.topK'
  | 'sampling.minP'
  | 'sampling.maxTokens'
  | 'sampling.seed'
  | 'sampling.repetitionPenalty'
  | 'sampling.repetitionContext'
  | 'sampling.frequencyPenalty'
  | 'sampling.presencePenalty'
  | 'sampling.dry'
  | 'sampling.xtc'
  | 'reasoning.effort'
  | 'reasoning.thinkingBudget'
  | 'reasoning.enableThinking'
  | 'reasoning.templateKwargs'
  | 'output.responseFormat'
  | 'output.jsonSchema'
  | 'output.grammar'
  | 'toolChoice';

function pluck(tuning: ResolvedTuning, path: TuningPath): unknown {
  switch (path) {
    case 'sampling.temperature':
      return tuning.sampling.temperature;
    case 'sampling.topP':
      return tuning.sampling.topP;
    case 'sampling.topK':
      return tuning.sampling.topK;
    case 'sampling.minP':
      return tuning.sampling.minP;
    case 'sampling.maxTokens':
      return tuning.sampling.maxTokens;
    case 'sampling.seed':
      return tuning.sampling.seed;
    case 'sampling.repetitionPenalty':
      return tuning.sampling.repetitionPenalty;
    case 'sampling.repetitionContext':
      return tuning.sampling.repetitionContext;
    case 'sampling.frequencyPenalty':
      return tuning.sampling.frequencyPenalty;
    case 'sampling.presencePenalty':
      return tuning.sampling.presencePenalty;
    case 'sampling.dry':
      return tuning.sampling.dry;
    case 'sampling.xtc':
      return tuning.sampling.xtc;
    case 'reasoning.effort':
      return tuning.reasoning.effort;
    case 'reasoning.thinkingBudget':
      return tuning.reasoning.thinkingBudget;
    case 'reasoning.enableThinking':
      return tuning.reasoning.enableThinking;
    case 'reasoning.templateKwargs':
      return tuning.reasoning.templateKwargs;
    case 'output.responseFormat':
      return tuning.output.responseFormat;
    case 'output.jsonSchema':
      return tuning.output.jsonSchema;
    case 'output.grammar':
      return tuning.output.grammar;
    case 'toolChoice':
      return tuning.toolChoice;
    default: {
      const _exhaustive: never = path;
      return _exhaustive;
    }
  }
}

/**
 * Walk a `ResolvedTuning` and write its set fields into `target` according
 * to the provider's mapping. Skips:
 *   - undefined values (not set anywhere in the resolution stack)
 *   - map entries that are `null` (provider doesn't support)
 *   - paths absent from the map (treated as unsupported)
 */
export function applyTuning(
  target: Record<string, unknown>,
  tuning: ResolvedTuning,
  map: TuningMap,
): void {
  const paths = Object.keys(map) as TuningPath[];
  for (const path of paths) {
    const entry = map[path];
    if (!entry) continue;
    const value = pluck(tuning, path);
    if (value === undefined) continue;
    if ('write' in entry) {
      entry.write(target, value);
    } else {
      target[entry.key] = value;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
// Per-provider maps

/**
 * Map cloud effort tiers → Anthropic `thinking.budget_tokens`. Mirrors the
 * existing hand-rolled remap in providers/anthropic.ts.
 */
const ANTHROPIC_EFFORT_BUDGET: Record<'low' | 'medium' | 'high', number> = {
  low: 2048,
  medium: 8192,
  high: 24_576,
};

/**
 * Build a writer that sets `thinking.budget_tokens` (Anthropic shape).
 * Direct `thinkingBudget` wins over `effort`; this writer only fires for
 * `effort` so the two never both land.
 */
function writeAnthropicEffort(target: Record<string, unknown>, value: unknown): void {
  if (typeof value !== 'string') return;
  const budget = ANTHROPIC_EFFORT_BUDGET[value as 'low' | 'medium' | 'high'];
  if (budget === undefined) return;
  // Don't clobber a direct thinkingBudget if it was set first; the caller
  // writes `reasoning.thinkingBudget` BEFORE `reasoning.effort` in the
  // map, so this branch only fires when the direct budget was absent.
  if (target.thinking && typeof target.thinking === 'object' && target.thinking !== null) {
    const t = target.thinking as Record<string, unknown>;
    if (t.budget_tokens !== undefined) return;
    t.budget_tokens = budget;
    return;
  }
  target.thinking = { type: 'enabled', budget_tokens: budget };
}

function writeAnthropicThinkingBudget(target: Record<string, unknown>, value: unknown): void {
  if (typeof value !== 'number') return;
  target.thinking = { type: 'enabled', budget_tokens: value };
}

/**
 * Build a writer that sets a chat-template kwarg without clobbering
 * sibling kwargs the caller may have already set.
 */
function writeChatTemplateKwarg(name: string) {
  return (target: Record<string, unknown>, value: unknown): void => {
    const existing = target.chat_template_kwargs;
    if (existing && typeof existing === 'object' && existing !== null) {
      (existing as Record<string, unknown>)[name] = value;
    } else {
      target.chat_template_kwargs = { [name]: value };
    }
  };
}

/**
 * Merge a manifest-declared `reasoning.templateKwargs` record into the
 * request's `chat_template_kwargs`, one key at a time so it composes with
 * whatever `enableThinking` (and any per-turn override) already wrote
 * rather than replacing the whole object.
 */
function writeChatTemplateKwargs(target: Record<string, unknown>, value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  for (const [name, kwarg] of Object.entries(value as Record<string, unknown>)) {
    if (kwarg === undefined) continue;
    writeChatTemplateKwarg(name)(target, kwarg);
  }
}

/** OpenAI-flavored `response_format` writer. */
function writeOpenAIResponseFormat(target: Record<string, unknown>, value: unknown): void {
  if (value === 'text') return; // Default; sending it is noise.
  if (value === 'json_object') {
    target.response_format = { type: 'json_object' };
  }
}

function writeOpenAIJsonSchema(target: Record<string, unknown>, value: unknown): void {
  if (!value || typeof value !== 'object') return;
  target.response_format = {
    type: 'json_schema',
    json_schema: { name: 'response', strict: true, schema: value },
  };
}

function writeLlamaCppResponseFormat(target: Record<string, unknown>, value: unknown): void {
  if (value === 'text') return;
  if (value === 'json_object') {
    target.response_format = { type: 'json_object' };
  }
}

function writeLlamaCppJsonSchema(target: Record<string, unknown>, value: unknown): void {
  if (!value || typeof value !== 'object') return;
  target.json_schema = value;
}

function writeOllamaResponseFormat(target: Record<string, unknown>, value: unknown): void {
  if (value === 'text') return;
  if (value === 'json_object') {
    target.format = 'json';
  }
}

function writeOllamaJsonSchema(target: Record<string, unknown>, value: unknown): void {
  if (!value || typeof value !== 'object') return;
  target.format = value;
}

function writeMlxResponseFormat(target: Record<string, unknown>, value: unknown): void {
  if (value === 'text') return;
  if (value === 'json_object') {
    target.response_format = { type: 'json_object' };
  }
}

function writeDrySplit(target: Record<string, unknown>, value: unknown): void {
  if (!value || typeof value !== 'object') return;
  const v = value as { multiplier?: number; base?: number; allowedLength?: number };
  if (v.multiplier !== undefined) target.dry_multiplier = v.multiplier;
  if (v.base !== undefined) target.dry_base = v.base;
  if (v.allowedLength !== undefined) target.dry_allowed_length = v.allowedLength;
}

function writeXtcSplit(target: Record<string, unknown>, value: unknown): void {
  if (!value || typeof value !== 'object') return;
  const v = value as { probability?: number; threshold?: number };
  if (v.probability !== undefined) target.xtc_probability = v.probability;
  if (v.threshold !== undefined) target.xtc_threshold = v.threshold;
}

/**
 * Ollama's API splits sampling into a nested `options` dict and keeps
 * `think` / `format` at the body root. We export two maps so the
 * provider can target each shape correctly.
 */
export const OLLAMA_OPTIONS_TUNING_MAP: TuningMap = {
  'sampling.temperature': { key: 'temperature' },
  'sampling.topP': { key: 'top_p' },
  'sampling.topK': { key: 'top_k' },
  'sampling.minP': { key: 'min_p' },
  'sampling.maxTokens': { key: 'num_predict' },
  'sampling.seed': { key: 'seed' },
  'sampling.repetitionPenalty': { key: 'repeat_penalty' },
  'sampling.repetitionContext': { key: 'repeat_last_n' },
  'sampling.frequencyPenalty': { key: 'frequency_penalty' },
  'sampling.presencePenalty': { key: 'presence_penalty' },
  'sampling.dry': null,
  'sampling.xtc': null,
  'reasoning.effort': null,
  'reasoning.thinkingBudget': null,
  'reasoning.enableThinking': null,
  'reasoning.templateKwargs': null,
  'output.responseFormat': null,
  'output.jsonSchema': null,
  'output.grammar': null,
  toolChoice: null,
};

export const OLLAMA_BODY_TUNING_MAP: TuningMap = {
  'sampling.temperature': null,
  'sampling.topP': null,
  'sampling.topK': null,
  'sampling.minP': null,
  'sampling.maxTokens': null,
  'sampling.seed': null,
  'sampling.repetitionPenalty': null,
  'sampling.repetitionContext': null,
  'sampling.frequencyPenalty': null,
  'sampling.presencePenalty': null,
  'sampling.dry': null,
  'sampling.xtc': null,
  'reasoning.effort': null,
  'reasoning.thinkingBudget': null,
  'reasoning.enableThinking': { key: 'think' },
  'reasoning.templateKwargs': null,
  'output.responseFormat': { write: writeOllamaResponseFormat },
  'output.jsonSchema': { write: writeOllamaJsonSchema },
  'output.grammar': null,
  toolChoice: null,
};

/**
 * Back-compat alias — pre-split this was a single map. Equals
 * `OLLAMA_OPTIONS_TUNING_MAP` (the larger of the two). New callers
 * should use the specific options/body maps so they target the right
 * shape; this alias keeps existing tests + downstream importers
 * compiling without a coordinated rename.
 */
export const OLLAMA_TUNING_MAP: TuningMap = OLLAMA_OPTIONS_TUNING_MAP;

export const LLAMA_CPP_TUNING_MAP: TuningMap = {
  'sampling.temperature': { key: 'temperature' },
  'sampling.topP': { key: 'top_p' },
  'sampling.topK': { key: 'top_k' },
  'sampling.minP': { key: 'min_p' },
  'sampling.maxTokens': { key: 'max_tokens' },
  'sampling.seed': { key: 'seed' },
  'sampling.repetitionPenalty': { key: 'repeat_penalty' },
  'sampling.repetitionContext': { key: 'repeat_last_n' },
  'sampling.frequencyPenalty': { key: 'frequency_penalty' },
  'sampling.presencePenalty': { key: 'presence_penalty' },
  'sampling.dry': { write: writeDrySplit },
  'sampling.xtc': { write: writeXtcSplit },
  'reasoning.effort': null,
  // llama-server takes `--reasoning-budget N` at launch (default -1 =
  // unrestricted; N>0 caps thinking tokens) but does NOT expose a
  // per-request override. The flag is applied in
  // `buildLlamaCppProvider`'s launch resolver from the catalog's
  // `tuning.reasoning.thinkingBudget`. Per-gezel overrides on this
  // field are deliberately ignored — the server is shared across
  // gezels, the budget is a server-wide knob.
  'reasoning.thinkingBudget': null,
  'reasoning.enableThinking': { write: writeChatTemplateKwarg('enable_thinking') },
  'reasoning.templateKwargs': { write: writeChatTemplateKwargs },
  'output.responseFormat': { write: writeLlamaCppResponseFormat },
  'output.jsonSchema': { write: writeLlamaCppJsonSchema },
  'output.grammar': { key: 'grammar' },
  toolChoice: { key: 'tool_choice' },
};

export const MLX_TUNING_MAP: TuningMap = {
  'sampling.temperature': { key: 'temperature' },
  'sampling.topP': { key: 'top_p' },
  'sampling.topK': { key: 'top_k' },
  'sampling.minP': { key: 'min_p' },
  'sampling.maxTokens': { key: 'max_tokens' },
  'sampling.seed': { key: 'seed' },
  'sampling.repetitionPenalty': { key: 'repetition_penalty' },
  'sampling.repetitionContext': { key: 'repetition_context_size' },
  'sampling.frequencyPenalty': null,
  'sampling.presencePenalty': null,
  'sampling.dry': null,
  'sampling.xtc': null,
  'reasoning.effort': null,
  // Enforced by the sidecar's ThinkBudgetProcessor (llama parity with
  // `--reasoning-budget`). Dropping this was wild-caught twice: the
  // 2026-07 "qwen unbounded-thinking loops" finding, and 2026-08-05's
  // 44K-char/70-hesitation single think block against a 4,096 budget.
  'reasoning.thinkingBudget': { key: 'max_thinking_tokens' },
  'reasoning.enableThinking': { write: writeChatTemplateKwarg('enable_thinking') },
  'reasoning.templateKwargs': { write: writeChatTemplateKwargs },
  'output.responseFormat': { write: writeMlxResponseFormat },
  'output.jsonSchema': null,
  'output.grammar': null,
  toolChoice: { key: 'tool_choice' },
};

export const ANTHROPIC_TUNING_MAP: TuningMap = {
  'sampling.temperature': { key: 'temperature' },
  'sampling.topP': { key: 'top_p' },
  'sampling.topK': { key: 'top_k' },
  'sampling.minP': null,
  'sampling.maxTokens': { key: 'max_tokens' },
  'sampling.seed': null,
  'sampling.repetitionPenalty': null,
  'sampling.repetitionContext': null,
  'sampling.frequencyPenalty': null,
  'sampling.presencePenalty': null,
  'sampling.dry': null,
  'sampling.xtc': null,
  // thinkingBudget wins; effort writer skips if budget already set.
  'reasoning.thinkingBudget': { write: writeAnthropicThinkingBudget },
  'reasoning.effort': { write: writeAnthropicEffort },
  'reasoning.enableThinking': null,
  'reasoning.templateKwargs': null,
  'output.responseFormat': null,
  'output.jsonSchema': null,
  'output.grammar': null,
  toolChoice: { key: 'tool_choice' },
};

export const OPENAI_TUNING_MAP: TuningMap = {
  'sampling.temperature': { key: 'temperature' },
  'sampling.topP': { key: 'top_p' },
  'sampling.topK': null,
  'sampling.minP': null,
  'sampling.maxTokens': { key: 'max_tokens' },
  'sampling.seed': { key: 'seed' },
  'sampling.repetitionPenalty': null,
  'sampling.repetitionContext': null,
  'sampling.frequencyPenalty': { key: 'frequency_penalty' },
  'sampling.presencePenalty': { key: 'presence_penalty' },
  'sampling.dry': null,
  'sampling.xtc': null,
  'reasoning.effort': {
    write: (target, value) => {
      if (typeof value !== 'string') return;
      target.reasoning = { effort: value };
    },
  },
  'reasoning.thinkingBudget': null,
  'reasoning.enableThinking': null,
  'reasoning.templateKwargs': null,
  'output.responseFormat': { write: writeOpenAIResponseFormat },
  'output.jsonSchema': { write: writeOpenAIJsonSchema },
  'output.grammar': null,
  toolChoice: { key: 'tool_choice' },
};

/**
 * Copilot intentionally drops nearly everything. The CLI doesn't accept
 * sampling at all; reasoning effort flows via a separate explicit
 * parameter handled outside the request body. Map is here for symmetry
 * and explicitness.
 */
export const COPILOT_TUNING_MAP: TuningMap = {
  'sampling.temperature': null,
  'sampling.topP': null,
  'sampling.topK': null,
  'sampling.minP': null,
  'sampling.maxTokens': null,
  'sampling.seed': null,
  'sampling.repetitionPenalty': null,
  'sampling.repetitionContext': null,
  'sampling.frequencyPenalty': null,
  'sampling.presencePenalty': null,
  'sampling.dry': null,
  'sampling.xtc': null,
  'reasoning.effort': null,
  'reasoning.thinkingBudget': null,
  'reasoning.enableThinking': null,
  'reasoning.templateKwargs': null,
  'output.responseFormat': null,
  'output.jsonSchema': null,
  'output.grammar': null,
  toolChoice: null,
};

/**
 * Convenience: pick the right map for a provider name. Cloud variants
 * (`anthropic-cli`, `codex-cli`) fall back to their parent provider's
 * map — the CLI surface doesn't accept sampling either way, but the
 * `tool_choice` and effort fields still apply when the provider supports
 * them via its own command-line flags.
 */
export function tuningMapFor(provider: ProviderName): TuningMap {
  switch (provider) {
    case 'ollama':
      return OLLAMA_TUNING_MAP;
    case 'llama-cpp':
      return LLAMA_CPP_TUNING_MAP;
    case 'mlx':
      return MLX_TUNING_MAP;
    case 'ds4':
      // ds4 (DwarfStar) serves DeepSeek-V4 over an OpenAI-compatible body with
      // the same sampling surface (temperature / top_p / max_tokens / tool_choice)
      // as llama-server, so it shares llama.cpp's tuning map.
      return LLAMA_CPP_TUNING_MAP;
    case 'anthropic':
    case 'anthropic-cli':
      return ANTHROPIC_TUNING_MAP;
    case 'openai':
    case 'codex-cli':
      return OPENAI_TUNING_MAP;
    case 'copilot':
      return COPILOT_TUNING_MAP;
    case 'remote':
      // Remote inference applies its engine-specific tuning map on the SERVER
      // (Device B); A ships the ResolvedTuning verbatim on the wire and maps
      // nothing onto the request body locally. An empty map is the no-op.
      return {};
    default: {
      const _exhaustive: never = provider;
      return _exhaustive;
    }
  }
}
