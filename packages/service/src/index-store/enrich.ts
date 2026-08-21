import { readFile } from 'node:fs/promises';
import {
  GEZEL_VERSION,
  type GezelSummary,
  type ProviderName,
  createLogger,
} from '@bendyline/gezel';
import { CompletionBlockedError } from '../chat/large-content.js';
import type { ChatManager } from '../chat/manager.js';
import { safeJoin } from '../fs/safe-paths.js';
import type { Store } from '../fs/store.js';
import { shadowDocFilesPaths } from './docs.js';
import { parseFrontmatter } from './frontmatter.js';
import {
  type FileRecord,
  type IndexProvenance,
  type IndexStore,
  MAX_ENRICH_ATTEMPTS,
} from './index-store.js';

/**
 * Per-file semantic enrichment (the boekwachter's unit of work): produce an
 * optional one-paragraph summary via a local LLM, build embeddable chunks, and
 * store their vectors. Embeddings run locally (transformers.js) and are the
 * always-on part; the LLM summary is best-effort (skipped when no local model
 * is configured). Hash-gated by the caller via `filesNeedingEnrichment`.
 *
 * Deps are injected so this is unit-testable without a real model:
 *   - `summarize(prompt)` → summary text, or '' to skip (e.g. no LLM)
 *   - `embed(texts)`      → one vector per text
 */

const log = createLogger('enrich');

// Indexing is a mechanical extraction task, not a reasoning task. Instruct
// mode keeps thinking-capable local models from spending the whole request
// budget in a hidden reasoning channel. We intentionally retain the model's
// normal instruct-profile output allowance: the 2-3 sentence prompt is the
// length control, not an artificially small max-token override.
const INDEX_TUNING_PROFILE = 'instruct';
const SUMMARIZE_TIMEOUT_MS = 120_000;
const REVIEW_TIMEOUT_MS = 180_000;

export interface EnrichDeps {
  summarize: (prompt: string, activity?: string) => Promise<EnrichCompletionResult>;
  embed: (texts: string[]) => Promise<number[][]>;
  model?: string;
  /**
   * The review-pass completion (cliffs notes + issues + health). Same local
   * model as `summarize` but a longer timeout — reviews emit materially more
   * output tokens than a 2-3 sentence summary. Absent when no local model is
   * configured; the review pass skips entirely then.
   */
  review?: (prompt: string, activity?: string) => Promise<EnrichCompletionResult>;
  /**
   * Default/primary attribution for legacy bare-string completions and
   * non-completion work. Runtime completions carry their own actual target so
   * a fallback can override this per result. Output-only, never a routing
   * input.
   */
  provenance?: IndexProvenance;
  /**
   * Live concurrent-one-shot width of the resolved target's queue. Full
   * drives dispatch this many per-file scans at once instead of one; the
   * value is re-read as slots free because a lazily-initialized provider
   * reports 1 until its first call spins it up.
   */
  oneShotWidth?: () => number;
}

/**
 * One LLM completion plus the identity that actually produced it. Hand-built
 * deps may still return a bare string; consumers resolve those through the
 * deps-level defaults for backwards compatibility. Runtime deps always return
 * this richer shape so a policy fallback cannot inherit the primary target's
 * provenance.
 */
export interface EnrichCompletion {
  text: string;
  model: string;
  provenance?: IndexProvenance;
}

export type EnrichCompletionResult = string | EnrichCompletion;

export interface ResolvedEnrichCompletion {
  text: string;
  model: string;
  provenance?: IndexProvenance;
}

/** Resolve legacy bare-string completions and runtime attributed completions. */
export function resolveEnrichCompletion(
  result: EnrichCompletionResult,
  deps: Pick<EnrichDeps, 'model' | 'provenance'>,
): ResolvedEnrichCompletion {
  if (typeof result === 'string') {
    return {
      text: result,
      model: deps.model ?? 'unknown',
      ...(deps.provenance ? { provenance: deps.provenance } : {}),
    };
  }
  return {
    text: result.text,
    model: result.model,
    ...(result.provenance ? { provenance: result.provenance } : {}),
  };
}

