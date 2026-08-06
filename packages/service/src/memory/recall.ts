import { type ChatSession, type GezelConfig, createLogger } from '@bendyline/gezel';
import type { ContentIndex } from '../index-store/content-index.js';
import type { MemoryKind } from './daily-markdown.js';
import { EmbeddingsDisabledError } from './embeddings.js';
import type { MemoryManager } from './manager.js';

const log = createLogger('memory');

export interface RecallHit {
  text: string;
  /** 'workspace' = an index-derived code hit, not a memory (empty `day`). */
  scope: 'gezel' | 'project' | 'workspace';
  day: string;
  /** EFFECTIVE score — post-decay; this is what ranking and filtering used. */
  score: number;
  /** Memory kind; absent on hits from pre-kind corpora → treated as 'fact'. */
  kind?: MemoryKind;
}

const DEFAULT_TOP_K = 4;
const DEFAULT_MIN_SCORE = 0.35;
/** Tighter budget for ollama — their default num_ctx is small. */
const OLLAMA_TOP_K = 3;
/** Cap + floor for index-derived code hits appended after the memory hits. */
const CODE_TOP_K = 3;
const CODE_MIN_SCORE = 0.45;
/**
 * Useful when explicitly read, but noisy as unsolicited prompt recall: their
 * raw JSON/config payload consumes context without orienting the model to the
 * user's actual work. Keep them indexed for search and tool-driven reads.
 */
const WORKSPACE_RECALL_EXCLUDED_BASENAMES = new Set(['package.json', 'tsconfig.json']);

function isEligibleWorkspaceRecallPath(path: string): boolean {
  const basename = path.split(/[\\/]/).at(-1)?.toLowerCase();
  return !basename || !WORKSPACE_RECALL_EXCLUDED_BASENAMES.has(basename);
}

/** Legacy/frozen recall snapshots store the path inside the rendered text. */
function isEligibleWorkspaceRecallHit(hit: RecallHit): boolean {
  if (hit.scope !== 'workspace') return true;
  const path = hit.text.match(/^`(.+):\d+`/)?.[1];
  return !path || isEligibleWorkspaceRecallPath(path);
}

/**
 * e-folding constant (days) for status-kind decay:
 * `effective = score * exp(-age/TAU)`. TAU=7 keeps ~37% of a status
 * note's weight after a week and ~13% after two — with the default
 * minScore (0.35) even a perfect-similarity status ages out of recall
 * after ~7.3 days, matching the intuition that "X is true right now"
 * goes stale within a week or two and aligning with the compactor's
 * default 14-day horizon (stale statuses are discarded there before
 * they'd resurface). Facts/decisions/prefs are durable → no decay.
 */
const STATUS_DECAY_TAU_DAYS = 7;

/**
 * Whole days between a YYYY-MM-DD day stamp and `now` (UTC midnights).
 * Unparseable input → 0, i.e. no decay — the safe fallback.
 */
export function ageInDays(day: string, now: Date): number {
  const parsed = Date.parse(`${day}T00:00:00Z`);
  if (Number.isNaN(parsed)) return 0;
  const nowUtcMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.max(0, Math.round((nowUtcMidnight - parsed) / (24 * 60 * 60 * 1000)));
}

/** Recency-decayed score for 'status' memories; identity for everything else. */
export function decayedScore(score: number, kind: string | undefined, ageDays: number): number {
  if (kind !== 'status') return score;
  return score * Math.exp(-ageDays / STATUS_DECAY_TAU_DAYS);
}

interface RecallArgs {
  gezelId: string;
  projectId: string;
  query: string;
  providerName: ChatSession['providerName'];
  config: GezelConfig;
  memory: MemoryManager;
  /** When set, the project's content index contributes code hits (reusing
   *  the same query embedding — no extra embed). */
  contentIndex?: Pick<ContentIndex, 'searchCode' | 'hasIndex'>;
  /** Injectable embedder (tests). Defaults to the real local model. */
  embedQuery?: (query: string) => Promise<number[]>;
  gezelOptIn?: boolean;
  /** Optional process-wide debug flag. */
  debug?: { isEnabled(): boolean };
  /** Injectable clock for deterministic tests. */
  now?: Date;
}

/**
 * Return the ranked, filtered memory hits for a new session's first user
 * message, or null if recall is disabled / threw.
 *
 * Ranking is by EFFECTIVE score: status-kind hits decay with age (see
 * {@link STATUS_DECAY_TAU_DAYS}) so a fresh status outranks a stale one
 * regardless of raw similarity; durable kinds rank by raw similarity,
 * byte-identical to the pre-decay behavior for kind-less legacy corpora.
 *
 * Precedence for the on/off switch (most-specific first):
 *   1. Per-gezel `autoRecall: false` in frontmatter — hard-off.
 *   2. Per-gezel `autoRecall: true` — hard-on even if global is off.
 *   3. Global `config.autoRecall.enabled` (defaults to true).
 */
