import { type CraftbookBasedOn, type CraftbookSuggestion, createLogger } from '@bendyline/gezel';
import type { CatalogService } from '@bendyline/gezel-catalog';
import type { Store } from '../fs/store.js';
import { scoreCandidate } from '../gezels/match.js';
import {
  EmbeddingsDisabledError,
  embed as defaultEmbed,
  embedBatch as defaultEmbedBatch,
} from '../memory/embeddings.js';
import { type ProjectGitStatusReader, listApplicableCraftbooks } from './applicable.js';

const log = createLogger('craftbook');

/**
 * Ranked craftbook selection — the entry point that turns "100s of books"
 * into a top-K shortlist a small-model voorman can actually choose from.
 *
 * Scoring is a hybrid: a semantic cosine (the local all-MiniLM embedding
 * stack, reused from memory recall) carries most of the weight, with a
 * lexical token/alias overlap (reused from gezel `ensureGezel` matching)
 * as a secondary exact-term boost. The semantic half is what lets "make a
 * space shooter" find a "build an arcade game" book that shares no words.
 *
 * Embeddings are best-effort: when the native pipeline is unavailable
 * (`EmbeddingsDisabledError`, e.g. the local model runtime is unavailable) we fall back to
 * pure lexical ranking rather than failing — a degraded shortlist still
 * beats a 100-item dump.
 */

export type CraftbookSource = 'bundled' | 'local' | 'project';

export interface CraftbookCandidate {
  id: string;
  name: string;
  description?: string;
  /** Bundled-only: manifest tags. */
  tags?: string[];
  /** Bundled-only: user-speech trigger phrases. */
  triggers?: string[];
  source: CraftbookSource;
  version?: string;
  basedOn?: CraftbookBasedOn;
  stepCount: number;
}

// `CraftbookSuggestion` (the ranked-row wire type) lives in core so the
// client and MCP layer share the contract. A candidate is the same shape
// minus the relevance fields the ranker adds.
export type { CraftbookSuggestion };

interface CraftbookSuggestionDeps {
  catalog: CatalogService;
  store: Store;
  git?: ProjectGitStatusReader;
}

interface Embedder {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
}

const defaultEmbedder: Embedder = { embed: defaultEmbed, embedBatch: defaultEmbedBatch };

const W_EMBED = 0.7;
const W_TOKEN = 0.3;
const DEFAULT_TOP_K = 5;
// Blended-score floor: drops clearly-irrelevant books but stays low so a
// modest-but-best match still surfaces. The shortlist is small either way.
const DEFAULT_MIN_SCORE = 0.15;
// Lexical-only floor for embeddings-less mode. The lexical token-overlap
// scale tops out far lower than the blended scale: calibrated
// against the 203-book catalog, correct top-1 matches for obvious build
// briefs land at 0.13-0.25 (tic-tac-toe→board-game-web 0.129,
// multi-screen arcade→game-with-screens 0.250, bookstore→rest-api 0.216).
// The old flat 0.15 silently emptied the shortlist on every
// embeddings-less install — which made the meester macros' craftbook pin
// a no-op and left every kickoff task gate-less (wild-caught: zero gate
// firings across two full 56-trial eval baselines).
const DEFAULT_MIN_SCORE_LEXICAL = 0.04;
// Omni-search suggestions should be rarer than a dedicated craftbook lookup:
// the user asked for knowledge, so a merely-best procedure is distracting.
// An exact lexical signal can independently qualify a book when embeddings
// are absent or unhelpful.
const SEARCH_MIN_BLEND_SCORE = 0.28;
const SEARCH_MIN_LEXICAL_SCORE = 0.08;
const SEARCH_MAX_SUGGESTIONS = 2;

/**
 * Production vector cache keyed by `id@version`. Bundled books bump their
 * version on edit, so a stale entry can't outlive its text. Only the
 * default (real) embedder reads/writes it; an injected embedder (tests)
 * bypasses the cache so fixtures never contaminate the live model's
 * vectors.
 */