/**
 * Attribution for a merged, windowed result. Normally every window has one
 * identity. If routing changes mid-review, retain every actual provider/model
 * instead of falsely choosing either one.
 */
export function mergeEnrichCompletionAttribution(
  completions: readonly ResolvedEnrichCompletion[],
  deps: Pick<EnrichDeps, 'model' | 'provenance'>,
): Pick<ResolvedEnrichCompletion, 'model' | 'provenance'> {
  if (completions.length === 0) {
    return {
      model: deps.model ?? 'unknown',
      ...(deps.provenance ? { provenance: deps.provenance } : {}),
    };
  }
  const models = distinct(completions.map((c) => c.model));
  const providers = distinct(completions.map((c) => c.provenance?.provider));
  const provenanceFields = ['gezelId', 'gezelName', 'appVersion'] as const;
  const provenance: IndexProvenance = {};
  if (providers.length > 0) provenance.provider = providers.join(' + ');
  for (const field of provenanceFields) {
    const values = distinct(completions.map((c) => c.provenance?.[field]));
    // A merged artifact must not claim one actor/version when its contributing
    // completions disagree. Runtime fallbacks normally retain all three.
    if (values.length === 1) provenance[field] = values[0];
  }
  return {
    model: models.join(' + ') || deps.model || 'unknown',
    ...(Object.keys(provenance).length > 0 ? { provenance } : {}),
  };
}

