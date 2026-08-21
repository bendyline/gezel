import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from '@bendyline/gezel';
import type { Store } from '../fs/store.js';
import { DEFAULT_MEMORY_KIND, type MemoryKind, parseMemoryDay } from './daily-markdown.js';
import {
  type EmbeddingPipelineStatus,
  embed,
  embedQuery,
  embeddingPipelineStatus,
} from './embeddings.js';
import {
  type MemoryEntry,
  type SearchResult,
  addToIndex,
  rebuildIndex,
  searchByVector,
  searchIndex,
} from './vector-index.js';

const log = createLogger('memory');

/**
 * Cosine-similarity floor above which a new memory is considered a duplicate
 * of an existing one and skipped. Measured against the shipped embedder
 * (Xenova/bge-small-en-v1.5, passage↔passage — no query prefix on either
 * side) with `evals/src/bin/embed-calibration.ts` (2026-08-19): genuine
 * restatements of the same fact scored 0.802-0.963 (p25 0.906, so the old
 * MiniLM-era 0.90 let a quarter of true duplicates through), while distinct
 * facts about the same topic topped out at 0.774. 0.85 sits in that gap,
 * biased toward the keep side — a dropped distinct memory is silent data
 * loss; a kept restatement is only clutter. Re-run the harness and re-pick
 * whenever the embedder changes.
 */
export const MEMORY_DEDUP_THRESHOLD = 0.85;

export interface SaveOutcome {
  status: 'saved' | 'duplicate';
  /** False means Markdown is durable and the derived vector cache needs repair. */
  indexed?: boolean;
  degraded?: {
    code: 'semantic_index_unavailable';
    message: string;
  };
  /** Populated on 'duplicate': what it matched and how. */
  match?: { text: string; score: number; via: 'exact' | 'vector' };
}

export type MemorySearchMode = 'semantic' | 'hybrid' | 'lexical';

export interface MemorySearchOutcome {
  results: SearchResult[];
  mode: MemorySearchMode;
  /** Present when a semantic-search failure forced the source-text fallback. */
  degraded?: {
    code: 'semantic_search_unavailable';
    message: string;
  };
}

export interface MemoryManagerOptions {
  /** Override {@link MEMORY_DEDUP_THRESHOLD} (tests). */
  dedupThreshold?: number;
}

export class MemoryManager {
  private readonly dedupThreshold: number;

  constructor(
    private readonly store: Store,
    opts: MemoryManagerOptions = {},
  ) {
    this.dedupThreshold = opts.dedupThreshold ?? MEMORY_DEDUP_THRESHOLD;
  }

  /**
   * Persist a memory unless it duplicates an existing one. Dedup is
   * non-agentic and two-tier: an exact-string check against the last two
   * daily files (works even when embeddings are disabled), then a vector
   * near-duplicate check against the scope's index. On a duplicate NOTHING
   * is written — markdown and index skip together, so the health monitor's
   * count comparison stays valid.
   *
   * Two concurrent saves of the same text can both pass the check and both
   * write; extraction loops are sequential per line and the next save of
   * that text dedups, so we accept the race rather than lock.
   *
   * Degraded mode (embeddings disabled): markdown is still appended (it is
   * the source of truth) and the outcome reports deferred indexing. The health
   * monitor self-heals the derived index once embeddings recover.
   */
  async save(
    scope: 'gezel' | 'project',
    id: string,
    text: string,
    kind: MemoryKind = DEFAULT_MEMORY_KIND,
  ): Promise<SaveOutcome> {
    const trimmed = text.trim();

    const exact = await this.findExactRecent(scope, id, trimmed);
    if (exact) {
      log.info(`[memory] dup-skip (exact) ${scope}/${id}: ${trimmed.slice(0, 60)}`);
      return { status: 'duplicate', match: { text: exact, score: 1, via: 'exact' } };
    }

    const indexDir = this.store.memoryIndexDir(scope, id);
    let vector: number[];
    try {
      vector = await embed(trimmed);
    } catch (err) {
      await this.store.appendMemory(scope, id, trimmed, kind);
      log.warn(
        `[memory] saved ${scope}/${id} to Markdown; semantic indexing deferred: ${describeError(err)}`,
      );
      return deferredIndexOutcome();
    }

    let top: SearchResult | undefined;
    try {
      top = (await searchByVector(indexDir, vector, 1))[0];
    } catch (error) {
      // Near-duplicate detection is an optimization over the derived cache.
      // Exact recent dedup already ran; a broken cache must not block the
      // durable Markdown write.
      log.warn(
        `[memory] vector dedup unavailable for ${scope}/${id}; continuing save: ${describeError(error)}`,
      );
    }
    if (top && top.score >= this.dedupThreshold) {
      log.info(
        `[memory] dup-skip (${top.score.toFixed(2)} vs "${top.text.slice(0, 40)}") ${scope}/${id}: ${trimmed.slice(0, 60)}`,
      );
      return { status: 'duplicate', match: { text: top.text, score: top.score, via: 'vector' } };
    }

    await this.store.appendMemory(scope, id, trimmed, kind);
    try {
      await addToIndex(
        indexDir,
        {
          text: trimmed,
          scope,
          id,
          day: new Date().toISOString().slice(0, 10),
          at: new Date().toISOString(),
          kind,
        },
        vector,
      );
    } catch (error) {
      log.warn(
        `[memory] saved ${scope}/${id} to Markdown; semantic index write deferred: ${describeError(error)}`,
      );
      return deferredIndexOutcome();
    }
    log.info(`[memory] saved ${scope}/${id} [${kind}]: ${trimmed.slice(0, 60)}`);
    return { status: 'saved', indexed: true };
  }

