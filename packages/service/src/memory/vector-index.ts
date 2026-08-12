/**
 * Memory vector store, backed by sqlite + sqlite-vec (the same stack as the
 * workspace content index — Phase 4 consolidation). Replaces the previous
 * in-memory Vectra wrapper: a Vectra index hydrated the entire vector set into
 * the JS heap on every open, which doesn't scale; sqlite-vec queries on disk
 * with bounded memory.
 *
 * Each agent/project scope keeps its own `mem.db` under its memory index dir.
 * The public surface (`addToIndex` / `searchIndex` / `rebuildIndex` +
 * `MemoryEntry` / `SearchResult`) is unchanged so `MemoryManager` and the
 * health monitor need no changes. The daily markdown files remain the source of
 * truth — `rebuildIndex` (via `MemoryManager.reindex`) repopulates from them, so
 * the cutover from a stale Vectra index is a no-op once the next reindex runs.
 *
 * Scores use sqlite-vec's cosine metric mapped to `1 - distance`, preserving the
 * 0–1 "higher is better" similarity scale callers (auto-recall's `minScore`)
 * expect.
 */

import { join } from 'node:path';
import {
  type SqliteDriver,
  isTransientIndexError,
  isUnavailableIndexError,
  openIndexDatabase,
  vectorToBlob,
} from '../index-store/sqlite-driver.js';
import { DEFAULT_MEMORY_KIND, type MemoryKind, isMemoryKind } from './daily-markdown.js';
import { embedModelId } from './embed-core.js';
import { embed, embedBatch, embedQuery } from './embeddings.js';

export interface MemoryEntry {
  text: string;
  scope: 'gezel' | 'project';
  id: string;
  day: string;
  at: string;
  /** Memory kind; absent on legacy entries → treated as 'fact'. */
  kind?: MemoryKind;
}

export interface SearchResult {
  text: string;
  score: number;
  day: string;
  scope: string;
  id: string;
  kind: MemoryKind;
}

async function openMem(indexDir: string): Promise<SqliteDriver | null> {
  const db = await openIndexDatabase(join(indexDir, 'mem.db'));
  if (!db) return null;
  try {
    db.transaction(() => {
      db.exec(
        `CREATE TABLE IF NOT EXISTS mem (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       text TEXT, scope TEXT, ext_id TEXT, day TEXT, at TEXT
     );`,
      );
      // Lossless in-place migration for pre-kind databases. ALTER (not a
      // version-bump rebuild) because markdown access lives a layer up in
      // Store/MemoryManager; old rows read back kind=NULL → 'fact', and a
      // botched migration self-heals on the next health-monitor rebuild.
      const cols = db.prepare('PRAGMA table_info(mem)').all<{ name: string }>();
      if (!cols.some((c) => c.name === 'kind')) {
        db.exec('ALTER TABLE mem ADD COLUMN kind TEXT');
      }
      db.exec('CREATE TABLE IF NOT EXISTS mem_meta (key TEXT PRIMARY KEY, value TEXT);');
    });
    return db;
  } catch (error) {
    db.close();
    // Memory search has a single fixed location — a busy db and an unusable
    // one degrade the same way here: recall is skipped for this call.
    if (isUnavailableIndexError(error) || isTransientIndexError(error)) return null;
    throw error;
  }
}

/**
 * The embedding model this memory index was built with, or null on a fresh /
 * pre-stamp db. The health monitor rebuilds when it no longer matches the
 * active model — vectors from a different embedder aren't comparable.
 */
export async function readEmbedStamp(indexDir: string): Promise<string | null> {
  const db = await openMem(indexDir);
  if (!db) return null;
  try {
    return (
      db.prepare("SELECT value FROM mem_meta WHERE key = 'embed_model'").get<{ value: string }>()
        ?.value ?? null
    );
  } finally {
    db.close();
  }
}

/**
 * Create the `vec_mem` table lazily at the embedding's actual dimension (384 in
 * prod, but tests mock a smaller dim). Idempotent via IF NOT EXISTS; within one
 * db the dimension is always consistent (same embedder). Returns false when vec
 * is unusable.
 */
function ensureVecTable(db: SqliteDriver, dim: number): boolean {
  if (!db.vecAvailable) return false;
  try {
    db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS vec_mem USING vec0(embedding float[${dim}] distance_metric=cosine);`,
    );
    return true;
  } catch {
    try {
      db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_mem USING vec0(embedding float[${dim}]);`);
      return true;
    } catch {
      return false;
    }
  }
}

/** Number of indexed memory entries — used by the health monitor to detect drift. */
export async function countIndexed(indexDir: string): Promise<number> {
  const db = await openMem(indexDir);
  if (!db) return 0;
  try {
    const row = db.prepare('SELECT COUNT(*) AS n FROM mem').get<{ n: number }>();
    return Number(row?.n ?? 0);
  } finally {
    db.close();
  }
}

