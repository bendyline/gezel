import { readFile } from 'node:fs/promises';
import { GEZEL_VERSION, type GezelSummary, type ProviderName } from '@bendyline/gezel';
import type { ChatManager } from '../chat/manager.js';
import { safeJoin } from '../fs/safe-paths.js';
import type { Store } from '../fs/store.js';
import { shadowDocFilesPaths } from './docs.js';
import { parseFrontmatter } from './frontmatter.js';
import type { FileRecord, IndexProvenance, IndexStore } from './index-store.js';

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

export interface EnrichDeps {
  summarize: (prompt: string) => Promise<string>;
  embed: (texts: string[]) => Promise<number[][]>;
  model?: string;
  /**
   * The review-pass completion (cliffs notes + issues + health). Same local
   * model as `summarize` but a longer timeout — reviews emit materially more
   * output tokens than a 2-3 sentence summary. Absent when no local model is
   * configured; the review pass skips entirely then.
   */
  review?: (prompt: string) => Promise<string>;
  /**
   * Stamped onto every row this deps object writes. Built once in
   * `buildEnrichDeps` from the SAME resolved target that builds the
   * completions, so it reflects reality (env overrides, Night Shift) —
   * output-only, never a routing input.
   */
  provenance?: IndexProvenance;
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
 * Resolve the local-first model used by autonomous indexing work. A cloud
 * target is accepted only through the explicit Night Shift override.
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
  // A Boekwachter may pin their own small local model. Never silently send
  // workspace indexing to a cloud provider: cloud use remains an explicit
  // Night Shift override, while the gezel's about.md still supplies the
  // personality on whichever local engine is selected.
  if (
    (!providerName || !model) &&
    opts.boekwachter?.provider &&
    ENRICH_LOCAL_PROVIDERS.includes(opts.boekwachter.provider) &&
    opts.boekwachter.model
  ) {
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
 * Resolve a summarizer (if one is configured) + the local embedder — shared
 * by the background enrichment loop and the on-demand drive route. During
 * Night Shift an enabled provider/model override wins; otherwise the
 * summarizer is the first configured local provider's default model.
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
  const provenance: IndexProvenance = {
    provider: providerName,
    ...(opts.boekwachter ? { gezelId: opts.boekwachter.id, gezelName: opts.boekwachter.name } : {}),
    appVersion: GEZEL_VERSION,
  };
  const summarize = (prompt: string) =>
    chat
      .oneShotCompletion(prompt, 30_000, {
        providerName,
        model,
        ...(opts.boekwachter
          ? {
              gezelId: opts.boekwachter.id,
              useGezelPersona: true,
              actorLabel: opts.boekwachter.name,
            }
          : { actorLabel: 'Boekwachter' }),
        jobLabel: 'index enrichment',
        ...(opts.ambient ? { ambient: true } : {}),
      })
      .catch(() => '');
  const review = (prompt: string) =>
    chat
      .oneShotCompletion(prompt, 60_000, {
        providerName,
        model,
        ...(opts.boekwachter
          ? {
              gezelId: opts.boekwachter.id,
              useGezelPersona: true,
              actorLabel: opts.boekwachter.name,
            }
          : { actorLabel: 'Boekwachter' }),
        jobLabel: 'index review',
        ...(opts.ambient ? { ambient: true } : {}),
      })
      .catch(() => '');
  return { summarize, embed, model, review, provenance };
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
  if (summary) {
    result.summarized = true;
  } else if (content?.trim()) {
    try {
      summary = (await deps.summarize(buildSummaryPrompt(file, content))).trim();
    } catch {
      summary = '';
    }
    if (summary) {
      store.upsertSummary({
        contentHash: file.hash,
        filePath: file.path,
        summaryMd: summary,
        model: deps.model ?? 'unknown',
        ...(deps.provenance ? { provenance: deps.provenance } : {}),
      });
      result.summarized = true;
    }
  }

  // 1b. Per-symbol one-liners (code only, LLM configured, not yet covered for
  //     this hash). One batched call per file; a parse failure stores nothing
  //     and is not retried for this hash — same semantics as the file summary.
  if (file.kind === 'code' && deps.model && content?.trim()) {
    if (store.symbolSummariesFor(file.path, file.hash).size === 0) {
      const all = store.symbolsForFile(file.path);
      // Top-level symbols first; methods fill any remaining budget.
      const picked = [...all.filter((s) => !s.parent), ...all.filter((s) => s.parent)].slice(
        0,
        SYMBOL_SUMMARY_CAP,
      );
      if (picked.length > 0) {
        let raw = '';
        try {
          raw = await deps.summarize(buildSymbolSummaryPrompt(file, content, picked));
        } catch {
          raw = '';
        }
        const entries = parseSymbolSummaryJson(raw, new Set(picked.map((s) => s.name)));
        if (entries.length > 0) {
          store.putSymbolSummaries(file.path, file.hash, entries, deps.model, deps.provenance);
        }
      }
    }
  }

  // 2. Ensure embeddable chunks. Docs already have section chunks (Phase 2);
  //    code/text get a single chunk built from the summary + symbol signatures
  //    (works even without an LLM).
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
  } else if (summary) {
    // Prepend a summary chunk for docs so the file-level gist is searchable too.
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
  if (summaryFailed) store.markEnrichAttempt(file.hash);
  else store.markEnriched(file.hash);
  return result;
}