  /**
   * Exact-text match against today's and yesterday's daily files. Two days
   * covers the midnight rollover; the files are small (one day of one
   * scope). Checking markdown rather than the index keeps this path alive
   * when embeddings are disabled and immune to index drift.
   */
  private async findExactRecent(
    scope: 'gezel' | 'project',
    id: string,
    trimmed: string,
  ): Promise<string | null> {
    const now = Date.now();
    for (const offsetMs of [0, 24 * 60 * 60 * 1000]) {
      const day = new Date(now - offsetMs).toISOString().slice(0, 10);
      const content = await this.store.readMemoryDay(scope, id, day);
      if (!content) continue;
      for (const block of parseMemoryDay(content)) {
        if (block.text === trimmed) return block.text;
      }
    }
    return null;
  }

  async search(
    scope: 'gezel' | 'project',
    id: string,
    query: string,
    topK = 10,
  ): Promise<SearchResult[]> {
    const indexDir = this.store.memoryIndexDir(scope, id);
    if (!this.hasIndex(scope, id)) return this.searchLexical(scope, id, query, topK);
    try {
      return await searchIndex(indexDir, query, topK);
    } catch (error) {
      log.warn(
        `[memory] semantic search failed for ${scope}/${id}; using lexical fallback: ${describeError(error)}`,
      );
      return this.searchLexical(scope, id, query, topK);
    }
  }

  /**
   * Like {@link search} but with a precomputed query embedding — lets the
   * cross-project unified search embed once and reuse the vector across many
   * memory scopes instead of paying one embed per scope.
   */
  async searchVector(
    scope: 'gezel' | 'project',
    id: string,
    vector: number[],
    topK = 10,
  ): Promise<SearchResult[]> {
    const indexDir = this.store.memoryIndexDir(scope, id);
    return searchByVector(indexDir, vector, topK);
  }

  /**
   * Embed a query once for reuse across {@link searchVector} scopes and the
   * content index. Lives on the manager (not imported directly by callers)
   * so tests that stub a MemoryManager-shaped object stub the embedding
   * with it — recall degrades to a no-op instead of loading the real model.
   */
  async embedQuery(text: string): Promise<number[]> {
    return embedQuery(text);
  }

  embeddingStatus(): EmbeddingPipelineStatus {
    return embeddingPipelineStatus();
  }

  /**
   * Cheap "does this scope have a vector index on disk?" probe. Recall
   * consults it BEFORE embedding so a fresh install's first message never
   * pays the embedder cold-start for a search that can't hit anything.
   */
  hasIndex(scope: 'gezel' | 'project', id: string): boolean {
    return existsSync(join(this.store.memoryIndexDir(scope, id), 'mem.db'));
  }

  async searchAll(
    gezelId: string,
    projectId: string,
    query: string,
    topK = 10,
  ): Promise<SearchResult[]> {
    return (await this.searchAllDetailed(gezelId, projectId, query, topK)).results;
  }

  /**
   * Search both scopes with one query embedding. Missing indexes fall back to
   * the daily Markdown source; an unavailable/corrupt semantic cache does the
   * same and reports a degraded mode instead of turning an optional feature
   * into an HTTP 500.
   */
  async searchAllDetailed(
    gezelId: string,
    projectId: string,
    query: string,
    topK = 10,
  ): Promise<MemorySearchOutcome> {
    const gezelIndexed = this.hasIndex('gezel', gezelId);
    const projectIndexed = this.hasIndex('project', projectId);

    if (!gezelIndexed && !projectIndexed) {
      return {
        results: await this.searchAllLexical(gezelId, projectId, query, topK),
        mode: 'lexical',
      };
    }

    try {
      // Embed ONCE for both scopes. The old path embedded the same query twice
      // concurrently, doubling cold-start work and duplicate download failure.
      const vector = await embedQuery(query);
      const [gezelResults, projectResults] = await Promise.all([
        gezelIndexed
          ? this.searchVector('gezel', gezelId, vector, topK)
          : this.searchLexical('gezel', gezelId, query, topK),
        projectIndexed
          ? this.searchVector('project', projectId, vector, topK)
          : this.searchLexical('project', projectId, query, topK),
      ]);
      return {
        results: rankSearchResults([...gezelResults, ...projectResults], topK),
        mode: gezelIndexed && projectIndexed ? 'semantic' : 'hybrid',
      };
    } catch (error) {
      log.warn(
        `[memory] semantic search unavailable; using daily-memory lexical fallback: ${describeError(error)}`,
      );
      return {
        results: await this.searchAllLexical(gezelId, projectId, query, topK),
        mode: 'lexical',
        degraded: {
          code: 'semantic_search_unavailable',
          message:
            'Semantic memory search is temporarily unavailable; searched saved memory text directly instead.',
        },
      };
    }
  }

