import type { HistoryEvent, HistoryFilter } from '@bendyline/gezel';
import { globalIndexDbFile } from '@bendyline/gezel/paths';
import { type CollectionKind, IndexStore } from './index-store.js';

/**
 * Read facade over the home-scoped `~/.gezel/index/global.db` — the first
 * non-project index db. Hosts three collections mirrored from plain-file
 * sources of truth (session JSON, history JSONL, the documents library) by
 * GlobalIndexManager, the db's single writer. Readers open per call (WAL
 * permits concurrent readers while the manager writes) and degrade to
 * empty/null results when sqlite is unavailable, matching ContentIndex.
 */

export type GlobalCollectionId = 'sessions' | 'history' | 'documents';

/** Set once the first history JSONL backfill completes; until then
 *  searchHistory returns null so callers keep the full-scan fallback. */
export const HISTORY_BACKFILL_META_KEY = 'history_backfilled_at';

/** Records which documents root the collection was built from, so an
 *  externalized-folder move invalidates the whole collection. */
export const DOCUMENTS_ROOT_META_KEY = 'documents_root';

export interface SessionSearchHit {
  sessionId: string;
  gezelId: string;
  projectId: string;
  title: string;
  snippet: string;
  /** 1-based index of the first message in the matched transcript chunk. */
  messageStart: number;
  lastActivityAt: string;
  archived: boolean;
}

export interface DocumentSearchHit {
  path: string;
  lineStart: number;
  snippet: string;
}

export interface GlobalIndexStatus {
  available: boolean;
  sessions: number;
  history: number;
  historyBackfilledAt: string | null;
  documents: number;
}

export async function openGlobalCollection(
  home: string,
  collection: GlobalCollectionId,
): Promise<IndexStore | null> {
  return IndexStore.open(globalIndexDbFile(home), {
    collectionId: collection,
    kind: collection as CollectionKind,
    rootPath: home,
  });
}

export class GlobalIndex {
  constructor(private readonly home: string) {}

  async searchSessions(
    q: string,
    opts: { gezelId?: string; projectId?: string; maxResults?: number } = {},
  ): Promise<SessionSearchHit[]> {
    const index = await openGlobalCollection(this.home, 'sessions');
    if (!index) return [];
    try {
      const max = opts.maxResults ?? 20;
      // Overfetch: multiple chunks of one session can match, and gezel/project
      // filters are applied post-query from metadata.
      const hits = index.searchDocs(q, Math.max(max * 4, 40));
      const out: SessionSearchHit[] = [];
      const seen = new Set<string>();
      for (const hit of hits) {
        if (seen.has(hit.filePath)) continue;
        const meta = index.getMetadata(hit.filePath);
        const slash = hit.filePath.indexOf('/');
        const gezelId = meta.gezelId ?? (slash > 0 ? hit.filePath.slice(0, slash) : '');
        const sessionId = meta.sessionId ?? hit.filePath.slice(slash + 1);
        if (opts.gezelId && gezelId !== opts.gezelId) continue;
        if (opts.projectId && meta.projectId !== opts.projectId) continue;
        seen.add(hit.filePath);
        out.push({
          sessionId,
          gezelId,
          projectId: meta.projectId ?? '',
          title: meta.title ?? '',
          snippet: hit.snippet,
          messageStart: hit.lineStart,
          lastActivityAt: meta.lastActivityAt ?? '',
          archived: meta.archived === '1',
        });
        if (out.length >= max) break;
      }
      return out;
    } finally {
      index.close();
    }
  }

  /**
   * FTS-backed history query, or null when the mirror can't answer (sqlite
   * unavailable, backfill never completed, or q set without FTS) — the caller
   * falls back to the JSONL scan.
   */
  async searchHistory(filter: HistoryFilter = {}): Promise<HistoryEvent[] | null> {
    const index = await openGlobalCollection(this.home, 'history');
    if (!index) return null;
    try {
      if (!index.getMeta(HISTORY_BACKFILL_META_KEY)) return null;
      return index.searchHistory(filter);
    } finally {
      index.close();
    }
  }

  async searchDocuments(q: string, maxResults = 20): Promise<DocumentSearchHit[]> {
    const index = await openGlobalCollection(this.home, 'documents');
    if (!index) return [];
    try {
      return index.searchDocs(q, maxResults).map((hit) => ({
        path: hit.filePath,
        lineStart: hit.lineStart,
        snippet: hit.snippet,
      }));
    } finally {
      index.close();
    }
  }

  async status(): Promise<GlobalIndexStatus> {
    const empty: GlobalIndexStatus = {
      available: false,
      sessions: 0,
      history: 0,
      historyBackfilledAt: null,
      documents: 0,
    };
    const sessions = await openGlobalCollection(this.home, 'sessions');
    if (!sessions) return empty;
    let sessionCount: number;
    try {
      sessionCount = sessions.fileCount();
    } finally {
      sessions.close();
    }
    const history = await openGlobalCollection(this.home, 'history');
    let historyCount = 0;
    let backfilledAt: string | null = null;
    if (history) {
      try {
        historyCount = history.historyCount();
        backfilledAt = history.getMeta(HISTORY_BACKFILL_META_KEY) ?? null;
      } finally {
        history.close();
      }
    }
    const documents = await openGlobalCollection(this.home, 'documents');
    let documentCount = 0;
    if (documents) {
      try {
        documentCount = documents.fileCount();
      } finally {
        documents.close();
      }
    }
    return {
      available: true,
      sessions: sessionCount,
      history: historyCount,
      historyBackfilledAt: backfilledAt,
      documents: documentCount,
    };
  }
}