const vectorCache = new Map<string, number[]>();

/**
 * A live gilde activation can change a book's text under an `id@version`
 * key this process has already embedded — the version-bump assumption above
 * only holds within one content snapshot. Called on content-root flips.
 */
export function clearCraftbookSuggestVectorCache(): void {
  vectorCache.clear();
}

export interface RankOptions {
  topK?: number;
  minScore?: number;
  /** Test seam — defaults to the real local embedding pipeline. */
  embedder?: Embedder;
}

/**
 * Rank a fixed candidate set against a free-text query, returning the
 * top-K above `minScore`. Pure relative to its inputs (modulo the shared
 * vector cache for the default embedder).
 */
export async function rankCraftbookSuggestions(
  query: string,
  candidates: CraftbookCandidate[],
  opts: RankOptions = {},
): Promise<CraftbookSuggestion[]> {
  const topK = opts.topK ?? DEFAULT_TOP_K;
  if (candidates.length === 0 || !query.trim()) return [];

  const lexical = new Map<string, number>();
  for (const c of candidates) {
    lexical.set(
      c.id,
      scoreCandidate(query, { id: c.id, name: c.name, tags: c.tags, description: c.description })
        .score,
    );
  }

  const semantic = await computeSemantic(query, candidates, opts.embedder);
  // Scale-aware floor: blended vs lexical-only scores live on different
  // scales (see DEFAULT_MIN_SCORE_LEXICAL).
  const minScore = opts.minScore ?? (semantic ? DEFAULT_MIN_SCORE : DEFAULT_MIN_SCORE_LEXICAL);

  const ranked: CraftbookSuggestion[] = candidates.map((c) => {
    const lex = lexical.get(c.id) ?? 0;
    const sem = semantic?.get(c.id);
    const score = sem !== undefined ? W_EMBED * sem + W_TOKEN * lex : lex;
    return {
      ...c,
      score,
      ...(sem !== undefined ? { semantic: sem } : {}),
      lexical: lex,
    };
  });
  ranked.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.id.localeCompare(b.id)));
  return ranked.filter((r) => r.score >= minScore).slice(0, topK);
}

async function computeSemantic(
  query: string,
  candidates: CraftbookCandidate[],
  embedder?: Embedder,
): Promise<Map<string, number> | null> {
  const useCache = !embedder;
  const e = embedder ?? defaultEmbedder;
  try {
    const qVec = await e.embed(query);
    const vecById = new Map<string, number[]>();
    const need: { id: string; key: string; text: string }[] = [];
    for (const c of candidates) {
      const key = `${c.id}@${c.version ?? '0'}`;
      const cached = useCache ? vectorCache.get(key) : undefined;
      if (cached) vecById.set(c.id, cached);
      else need.push({ id: c.id, key, text: candidateText(c) });
    }
    if (need.length > 0) {
      const vecs = await e.embedBatch(need.map((n) => n.text));
      need.forEach((n, i) => {
        const v = vecs[i];
        if (!v) return;
        vecById.set(n.id, v);
        if (useCache) vectorCache.set(n.key, v);
      });
    }
    const out = new Map<string, number>();
    for (const c of candidates) {
      const v = vecById.get(c.id);
      if (v) out.set(c.id, clamp01(cosine(qVec, v)));
    }
    return out;
  } catch (err) {
    if (!(err instanceof EmbeddingsDisabledError)) {
      log.warn(
        '[craftbook] semantic suggest failed; falling back to lexical:',
        err instanceof Error ? err.message : err,
      );
    }
    return null;
  }
}

function candidateText(c: CraftbookCandidate): string {
  return [c.name, c.description ?? '', (c.tags ?? []).join(' '), (c.triggers ?? []).join(' ')]
    .filter((s) => s.trim().length > 0)
    .join('. ');
}