  private async searchAllLexical(
    gezelId: string,
    projectId: string,
    query: string,
    topK: number,
  ): Promise<SearchResult[]> {
    const [gezelResults, projectResults] = await Promise.all([
      this.searchLexical('gezel', gezelId, query, topK),
      this.searchLexical('project', projectId, query, topK),
    ]);
    return rankSearchResults([...gezelResults, ...projectResults], topK);
  }

  private async searchLexical(
    scope: 'gezel' | 'project',
    id: string,
    query: string,
    topK: number,
  ): Promise<SearchResult[]> {
    const entries = await this.allEntries(scope, id);
    return entries
      .map((entry) => ({ entry, score: lexicalScore(query, entry.text) }))
      .filter((candidate) => candidate.score > 0)
      .sort((a, b) => b.score - a.score || b.entry.at.localeCompare(a.entry.at))
      .slice(0, topK)
      .map(({ entry, score }) => ({
        text: entry.text,
        score,
        day: entry.day,
        scope: entry.scope,
        id: entry.id,
        kind: entry.kind ?? DEFAULT_MEMORY_KIND,
      }));
  }

  async listDays(scope: 'gezel' | 'project', id: string): Promise<string[]> {
    return this.store.listMemoryDays(scope, id);
  }

  async readDay(scope: 'gezel' | 'project', id: string, day: string): Promise<string> {
    return this.store.readMemoryDay(scope, id, day);
  }

  /**
   * Replace one source-of-truth daily file after a first-party editor change.
   * A failed index refresh must not roll back or misreport the durable markdown
   * save; the health monitor will rebuild the derived cache on its next sweep.
   */
  async replaceDay(
    scope: 'gezel' | 'project',
    id: string,
    day: string,
    content: string,
  ): Promise<{ indexed: boolean }> {
    await this.store.writeMemoryDay(scope, id, day, content);
    try {
      await this.reindex(scope, id);
      return { indexed: true };
    } catch (error) {
      log.warn(
        `[memory] saved edited ${scope}/${id}/${day}, but reindex failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { indexed: false };
    }
  }

  async getRecent(scope: 'gezel' | 'project', id: string, days = 7): Promise<string> {
    return this.store.readRecentMemories(scope, id, days);
  }

  /**
   * @deprecated Legacy summary.md viewer — superseded by compaction
   * (which rewrites the daily corpus in place) and lessons.md. Kept so
   * users with an existing summary.md on disk can still view it.
   */
  async readSummary(scope: 'gezel' | 'project', id: string): Promise<string> {
    return this.store.readMemorySummary(scope, id);
  }

  /**
   * Parse all daily files into MemoryEntry objects for reindexing.
   */
  async allEntries(scope: 'gezel' | 'project', id: string): Promise<MemoryEntry[]> {
    const days = await this.store.listMemoryDays(scope, id);
    const entries: MemoryEntry[] = [];
    for (const day of days) {
      const content = await this.store.readMemoryDay(scope, id, day);
      for (const block of parseMemoryDay(content)) {
        entries.push({
          text: block.text,
          scope,
          id,
          day,
          at: `${day}T${block.time}`,
          kind: block.kind,
        });
      }
    }
    return entries;
  }

  async reindex(scope: 'gezel' | 'project', id: string): Promise<number> {
    const entries = await this.allEntries(scope, id);
    const indexDir = this.store.memoryIndexDir(scope, id);
    await rebuildIndex(indexDir, entries);
    log.info(`[memory] reindexed ${scope}/${id}: ${entries.length} entries`);
    return entries.length;
  }
}

function rankSearchResults(results: SearchResult[], topK: number): SearchResult[] {
  return results.sort((a, b) => b.score - a.score).slice(0, topK);
}

function deferredIndexOutcome(): SaveOutcome {
  return {
    status: 'saved',
    indexed: false,
    degraded: {
      code: 'semantic_index_unavailable',
      message: 'Memory was saved, but semantic indexing is temporarily unavailable.',
    },
  };
}

function lexicalScore(query: string, text: string): number {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const normalizedText = text.toLocaleLowerCase();
  if (!normalizedQuery || !normalizedText) return 0;
  if (normalizedText.includes(normalizedQuery)) return 1;

  const queryTokens = new Set(normalizedQuery.match(/[\p{L}\p{N}_-]+/gu) ?? []);
  if (queryTokens.size === 0) return 0;
  const textTokens = new Set(normalizedText.match(/[\p{L}\p{N}_-]+/gu) ?? []);
  let matches = 0;
  for (const token of queryTokens) {
    if (textTokens.has(token)) matches++;
  }
  return matches / queryTokens.size;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