/**
 * Insert one entry. Accepts an optional precomputed embedding so callers
 * that already embedded the text (e.g. `MemoryManager.save`'s dedup check)
 * don't pay for a second model pass.
 */
export async function addToIndex(
  indexDir: string,
  entry: MemoryEntry,
  vector?: number[],
): Promise<void> {
  const db = await openMem(indexDir);
  if (!db) return;
  try {
    // Stamp the embedder that built these vectors so the health monitor can
    // tell a model swap from genuine drift. Every write path (this + the full
    // rebuild) stamps, so a save-built index is never mistaken for stale.
    db.prepare("INSERT OR REPLACE INTO mem_meta (key, value) VALUES ('embed_model', ?)").run(
      embedModelId(),
    );
    const v = vector ?? (await embed(entry.text));
    const { lastInsertRowid } = db
      .prepare('INSERT INTO mem (text, scope, ext_id, day, at, kind) VALUES (?, ?, ?, ?, ?, ?)')
      .run(
        entry.text,
        entry.scope,
        entry.id,
        entry.day,
        entry.at,
        entry.kind ?? DEFAULT_MEMORY_KIND,
      );
    if (ensureVecTable(db, v.length)) {
      db.prepare('INSERT OR REPLACE INTO vec_mem (rowid, embedding) VALUES (?, ?)').run(
        BigInt(Math.trunc(lastInsertRowid)),
        vectorToBlob(v),
      );
    }
  } finally {
    db.close();
  }
}

export async function searchIndex(
  indexDir: string,
  query: string,
  topK = 10,
): Promise<SearchResult[]> {
  const vector = await embedQuery(query);
  return searchByVector(indexDir, vector, topK);
}

/** Search with a precomputed embedding (no embed call). */
export async function searchByVector(
  indexDir: string,
  vector: number[],
  topK = 10,
): Promise<SearchResult[]> {
  const db = await openMem(indexDir);
  if (!db) return [];
  try {
    if (!ensureVecTable(db, vector.length)) return [];
    const rows = db
      .prepare(
        'SELECT rowid, distance FROM vec_mem WHERE embedding MATCH ? ORDER BY distance LIMIT ?',
      )
      .all<{ rowid: number | bigint; distance: number }>(vectorToBlob(vector), topK);
    const get = db.prepare('SELECT text, scope, ext_id, day, kind FROM mem WHERE id = ?');
    const out: SearchResult[] = [];
    for (const r of rows) {
      const m = get.get<{
        text: string;
        scope: string;
        ext_id: string;
        day: string;
        kind: string | null;
      }>(Number(r.rowid));
      if (!m) continue;
      out.push({
        text: m.text,
        score: 1 - r.distance, // cosine distance → similarity
        day: m.day,
        scope: m.scope,
        id: m.ext_id,
        kind: isMemoryKind(m.kind) ? m.kind : DEFAULT_MEMORY_KIND,
      });
    }
    return out;
  } finally {
    db.close();
  }
}

export async function rebuildIndex(indexDir: string, entries: MemoryEntry[]): Promise<void> {
  const db = await openMem(indexDir);
  if (!db) return;
  try {
    // Stamp the embedder every rebuild — a rebuild always re-embeds from the
    // markdown source of truth with the current model, so the stamp is
    // authoritative and the health monitor won't re-trigger.
    db.prepare("INSERT OR REPLACE INTO mem_meta (key, value) VALUES ('embed_model', ?)").run(
      embedModelId(),
    );
    db.exec('DELETE FROM mem;');
    if (entries.length === 0) {
      if (db.vecAvailable) {
        try {
          db.exec('DELETE FROM vec_mem;');
        } catch {
          /* vec_mem not created yet */
        }
      }
      return;
    }
    const vectors = await embedBatch(entries.map((e) => e.text));
    const hasVec = vectors[0] ? ensureVecTable(db, vectors[0].length) : false;
    if (hasVec) {
      try {
        db.exec('DELETE FROM vec_mem;');
      } catch {
        /* empty */
      }
    }
    const insMem = db.prepare(
      'INSERT INTO mem (text, scope, ext_id, day, at, kind) VALUES (?, ?, ?, ?, ?, ?)',
    );
    const insVec = hasVec
      ? db.prepare('INSERT OR REPLACE INTO vec_mem (rowid, embedding) VALUES (?, ?)')
      : null;
    db.transaction(() => {
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i]!;
        // Rebuild must carry kind — dropping it here would silently erase
        // kinds from the cache on every health-monitor rebuild while the
        // markdown source keeps them.
        const { lastInsertRowid } = insMem.run(
          e.text,
          e.scope,
          e.id,
          e.day,
          e.at,
          e.kind ?? DEFAULT_MEMORY_KIND,
        );
        const v = vectors[i];
        if (insVec && v) {
          insVec.run(BigInt(Math.trunc(lastInsertRowid)), vectorToBlob(v));
        }
      }
    });
  } finally {
    db.close();
  }
}
