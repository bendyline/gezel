import {
  type ChatMessage,
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
 * Never throws and never holds a launch longer than the search budget; the
 * embedders are not waited for (keyword arms answer while they are cold).
 */
export async function gatherTaskReferences(args: {
  search: Pick<SearchService, 'searchProject'>;
  projectId: string;
  subject: string;
  craftbookName: string;
}): Promise<TaskReferences | null> {
  const bookTokens = new Set(tokenizeText(args.craftbookName));
  const terms = proactiveRetrievalTerms(args.subject).filter((term) => !bookTokens.has(term));
  if (terms.length === 0) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const found = await Promise.race([
      args.search.searchProject(args.subject.slice(0, REFERENCE_QUERY_CHARS), {
        projectIds: [args.projectId],
        sources: ['knowledge', 'shared'],
        includeShared: true,
        maxResults: REFERENCE_SEARCH_RESULTS,
        skipColdEmbedder: true,
      }),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), REFERENCE_SEARCH_BUDGET_MS);
      }),
    ]);
    if (!found) {
      log.info(
        `[tasks] reference search for ${JSON.stringify(args.subject)} missed its ${REFERENCE_SEARCH_BUDGET_MS}ms budget; launching without references`,
      );
      return null;
    }
    const items: TaskReference[] = [];
    const seen = new Set<string>();
    for (const result of found.results) {
      const item = toReference(result);
      if (!item) continue;
      const grounding = `${item.title} ${item.path ?? ''} ${result.snippet ?? ''}`;
      if (!textMatchesAnyTerm(grounding, terms)) continue;
      const key = `${item.source}:${(item.uri ?? item.path ?? '').replace(/#.*$/, '')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(item);
      if (items.length >= TASK_REFERENCE_LIMITS.items) break;
    }
    log.info(
      `[tasks] references subject=${JSON.stringify(args.subject)} terms=${terms.join(',')} searched=${found.results.length} kept=${items.length}${found.sourcesIncomplete ? ' (some sources timed out)' : ''}`,
    );
    if (items.length === 0) return null;
    return { subject: args.subject, gatheredAt: new Date().toISOString(), items };
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
