import { createHash } from 'node:crypto';
import {
  type ChatMessage,
  type RelevanceModelOverride,
  type RetrievalDecisionTrace,
  TASK_REFERENCE_LIMITS,
  type TaskReference,
  type TaskReferences,
  type UnifiedSearchResult,
  createLogger,
} from '@bendyline/gezel';
import {
  proactiveRetrievalTerms,
  textMatchesAnyTerm,
  tokenizeText,
} from '../index-store/query-terms.js';
import { relevanceSummary } from '../search/relevance-stage.js';
import { RetrievalTraceBuilder } from '../search/retrieval-trace.js';
import type { SearchService } from '../search/search-service.js';

const log = createLogger('tasks');

/** Search depth before grounding trims the list to TASK_REFERENCE_LIMITS.items. */
const REFERENCE_SEARCH_RESULTS = 20;
/** A launch never waits longer than this on the reference search. */
const REFERENCE_SEARCH_BUDGET_MS = 1_500;
/** Longest subject sent as the search query. */
const REFERENCE_QUERY_CHARS = 400;

/**
 * Search the reference corpora — installed knowledge catalogs and the shared
 * library — once for a craftbook task's subject, at launch. The result is
 * frozen on the task and rendered into every step's prompt, so it keeps only
 * entries whose title or snippet actually names the subject: a vector-only
 * neighbour ("QuEChERS" for "quiche") earns one noisy turn under per-turn
 * retrieval, but here it would ride every step of the run.
 *
 * Words from the book's own name are not subject terms. A subject filled
 * from the whole request ("Can you create a PowerPoint about quiche") would
 * otherwise ground any library document that mentions PowerPoint.
 *
 * With a relevance model on, a candidate a calibrated model scored is kept
 * or dropped on that score alone; the lexical rule judges the rest. The
 * model is asked about the subject's terms, not the whole request, for the
 * same reason the book's name is not a subject term.
 *
 * Never throws and never holds a launch longer than the search budget (plus
 * the model's, when one is on); the embedders are not waited for (keyword
 * arms answer while they are cold).
 */
