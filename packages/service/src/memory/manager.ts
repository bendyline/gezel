import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from '@bendyline/gezel';
import type { Store } from '../fs/store.js';
import { DEFAULT_MEMORY_KIND, type MemoryKind, parseMemoryDay } from './daily-markdown.js';
import { embed, embedQuery } from './embeddings.js';
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
 * of an existing one and skipped. With all-MiniLM-L6-v2, near-identical
 * paraphrases of the same fact land ~0.90–1.0 while distinct facts about the
 * same topic typically score <0.80 (auto-recall's topical-relevance floor is
 * 0.35). 0.90 is deliberately conservative — only true restatements drop.
 */
export const MEMORY_DEDUP_THRESHOLD = 0.9;

export interface SaveOutcome {
  status: 'saved' | 'duplicate';
  /** Populated on 'duplicate': what it matched and how. */
  match?: { text: string; score: number; via: 'exact' | 'vector' };
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
   * the source of truth and the index self-heals on rebuild) and the
   * EmbeddingsDisabledError propagates, preserving the pre-dedup contract.
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
      throw err;
    }

    const top = (await searchByVector(indexDir, vector, 1))[0];
    if (top && top.score >= this.dedupThreshold) {
      log.info(
        `[memory] dup-skip (${top.score.toFixed(2)} vs "${top.text.slice(0, 40)}") ${scope}/${id}: ${trimmed.slice(0, 60)}`,
      );
      return { status: 'duplicate', match: { text: top.text, score: top.score, via: 'vector' } };
    }

    await this.store.appendMemory(scope, id, trimmed, kind);
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
    log.info(`[memory] saved ${scope}/${id} [${kind}]: ${trimmed.slice(0, 60)}`);
    return { status: 'saved' };
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
    return searchIndex(indexDir, query, topK);
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
    const [agentResults, projectResults] = await Promise.all([
      this.search('gezel', gezelId, query, topK),
      this.search('project', projectId, query, topK),
    ]);
    return [...agentResults, ...projectResults].sort((a, b) => b.score - a.score).slice(0, topK);
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