/** Vectors from `embed()` are L2-normalized, so cosine === dot product. */
function cosine(a: number[], b: number[]): number {
  let dot = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) dot += a[i]! * b[i]!;
  return dot;
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * Gather the applicable craftbook candidates for a project (bundled —
 * requirement-filtered and carrying tags/triggers — plus user-local and
 * project-local books) and rank them against `query`. This is the
 * service-side implementation behind the `suggest_craftbook` MCP tool and
 * the meester's shortlist-and-pin at project creation.
 */
export async function suggestCraftbooks(
  deps: CraftbookSuggestionDeps,
  opts: { projectId?: string; query: string; topK?: number; minScore?: number },
): Promise<CraftbookSuggestion[]> {
  const candidates = await gatherCandidates(deps, opts.projectId);
  return rankCraftbookSuggestions(opts.query, candidates, {
    ...(opts.topK !== undefined ? { topK: opts.topK } : {}),
    ...(opts.minScore !== undefined ? { minScore: opts.minScore } : {}),
  });
}

/**
 * Keep only high-confidence craftbook matches suitable for attaching to a
 * general project search response. The dedicated suggester intentionally uses
 * a lower floor because its caller explicitly asked for a procedure shortlist.
 */
export function usefulCraftbooksForSearch(
  suggestions: CraftbookSuggestion[],
  limit = SEARCH_MAX_SUGGESTIONS,
): CraftbookSuggestion[] {
  return suggestions
    .filter(
      (suggestion) =>
        suggestion.lexical >= SEARCH_MIN_LEXICAL_SCORE ||
        (suggestion.semantic !== undefined && suggestion.score >= SEARCH_MIN_BLEND_SCORE),
    )
    .slice(0, limit);
}

async function gatherCandidates(
  deps: CraftbookSuggestionDeps,
  projectId?: string,
): Promise<CraftbookCandidate[]> {
  const out: CraftbookCandidate[] = [];

  // Project-local books win on id collision, then user-local, then bundled
  // — mirroring the GET /api/craftbooks precedence.
  if (projectId) {
    const proj = await deps.store.listProjectCraftbooks(projectId).catch(() => []);
    for (const s of proj)
      out.push({
        id: s.id,
        name: s.name,
        ...(s.description ? { description: s.description } : {}),
        source: 'project',
        ...(s.version ? { version: s.version } : {}),
        ...(s.basedOn ? { basedOn: s.basedOn } : {}),
        stepCount: s.stepCount,
      });
  }
  const local = await deps.store.listLocalCraftbookTemplates().catch(() => []);
  for (const s of local)
    out.push({
      id: s.id,
      name: s.name,
      ...(s.description ? { description: s.description } : {}),
      source: 'local',
      ...(s.version ? { version: s.version } : {}),
      ...(s.basedOn ? { basedOn: s.basedOn } : {}),
      stepCount: s.stepCount,
    });

  // Bundled comes through `listApplicableCraftbooks`, which both filters by
  // the project's requirement context (no GitHub-only book on a fresh
  // project) and hands back full manifests so we keep tags + triggers.
  const bundled = await listApplicableCraftbooks(deps.catalog, deps.store, projectId ?? '', {
    ...(deps.git ? { git: deps.git } : {}),
  }).catch(() => []);
  for (const it of bundled) {
    if (it.manifest.kind !== 'craftbook-template') continue;
    const m = it.manifest;
    out.push({
      id: m.id,
      name: m.name,
      ...(m.description ? { description: m.description } : {}),
      ...(m.tags ? { tags: m.tags } : {}),
      ...(m.triggers ? { triggers: m.triggers } : {}),
      source: 'bundled',
      ...(m.version ? { version: m.version } : {}),
      ...(m.basedOn ? { basedOn: m.basedOn } : {}),
      stepCount: m.steps.length,
    });
  }

  const seen = new Set<string>();
  const deduped: CraftbookCandidate[] = [];
  for (const c of out) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    deduped.push(c);
  }
  return deduped;
}