function distinct(values: ReadonlyArray<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

export interface EnrichResult {
  summarized: boolean;
  embedded: number;
}

// Local providers we'll use for summaries. Embeddings are always local and run
// regardless of whether one of these is configured.
export const ENRICH_LOCAL_PROVIDERS: ProviderName[] = ['llama-cpp', 'mlx', 'ollama'];

export interface EnrichTargetOptions {
  nightShift?: boolean;
  boekwachter?: Pick<GezelSummary, 'id' | 'name' | 'provider' | 'model'>;
}

/**
 * Resolve the model used by autonomous indexing work. Local-first: absent an
 * explicit choice, only local engines are considered. A cloud target is
 * accepted through exactly two explicit acts — the Night Shift override, or
 * a provider AND model both pinned on the Boekwachter's own frontmatter.
 */
export async function resolveEnrichTarget(
  store: Store,
  opts: EnrichTargetOptions = {},
): Promise<{ providerName: ProviderName; model: string } | null> {
  const cfg = await store.readConfig().catch(() => null);
  let providerName: ProviderName | undefined;
  let model: string | undefined;
  const nightShiftOverride = opts.nightShift ? cfg?.nightShift?.modelOverride : undefined;
  if (nightShiftOverride?.enabled === true && nightShiftOverride.provider) {
    const nightModel = nightShiftOverride.model ?? cfg?.defaultModel?.[nightShiftOverride.provider];
    if (nightModel) {
      providerName = nightShiftOverride.provider;
      model = nightModel;
    }
  }
  // A Boekwachter with BOTH provider and model pinned in frontmatter gets
  // exactly what the user configured — cloud included. Writing both fields
  // on the gezel IS the explicit opt-in; what stays forbidden is silently
  // routing workspace indexing to a cloud default the user never chose for
  // this work, which is why an incomplete pin falls through to local-first.
  if ((!providerName || !model) && opts.boekwachter?.provider && opts.boekwachter.model) {
    providerName = opts.boekwachter.provider;
    model = opts.boekwachter.model;
  }
  if (!providerName || !model) {
    for (const name of ENRICH_LOCAL_PROVIDERS) {
      const configuredModel = cfg?.defaultModel?.[name];
      if (configuredModel) {
        providerName = name;
        model = configuredModel;
        break;
      }
    }
  }

  const envModel = process.env.GEZEL_ENRICH_MODEL?.trim();
  if (envModel) {
    model = envModel;
    const envProvider = process.env.GEZEL_ENRICH_PROVIDER?.trim() as ProviderName | undefined;
    if (envProvider && ENRICH_LOCAL_PROVIDERS.includes(envProvider)) providerName = envProvider;
  }
  return providerName && model ? { providerName, model } : null;
}

/**
 * The first configured local engine — the blocked-content fallback target
 * when a cloud enricher refuses a file on policy grounds. Same resolution as
 * resolveEnrichTarget's local-first branch.
 */
async function resolveLocalFallbackTarget(
  store: Store,
): Promise<{ providerName: ProviderName; model: string } | null> {
  const cfg = await store.readConfig().catch(() => null);
  for (const name of ENRICH_LOCAL_PROVIDERS) {
    const model = cfg?.defaultModel?.[name];
    if (model) return { providerName: name, model };
  }
  return null;
}

/**
 * Does this error message look like a request-level content-policy refusal?
 * Wild-caught: OpenAI's backend answers "Request blocked." for prompts whose
 * CONTENT contains injection-looking markup (`<think>`, `<function=...>`
 * fixtures — the exact corpus of gezel's own salvage/strip modules), which
 * made three source files fail summarize 3-for-3 deterministically.
 * Deliberately narrow: timeouts and transport faults must keep their normal
 * retry semantics.
 */
function isPolicyBlockMessage(message: string): boolean {
  return /request blocked|content policy|content_filter|invalid_prompt/i.test(message);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Resolve a summarizer (if one is configured) + the local embedder — shared
 * by the background enrichment loop and the on-demand drive route. During
 * Night Shift an enabled provider/model override wins; then a Boekwachter
 * frontmatter pin (provider + model, cloud allowed — see
 * `resolveEnrichTarget`); otherwise the first configured local provider's
 * default model.
 *
 * `GEZEL_ENRICH_MODEL` (with optional `GEZEL_ENRICH_PROVIDER`) decouples the
 * enricher from the chat default: enrichment is a bulk background chore where
 * a small fast model (e.g. an e4b) is the right tool even when the user chats
 * with a much larger one. The eval harness leans on this to A/B index levers
 * with a fixed fast enricher and a capable executor — without it, "trial model
 * == enricher == executor" makes agent-outcome benches impractical (a 9B
 * enricher takes hours over a 350-file corpus).
 */
export async function buildEnrichDeps(
  store: Store,
  chat: ChatManager,
  opts: {
    nightShift?: boolean;
    /**
     * Mark the enrichment one-shots as ambient housekeeping — held by
     * local-engine admission control until the user has been quiet.
     * The background `IndexEnrichmentManager` passes true; the
     * explicit "enrich now" HTTP route (which runs under a caller
     * deadline the gate would blow) leaves it off.
     */
    ambient?: boolean;
    /** The project-roster Boekwachter whose persona owns this pass. */
    boekwachter?: Pick<GezelSummary, 'id' | 'name' | 'provider' | 'model'>;
    /** Project owning the indexed paths, for queue and chat activity context. */
    projectId?: string;
  } = {},
): Promise<EnrichDeps> {
  const { embedBatch } = await import('../memory/embeddings.js');
  const embed = (texts: string[]) => embedBatch(texts);

  const target = await resolveEnrichTarget(store, opts);
  if (!target) {
    // No local LLM configured — embeddings only (still makes code searchable).
    return { summarize: async () => '', embed };
  }
  const { providerName, model } = target;
  const provenanceFor = (actualProvider: ProviderName): IndexProvenance => ({
    provider: actualProvider,
    ...(opts.boekwachter ? { gezelId: opts.boekwachter.id, gezelName: opts.boekwachter.name } : {}),
    appVersion: GEZEL_VERSION,
  });
  const provenance = provenanceFor(providerName);
  // Give both local and cloud/CLI targets room to finish. Local engines can
  // spend tens of seconds on model admission, prefill, or thermal cooling;
  // Copilot-family CLIs take 30-90s on a cold first call. Instruct mode above
  // bounds the expensive failure mode without relying on a brittle 30s wall.
  const local = ENRICH_LOCAL_PROVIDERS.includes(providerName);
  const gezelOpts = opts.boekwachter
    ? { gezelId: opts.boekwachter.id, useGezelPersona: true, actorLabel: opts.boekwachter.name }
    : { actorLabel: 'Boekwachter' };
  const oneShot =
    (target: { providerName: ProviderName; model: string }, timeoutMs: number, jobLabel: string) =>
    async (prompt: string, activity?: string): Promise<EnrichCompletion> => ({
      text: await chat.oneShotCompletion(prompt, timeoutMs, {
        providerName: target.providerName,
        model: target.model,
        ...gezelOpts,
        ...(opts.projectId ? { projectId: opts.projectId } : {}),
        jobLabel: activity?.trim() || jobLabel,
        tuningProfileId: INDEX_TUNING_PROFILE,
        ...(opts.ambient ? { ambient: true } : {}),
      }),
      model: target.model,
      provenance: provenanceFor(target.providerName),
    });
  // Blocked-content fallback: a cloud enricher can refuse a file outright on
  // policy grounds (isPolicyBlockMessage). Local engines carry no such filter,
  // so when one is configured it takes over exactly those files. Each
  // completion carries its actual target so fallback output is never stamped
  // with the primary cloud provider/model.
  const fallbackTarget = local ? null : await resolveLocalFallbackTarget(store);
  // A thrown one-shot logs nothing on its own — surface the reason here or a
  // repeatedly-failing file is undiagnosable (the 3157-of-3160 incident:
  // three markup-heavy files burned their attempt caps with zero log lines).
  const withPolicyFallback =
    (
      primary: (prompt: string, activity?: string) => Promise<EnrichCompletion>,
      fallback: ((prompt: string, activity?: string) => Promise<EnrichCompletion>) | null,
      label: string,
    ) =>
    async (prompt: string, activity?: string): Promise<EnrichCompletionResult> => {
      try {
        return await primary(prompt, activity);
      } catch (err) {
        const message = errorMessage(err);
        if (isPolicyBlockMessage(message)) {
          if (fallback && fallbackTarget) {
            log.warn(
              `${label} blocked by ${providerName} policy filter; retrying on ${fallbackTarget.providerName}:${fallbackTarget.model}`,
            );
            try {
              return await fallback(prompt, activity);
            } catch (fallbackErr) {
              // Local-engine failure is transient (deferred, cold, busy) —
              // burn a normal retry attempt instead of giving up on the hash.
              log.warn(`blocked-content local fallback failed: ${errorMessage(fallbackErr)}`);
              return '';
            }
          }
          // No local engine to fall back to: the block is deterministic for
          // this content, so tell callers to stop spending retries on it.
          throw new CompletionBlockedError(message);
        }
        log.warn(`${label} one-shot failed: ${message}`);
        return '';
      }
    };
  const summarize = withPolicyFallback(
    oneShot({ providerName, model }, SUMMARIZE_TIMEOUT_MS, 'index enrichment'),
    fallbackTarget
      ? oneShot(fallbackTarget, SUMMARIZE_TIMEOUT_MS, 'index enrichment (blocked-content fallback)')
      : null,
    'summarize',
  );
  const review = withPolicyFallback(
    oneShot({ providerName, model }, REVIEW_TIMEOUT_MS, 'index review'),
    fallbackTarget
      ? oneShot(fallbackTarget, REVIEW_TIMEOUT_MS, 'index review (blocked-content fallback)')
      : null,
    'review',
  );
  // Guarded for test fakes that stub ChatManager structurally.
  const oneShotWidth =
    typeof chat.oneShotQueueWidth === 'function'
      ? () => chat.oneShotQueueWidth(providerName)
      : undefined;
  return { summarize, embed, model, review, provenance, ...(oneShotWidth ? { oneShotWidth } : {}) };
}

const PROMPT_CONTENT_CAP = 6000;

/**
 * Windowed-chunk lever (index-bench #3). ON by default; opt out with
 * GEZEL_INDEX_WINDOW=0 (the index-bench control arm uses this).
 *
 * The whole-file gist chunk (summary + signatures) answers "what is this file
 * for", but a *specific feature buried deep inside a 200-line function* — a
 * table parser three-quarters through convert.ts, caption handling late in
 * markdownToDoc.ts — never reaches an embeddable chunk: the gist truncates past
 * it and per-symbol chunking (index-bench lever #1) folds the whole giant
 * function into one chunk that also truncates past it. So we split only LARGE
 * symbols into overlapping windows, each embedded on its own. Small
 * files/functions are untouched (just the gist, as before), which is why this
 * recovers deep-in-a-big-function misses without the chunk-flood that made
 * lever #1 net-neutral on MiniLM.
 *
 * Promoted to default: deterministic retrieval win (+1 golden query,
 * +0.069 MRR, zero regressions on the bge bench) AND an end-to-end agent-outcome
 * confirmation — the predicted query (parse-markdown) flipped wrong→correct as a
 * real agent citation with no genuine regression (evals/runs/INDEX-BENCH-
 * 2026-07-07.md). Cost is bounded: ~2× embedded chunks, no LLM cost, no
 * wall-clock delta (windows are raw code, never summarized).
 */
const WINDOW_ENABLED = (): boolean => process.env.GEZEL_INDEX_WINDOW !== '0';
const LARGE_SYMBOL_LINES = 40;
const WINDOW_CHARS = 1200;
const WINDOW_OVERLAP = 200;
const MAX_WINDOWS_PER_FILE = 8;

interface ChunkInput {
  kind: string;
  lineStart: number;
  lineEnd: number;
  text: string;
}

/** Overlapping char windows over a text span (returns [text] when it fits). */
function slidingWindows(text: string): string[] {
  if (text.length <= WINDOW_CHARS) return [text];
  const step = WINDOW_CHARS - WINDOW_OVERLAP;
  const out: string[] = [];
  for (let i = 0; i < text.length; i += step) {
    out.push(text.slice(i, i + WINDOW_CHARS));
    if (i + WINDOW_CHARS >= text.length) break;
  }
  return out;
}

/**
 * Additive windowed content chunks for the large symbols of a code file. The
 * gist chunk is built by the caller; this appends per-window chunks only for
 * symbols spanning ≥ LARGE_SYMBOL_LINES, capped at MAX_WINDOWS_PER_FILE so one
 * pathological file can't flood the vector table.
 */
function largeSymbolWindows(
  content: string,
  symbols: Array<{ lineStart: number; lineEnd: number }>,
): ChunkInput[] {
  const lines = content.split('\n');
  const out: ChunkInput[] = [];
  for (const s of symbols) {
    if (out.length >= MAX_WINDOWS_PER_FILE) break;
    if (s.lineEnd - s.lineStart < LARGE_SYMBOL_LINES) continue;
    const span = lines.slice(s.lineStart - 1, s.lineEnd).join('\n');
    for (const w of slidingWindows(span)) {
      if (out.length >= MAX_WINDOWS_PER_FILE) break;
      if (w.trim())
        out.push({ kind: 'window', lineStart: s.lineStart, lineEnd: s.lineEnd, text: w });
    }
  }
  return out;
}

export function buildSummaryPrompt(file: FileRecord, content: string): string {
  const body = content.length > PROMPT_CONTENT_CAP ? content.slice(0, PROMPT_CONTENT_CAP) : content;
  if (file.kind === 'code') {
    return `Summarize this ${file.lang ?? 'source'} file in 2-3 sentences for a code-search index: what it does and its most important functions/classes. Reply with prose only, no preamble.\n\nFile: ${file.path}\n\n${body}`;
  }
  return `Summarize this document in 2-3 sentences for a search index. Reply with prose only, no preamble.\n\nDocument: ${file.path}\n\n${body}`;
}

const SYMBOL_SUMMARY_CAP = 30;
const SYMBOL_SUMMARY_CHAR_CAP = 200;

export function buildSymbolSummaryPrompt(
  file: FileRecord,
  content: string,
  symbols: Array<{ name: string; kind: string; signature?: string }>,
): string {
  const body = content.length > PROMPT_CONTENT_CAP ? content.slice(0, PROMPT_CONTENT_CAP) : content;
  const list = symbols
    .map((s) => `- ${s.name} (${s.kind})${s.signature ? `: ${s.signature}` : ''}`)
    .join('\n');
  return `For each listed symbol, write ONE line (under 100 characters) saying what it does. Reply with ONLY a JSON object mapping each symbol name to that line — no prose, no code fences.\n\nSymbols:\n${list}\n\nFile: ${file.path}\n\n${body}`;
}

/**
 * Tolerant parse of the symbol-summary reply: slice the outermost JSON object
 * (survives fences/preamble), keep only string values for known symbol names.
 */
export function parseSymbolSummaryJson(
  raw: string,
  knownNames: ReadonlySet<string>,
): Array<{ name: string; summary: string }> {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
  const out: Array<{ name: string; summary: string }> = [];
  for (const [name, value] of Object.entries(parsed)) {
    if (typeof value !== 'string' || !knownNames.has(name)) continue;
    const summary = value.trim().slice(0, SYMBOL_SUMMARY_CHAR_CAP);
    if (summary) out.push({ name, summary });
  }
  return out;
}

/** Read the text we should summarize/embed for a file (shadow md for docs,
 *  descriptions/transcripts for images/audio — frontmatter stripped). */
export async function readEnrichableText(
  workspaceDir: string,
  artifactsDir: string,
  file: FileRecord,
): Promise<string | null> {
  if (file.modality === 'doc' || file.modality === 'image' || file.modality === 'audio') {
    const md = shadowDocFilesPaths(artifactsDir, file.path)?.mdPath;
    if (!md) return null;
    const raw = await readFile(md, 'utf8').catch(() => null);
    if (raw === null) return null;
    return file.modality === 'doc' ? raw : parseFrontmatter(raw).body;
  }
  const abs = safeJoin(workspaceDir, file.path);
  if (!abs) return null;
  return readFile(abs, 'utf8').catch(() => null);
}

/**
 * Ensure a file has embeddable chunks and return them. Docs/text keep their
 * static section chunks; code (which gets zero static chunks) receives a gist
 * chunk built from the summary + symbol signatures — signatures alone when no
 * summary exists — plus windowed large-symbol chunks. Shared by the full
 * enrichment pass and the embed-only tier so the chunk shape can never drift
 * between them.
 */
function ensureEmbeddableChunks(
  store: IndexStore,
  file: FileRecord,
  summary: string,
  content: string | null,
): ReturnType<IndexStore['chunksForFile']> {
  let chunks = store.chunksForFile(file.path);
  if (chunks.length === 0) {
    const symbols = store.symbolsForFile(file.path);
    const symbolText = symbols.map((s) => s.signature || s.name).join('\n');
    const text =
      [summary, symbolText].filter(Boolean).join('\n\n') || content?.slice(0, 1000) || '';
    const toPut: ChunkInput[] = [];
    if (text.trim()) toPut.push({ kind: 'summary', lineStart: 1, lineEnd: 1, text });
    if (WINDOW_ENABLED() && content && file.kind === 'code') {
      toPut.push(...largeSymbolWindows(content, symbols));
    }
    if (toPut.length > 0) {
      store.putChunks(file.path, file.hash, toPut);
      chunks = store.chunksForFile(file.path);
    }
  } else if (summary && chunks[0]?.kind !== 'summary') {
    // Prepend a summary chunk for docs so the file-level gist is searchable
    // too. Guarded on the leading chunk's kind: a reused summary re-entering
    // this path (embed-model migration re-embeds, or a full pass after the
    // embed-only tier already prepended) must not stack a second copy —
    // the rebuild below demotes prior chunks to 'section', so an unguarded
    // second visit would duplicate the summary text.
    store.putChunks(file.path, file.hash, [
      { kind: 'summary', lineStart: 1, lineEnd: 1, text: summary },
      ...chunks.map((c) => ({
        kind: 'section',
        lineStart: c.lineStart,
        lineEnd: c.lineEnd,
        text: c.text,
      })),
    ]);
    chunks = store.chunksForFile(file.path);
  }
  return chunks;
}

export type EmbedOnlyOutcome = 'embedded' | 'skipped' | 'unavailable';

/**
 * The always-on embed-only tier: give a file's chunks vectors WITHOUT any
 * LLM, so semantic search works before a Boekwachter joins the roster. Writes
 * the `embed_state` gate — never `enrichments`, whose consumption would
 * permanently block later summarization (the full pass readmits only
 * un-enriched hashes). A later full enrichment supersedes this work.
 */
export async function embedOnlyFile(
  store: IndexStore,
  workspaceDir: string,
  artifactsDir: string,
  file: FileRecord,
  embed: (texts: string[]) => Promise<number[][]>,
): Promise<EmbedOnlyOutcome> {
  if (!file.hash) return 'skipped';
  if (!store.vecAvailable) return 'unavailable';
  const content = await readEnrichableText(workspaceDir, artifactsDir, file);
  // Reuse a summary this hash already has (it survives an embed-model swap)
  // so the gist chunk matches what the full pass would build.
  const summary = store.getSummary(file.hash) ?? '';
  const chunks = ensureEmbeddableChunks(store, file, summary, content);
  try {
    if (chunks.length > 0) {
      const vectors = await embed(chunks.map((c) => c.text));
      for (let i = 0; i < chunks.length; i++) {
        const v = vectors[i];
        if (v) store.addTextVector(chunks[i]!.id, v);
      }
    }
    // Zero chunks (empty/unreadable file) is done for this hash, not retryable.
    store.markEmbedOnly(file.hash, file.path);
    return 'embedded';
  } catch {
    // An embed failure is usually process-wide (model failed to load). Record
    // the capped per-file attempt for poison-input safety, and tell the caller
    // to stop the batch rather than burn every file's budget in one outage.
    store.markEmbedOnlyAttempt(file.hash, file.path);
    return 'unavailable';
  }
}

export async function enrichFile(
  store: IndexStore,
  workspaceDir: string,
  artifactsDir: string,
  file: FileRecord,
  deps: EnrichDeps,
): Promise<EnrichResult> {
  const result: EnrichResult = { summarized: false, embedded: 0 };
  if (!file.hash) return result;

  const content = await readEnrichableText(workspaceDir, artifactsDir, file);

  // 1. LLM summary — reuse the existing one for this content hash if present.
  //    Reuse makes an embed-model migration cheap: clearing `enrichments` (not
  //    `summaries`) re-runs this per file, and a kept summary skips the LLM so
  //    the re-embed pays embedding cost only. Also spares the summarizer when a
  //    file's content is unchanged but its enrichment was invalidated.
  let summary = store.getSummary(file.hash) ?? '';
  let blockedByPolicy = false;
  if (summary) {
    result.summarized = true;
  } else if (content?.trim()) {
    let completion: ResolvedEnrichCompletion | undefined;
    try {
      completion = resolveEnrichCompletion(
        await deps.summarize(buildSummaryPrompt(file, content), `Indexing ${file.path}`),
        deps,
      );
      summary = completion.text.trim();
    } catch (err) {
      summary = '';
      if (err instanceof CompletionBlockedError) blockedByPolicy = true;
    }
    if (summary) {
      store.upsertSummary({
        contentHash: file.hash,
        filePath: file.path,
        summaryMd: summary,
        model: completion?.model ?? deps.model ?? 'unknown',
        ...(completion?.provenance ? { provenance: completion.provenance } : {}),
      });
      result.summarized = true;
    }
  }

  // 1b. Per-symbol one-liners (code only, LLM configured, not yet covered for
  //     this hash). One batched call per file; a parse/engine failure records
  //     a capped attempt so a transient hiccup retries on a later sweep
  //     instead of silently costing the file its one-liners until its content
  //     changes. Skipped when the file summary was policy-blocked: this
  //     prompt carries the same content, so it would just burn another
  //     refused request.
  if (!blockedByPolicy && file.kind === 'code' && deps.model && content?.trim()) {
    if (
      store.symbolSummariesFor(file.path, file.hash).size === 0 &&
      store.symbolSummaryAttempts(file.hash) < MAX_ENRICH_ATTEMPTS
    ) {
      const all = store.symbolsForFile(file.path);
      // Top-level symbols first; methods fill any remaining budget.
      const picked = [...all.filter((s) => !s.parent), ...all.filter((s) => s.parent)].slice(
        0,
        SYMBOL_SUMMARY_CAP,
      );
      if (picked.length > 0) {
        let raw = '';
        let completion: ResolvedEnrichCompletion | undefined;
        try {
          completion = resolveEnrichCompletion(
            await deps.summarize(
              buildSymbolSummaryPrompt(file, content, picked),
              `Indexing ${file.path}`,
            ),
            deps,
          );
          raw = completion.text;
        } catch {
          raw = '';
        }
        const entries = parseSymbolSummaryJson(raw, new Set(picked.map((s) => s.name)));
        if (entries.length > 0) {
          store.putSymbolSummaries(
            file.path,
            file.hash,
            entries,
            completion?.model ?? deps.model,
            completion?.provenance,
          );
        } else {
          store.markSymbolSummaryAttempt(file.hash);
        }
      }
    }
  }

  // 2. Ensure embeddable chunks. Docs already have section chunks (Phase 2);
  //    code/text get a single chunk built from the summary + symbol signatures
  //    (works even without an LLM).
  const chunks = ensureEmbeddableChunks(store, file, summary, content);

  // 3. Embed chunks → vec_text.
  if (chunks.length > 0 && store.vecAvailable) {
    try {
      const vectors = await deps.embed(chunks.map((c) => c.text));
      for (let i = 0; i < chunks.length; i++) {
        const v = vectors[i];
        if (v) {
          store.addTextVector(chunks[i]!.id, v);
          result.embedded++;
        }
      }
    } catch {
      /* embeddings unavailable — leave FTS to carry search */
    }
  }

  // Gate semantics: a configured summarizer that produced nothing is treated
  // as a transient failure (engine down, timeout, OOM) — record a capped
  // attempt so the file retries on a later sweep instead of being silently
  // skipped forever (the old unconditional markEnriched defect). Installs with
  // no local model consume the gate as before: there is nothing to retry, and
  // embeddings-only coverage is the intended steady state there.
  const summaryFailed = !result.summarized && Boolean(deps.model) && Boolean(content?.trim());
  if (summaryFailed) {
    if (blockedByPolicy) {
      // Deterministic refusal with no fallback engine — retrying the same
      // content is pure waste, so consume the whole attempt budget at once.
      store.markEnrichSkipped(file.hash);
      log.warn(
        `skipping ${file.path}: the provider blocked its content (policy filter) — it stays unsummarized until its content changes`,
      );
    } else {
      const attempts = store.markEnrichAttempt(file.hash);
      if (attempts >= MAX_ENRICH_ATTEMPTS) {
        log.warn(
          `giving up on ${file.path} after ${attempts} failed summarize attempts — it stays unsummarized until its content changes`,
        );
      } else {
        log.warn(
          `summarize produced nothing for ${file.path} (attempt ${attempts}/${MAX_ENRICH_ATTEMPTS})`,
        );
      }
    }
  } else {
    store.markEnriched(file.hash);
  }
  return result;
}