export async function runAutoRecall(args: RecallArgs): Promise<RecallHit[] | null> {
  if (args.gezelOptIn === false) return null;
  const globalEnabled = args.config.autoRecall?.enabled !== false;
  if (!globalEnabled && args.gezelOptIn !== true) return null;

  const topK =
    args.config.autoRecall?.topK ?? (args.providerName === 'ollama' ? OLLAMA_TOP_K : DEFAULT_TOP_K);
  const minScore = args.config.autoRecall?.minScore ?? DEFAULT_MIN_SCORE;
  const now = args.now ?? new Date();

  // Embed the query ONCE; the vector serves both memory scopes and the
  // content-index code search (previously each scope embedded separately).
  // The embedder rides on MemoryManager so stubbed managers (tests) skip
  // recall entirely instead of loading the real model.
  const embedFn =
    args.embedQuery ??
    (typeof args.memory.embedQuery === 'function'
      ? args.memory.embedQuery.bind(args.memory)
      : null);
  if (!embedFn) return null;

  // Nothing to search → don't pay the embedder cold-start. A fresh install's
  // very first message has no memory corpora and no content index; embedding
  // inline there would add ~10s of model load to the first turn for zero
  // hits (wild-caught by the chat-events SSE integration test).
  const memoryAvailable =
    typeof args.memory.hasIndex === 'function'
      ? args.memory.hasIndex('gezel', args.gezelId) ||
        args.memory.hasIndex('project', args.projectId)
      : true;
  if (!memoryAvailable) {
    const codeAvailable = (await args.contentIndex?.hasIndex?.(args.projectId)) ?? false;
    if (!codeAvailable) return null;
  }
  let vector: number[];
  try {
    vector = await embedFn(args.query);
  } catch (err) {
    if (err instanceof EmbeddingsDisabledError) return null;
    log.warn('[recall] embed failed:', err instanceof Error ? err.message : err);
    return null;
  }

  const fetchK = Math.max(topK * 2, topK);
  const [gezelResults, projectResults] = await Promise.all([
    args.memory.searchVector('gezel', args.gezelId, vector, fetchK).catch(() => []),
    args.memory.searchVector('project', args.projectId, vector, fetchK).catch(() => []),
  ]);
  const results = [...gezelResults, ...projectResults];

  const ranked = results
    .map((r) => ({
      ...r,
      ageDays: ageInDays(r.day, now),
      effective: decayedScore(r.score, r.kind, ageInDays(r.day, now)),
    }))
    .sort((a, b) => b.effective - a.effective);

  const seen = new Set<string>();
  const hits: RecallHit[] = [];
  for (const r of ranked) {
    if (r.effective < minScore) continue;
    if (seen.has(r.text)) continue;
    seen.add(r.text);
    hits.push({
      text: r.text,
      scope: r.scope as 'gezel' | 'project',
      day: r.day,
      score: r.effective,
      ...(r.kind ? { kind: r.kind } : {}),
    });
    if (hits.length >= topK) break;
  }

  // Index-derived code hits ride AFTER the memories: "where is this in the
  // workspace" orientation for the same first message, same query vector.
  if (args.contentIndex) {
    try {
      const code = await args.contentIndex.searchCode(args.projectId, args.query, {
        queryVector: vector,
        // Fetch beyond the render cap so excluded manifest/config hits do not
        // crowd useful source or document results out of the prompt.
        maxResults: CODE_TOP_K * 4,
      });
      const seenPaths = new Set<string>();
      let added = 0;
      for (const r of code.results) {
        if (r.score < CODE_MIN_SCORE) continue;
        if (!isEligibleWorkspaceRecallPath(r.path)) continue;
        if (seenPaths.has(r.path)) continue;
        seenPaths.add(r.path);
        const snippet = r.snippet.replace(/\s+/g, ' ').trim().slice(0, 160);
        hits.push({
          text: `\`${r.path}:${r.lineStart}\` — ${snippet}`,
          scope: 'workspace',
          day: '',
          score: r.score,
        });
        if (++added >= CODE_TOP_K) break;
      }
    } catch (err) {
      log.warn('[recall] code search failed:', err instanceof Error ? err.message : err);
    }
  }
  if (args.debug?.isEnabled()) {
    log.info(
      `[recall] query="${args.query.slice(0, 80)}" → ${hits.length} hit(s) ` +
        `(minScore=${minScore}, topK=${topK}, raw results=${results.length})`,
    );
    for (const h of hits) {
      const preview = h.text.length > 120 ? `${h.text.slice(0, 120)}…` : h.text;
      const age = ageInDays(h.day, now);
      log.info(
        `[recall] · [${h.scope}/${h.day} ${h.kind ?? 'fact'} age=${age}d] eff=${h.score.toFixed(2)} — ${preview}`,
      );
    }
  }
  return hits;
}

function agePhrase(ageDays: number): string {
  if (ageDays <= 0) return 'today';
  if (ageDays === 1) return '1 day ago';
  return `${ageDays} days ago`;
}

/**
 * Render the recall block that gets appended to the system prompt. Kept
 * short and factual — we're hinting the model, not dumping a transcript.
 *
 * Status hits get their temporality spelled out as prose ("As of <day>
 * (<N> days ago): …") — models respond to tense and explicit age far
 * better than to a metadata tag. Because the snapshot hits are
 * re-rendered on every prompt rebuild, the age phrase self-refreshes as
 * a session spans days.
 */
export function renderRecallBlock(hits: RecallHit[], now: Date = new Date()): string {
  const eligibleHits = hits.filter(isEligibleWorkspaceRecallHit);
  if (eligibleHits.length === 0) return '';
  const lines = eligibleHits
    .map((h) => {
      if (h.scope === 'workspace') return `- [workspace] ${h.text}`;
      if (h.kind === 'status') {
        return `- [${h.scope}/${h.day}] As of ${h.day} (${agePhrase(ageInDays(h.day, now))}): ${h.text}`;
      }
      return `- [${h.scope}/${h.day}] ${h.text}`;
    })
    .join('\n');
  return `\n\n### Recalled from prior sessions\n\nHints from earlier work — these are informational, not authoritative. Use them to avoid re-asking the user things they've already told the team:\n\n${lines}`;
}