export async function gatherTaskReferences(args: {
  search: Pick<SearchService, 'searchProject'> & Partial<Pick<SearchService, 'relevanceFor'>>;
  projectId: string;
  subject: string;
  craftbookName: string;
  /** Retrieval preview only: this relevance-model arm instead of the resolved setting. */
  relevanceOverride?: RelevanceModelOverride;
  /** One decision per candidate, once the search ran (or missed its budget). */
  onDecisionTrace?: (trace: RetrievalDecisionTrace) => void;
}): Promise<TaskReferences | null> {
  const bookTokens = new Set(tokenizeText(args.craftbookName));
  const terms = proactiveRetrievalTerms(args.subject).filter((term) => !bookTokens.has(term));
  if (terms.length === 0) return null;
  const trace = new RetrievalTraceBuilder('references', subjectHash(args.subject));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const started = performance.now();
  try {
    const relevance =
      (await args.search.relevanceFor?.('references', args.relevanceOverride)) ?? null;
    const budgetMs = REFERENCE_SEARCH_BUDGET_MS + (relevance?.budgetMs ?? 0);
    const found = await Promise.race([
      args.search.searchProject(args.subject.slice(0, REFERENCE_QUERY_CHARS), {
        projectIds: [args.projectId],
        sources: ['knowledge', 'shared'],
        includeShared: true,
        maxResults: REFERENCE_SEARCH_RESULTS,
        skipColdEmbedder: true,
        ...(relevance
          ? {
              relevance: {
                surface: 'references' as const,
                mode: 'filter' as const,
                query: terms.join(' '),
                active: relevance,
              },
            }
          : {}),
      }),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), budgetMs);
      }),
    ]);
    if (!found) {
      log.info(
        `[tasks] reference search for ${JSON.stringify(args.subject)} missed its ${budgetMs}ms budget; launching without references`,
      );
      args.onDecisionTrace?.(trace.finish({ timedOut: true }));
      return null;
    }
    const stage = found.relevance?.applied ? found.relevance : undefined;
    const scores = stage?.scores ?? new Map<string, number>();
    const judged = (result: UnifiedSearchResult) =>
      stage?.calibrated === true && scores.has(result.id);
    trace.addAll(stage?.fused ?? found.results);
    if (stage) {
      trace.scored(scores);
      for (const result of stage.hidden) trace.reject(result, 'relevance-model');
    }
    let judgedKept = 0;
    const items: TaskReference[] = [];
    const seen = new Set<string>();
    for (const result of found.results) {
      if (items.length >= TASK_REFERENCE_LIMITS.items) {
        trace.reject(result, 'reference-limit');
        continue;
      }
      const item = toReference(result);
      if (!item) {
        trace.reject(result, 'source-policy');
        continue;
      }
      const grounding = `${item.title} ${item.path ?? ''} ${result.snippet ?? ''}`;
      if (!judged(result) && !textMatchesAnyTerm(grounding, terms)) {
        trace.reject(result, 'lexical');
        continue;
      }
      const key = `${item.source}:${(item.uri ?? item.path ?? '').replace(/#.*$/, '')}`;
      if (seen.has(key)) {
        trace.reject(result, 'duplicate-path');
        continue;
      }
      seen.add(key);
      trace.keep(result);
      items.push(item);
      if (judged(result)) judgedKept++;
    }
    trace.rejectRemaining('depth');
    const decided = trace.finish({
      ...(found.sourcesIncomplete ? { sourcesIncomplete: true } : {}),
      ...(found.relevance ? { relevanceModel: relevanceSummary(found.relevance) } : {}),
    });
    args.onDecisionTrace?.(decided);
    log.info(
      `[tasks] references subject=${JSON.stringify(args.subject)} terms=${terms.join(',')} searched=${found.results.length} kept=${items.length}${found.relevance ? ` relevance=${found.relevance.status}` : ''}${found.sourcesIncomplete ? ' (some sources timed out)' : ''}`,
    );
    if (items.length === 0) return null;
    const rejected = Object.fromEntries(
      Object.entries(decided.counts).filter(([reason]) => reason !== 'kept'),
    );
    return {
      subject: args.subject,
      gatheredAt: new Date().toISOString(),
      items,
      selection: {
        method:
          judgedKept === 0 ? 'lexical' : judgedKept === items.length ? 'relevance-model' : 'mixed',
        ...(found.relevance
          ? { modelId: found.relevance.modelId, modelStatus: found.relevance.status }
          : {}),
        candidates: (stage?.fused ?? found.results).length,
        rejected,
        ms: Math.round(performance.now() - started),
      },
    };
  } catch (err) {
    log.warn(
      `[tasks] reference search failed; launching without references: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function toReference(result: UnifiedSearchResult): TaskReference | null {
  const title = clamp(result.title, TASK_REFERENCE_LIMITS.titleChars);
  if (!title) return null;
  const snippet = result.snippet ? clamp(result.snippet, TASK_REFERENCE_LIMITS.snippetChars) : '';
  const shared = { title, ...(snippet ? { snippet } : {}) };
  if (result.retrievalSource === 'knowledge' && result.uri) {
    return {
      source: 'knowledge',
      ...shared,
      uri: result.uri,
      ...(result.catalogId ? { catalogId: result.catalogId } : {}),
      ...(result.catalogVersion ? { catalogVersion: result.catalogVersion } : {}),
    };
  }
  if (result.retrievalSource === 'shared' && result.path) {
    return { source: 'shared', ...shared, path: result.path };
  }
  return null;
}

function clamp(text: string, max: number): string {
  const value = text.replace(/\s+/g, ' ').trim();
  return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;
}

/**
 * A launch's reference list in the shape the chat bubble's "Consulted
 * indexed sources" disclosure reads, so the thread a person launched from
 * shows what the task started with. No top-level `injectedBytes`: nothing
 * was injected into that thread's turn — each snippet is what every step's
 * prompt carries.
 */
export function taskReferencesAsRetrieval(
  references: TaskReferences | undefined,
): ChatMessage['retrieval'] {
  if (!references || references.items.length === 0) return undefined;
  const count = references.items.length;
  return {
    hits: references.items.map((item, index) => ({
      source: item.source,
      ...(item.path ? { path: item.path } : {}),
      ...(item.uri ? { uri: item.uri } : {}),
      title: item.title,
      ...(item.catalogId ? { catalogId: item.catalogId } : {}),
      ...(item.catalogVersion ? { catalogVersion: item.catalogVersion } : {}),
      // Search order is all that was kept; the bubble never shows a score.
      score: count - index,
      ...(item.snippet ? { injectedText: item.snippet } : {}),
    })),
  };
}

/**
 * The reference list as `task.created` history details: citations and
 * counts, never the subject or snippet text (telemetry carries no retrieved
 * text — see docs/project-retrieval.md). The subject is a hash, so evals can
 * group launches without the log holding what a person asked about.
 */
export function referencesHistoryDetails(references: TaskReferences): Record<string, unknown> {
  const bySource: Record<string, number> = {};
  for (const item of references.items) bySource[item.source] = (bySource[item.source] ?? 0) + 1;
  return {
    subjectHash: subjectHash(references.subject),
    kept: references.items.length,
    bySource,
    ...(references.selection ? { selection: references.selection } : {}),
    citations: references.items.map((item) =>
      item.uri ? item.uri.replace(/#.*$/, '') : `shared:${item.path ?? ''}`,
    ),
  };
}

function subjectHash(subject: string): string {
  return createHash('sha256').update(subject).digest('hex').slice(0, 16);
}
