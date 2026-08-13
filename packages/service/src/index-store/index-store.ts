import {
  type FileReviewIssue,
  type HistoryEvent,
  type HistoryFilter,
  nowIso,
} from '@bendyline/gezel';
import { embedModelId } from '../memory/embed-core.js';
import { TEXT_EMBED_DIM, applySchema } from './schema.js';
import {
  type SqlValue,
  type SqliteDriver,
  isUnavailableIndexError,
  openIndexDatabase,
  vectorToBlob,
} from './sqlite-driver.js';

/**
 * Persisted, disk-queried content index for one collection (a workspace, the
 * global Documents folder, an image library, an email mirror). One `index.db`
 * per collection root. Built on `node:sqlite` + sqlite-vec + FTS5.
 *
 * This is the storage substrate the code-intel / doc-intel MCP tools and the
 * boekwachter enrichment read and write. It is a cache: callers fall back to
 * ripgrep/live-read when `IndexStore.open` returns null (sqlite unavailable).
 */

export type Modality = 'text' | 'code' | 'doc' | 'image' | 'audio' | 'email';
export type CollectionKind =
  | 'workspace'
  | 'documents'
  | 'images'
  | 'mail'
  | 'sessions'
  | 'history'
  | 'generic';

export interface FileRecord {
  path: string;
  hash: string | null;
  size: number;
  mtimeMs: number;
  lang: string | null;
  kind: string | null;
  modality: Modality;
  trivial: boolean;
  indexedAt: string;
  /** Line count; null for trivial/binary files we never read. Drives block size. */
  loc: number | null;
}

export interface SymbolInput {
  name: string;
  kind: string;
  lineStart: number;
  lineEnd: number;
  signature?: string;
  /** Containing class/module/interface name, when nested. */
  parent?: string;
}

/**
 * One binding taken by an import statement. `name` is the exported name at the
 * target ('default' for default imports, '*' for namespace); `local` is the
 * identifier used in the importing file (differs from `name` when aliased).
 * Inbound attribution ("who imports symbol X") matches on `name`; outbound
 * attribution ("what does this symbol use") matches on `local`.
 */
export interface ImportBinding {
  name: string;
  local: string;
  kind: 'named' | 'default' | 'namespace';
}

/** A raw dependency edge: one importer + one unresolved module specifier. */
export interface ImportEdgeInput {
  /** The literal module string, e.g. './db', 'react', 'os/path'. */
  raw: string;
  /** Named/default/namespace bindings; undefined = not recorded (legacy row or
   *  a language whose imports we don't destructure). */
  bindings?: ImportBinding[];
}

export type SecuritySeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type SecuritySource = 'builtin' | 'semgrep' | 'osv' | 'gitleaks';
export type SecurityFindingStatus = 'open' | 'in_progress' | 'resolved';

/** A static security finding, minus the file it belongs to (passed separately). */
export interface SecurityFindingInput {
  /** 1-based line, or null when whole-file/unknown. */
  line: number | null;
  /** Stable rule identifier, e.g. `sink.eval`, `secret.aws-key`, semgrep's check id. */
  ruleId: string;
  /** Coarse class, e.g. `injection`, `secret`, `ssrf`, `crypto`, `dependency`. */
  category: string;
  severity: SecuritySeverity;
  /** One-line human summary. */
  title: string;
  /** The matched snippet (capped) for audit — NEVER a raw secret value. */
  evidence?: string;
  /** Dedup key across re-scans/tools; defaults to `ruleId:file:line`. */
  fingerprint?: string;
}

export interface SecurityFindingRow extends SecurityFindingInput {
  filePath: string;
  source: SecuritySource;
  fingerprint: string;
  status: SecurityFindingStatus;
  taskRef?: string;
}

export interface DependencyInput {
  name: string;
  ecosystem: string;
  version: string | null;
  direct: boolean;
  advisoryIds?: string[];
  maxSeverity?: SecuritySeverity | null;
  license?: string | null;
}

export interface DependencyRow {
  name: string;
  ecosystem: string;
  version: string | null;
  direct: boolean;
  advisoryIds: string[];
  maxSeverity: SecuritySeverity | null;
  license: string | null;
}

interface SecurityFindingDbRow {
  file_path: string;
  line: number | null;
  rule_id: string;
  category: string;
  severity: string;
  source: string;
  title: string;
  evidence: string | null;
  fingerprint: string | null;
  finding_status: string | null;
  task_ref: string | null;
}

/** A persisted city-map node coordinate (district, block, street, label
 *  plate, or plaza). `node_kind` is unconstrained TEXT in sqlite, so the new
 *  kinds need no schema migration — only this union. */
export interface LayoutRow {
  nodeKind: 'district' | 'block' | 'street' | 'plate' | 'plaza';
  nodeId: string;
  parentId: string | null;
  contentHash: string | null;
  x: number;
  y: number;
  w: number;
  h: number;
  weight: number;
  placedAt: string | null;
  removedAt: string | null;
}

export interface SymbolHit extends SymbolInput {
  /** Stable id `path#name` for multi-step flows. */
  id: string;
  filePath: string;
  signature: string;
}

export interface ChunkInput {
  kind: string;
  lineStart: number;
  lineEnd: number;
  text: string;
}

export interface DocHit {
  filePath: string;
  lineStart: number;
  chunkId: number;
  snippet: string;
}

export interface VectorHit {
  chunkId: number;
  filePath: string;
  lineStart: number;
  lineEnd: number;
  text: string;
  distance: number;
}

/**
 * Who produced an LLM-written index row. Output-only bookkeeping — never an
 * input to model routing. Absent fields stay NULL (rows written before the
 * v10 migration, or deps built without a boekwachter) and renderers degrade
 * to whatever segments exist.
 */
export interface IndexProvenance {
  provider?: string;
  gezelId?: string;
  gezelName?: string;
  appVersion?: string;
}

/** A successful boekwachter review as served per file (hash-keyed). */
export interface FileReviewRow {
  notesMd: string;
  issues: FileReviewIssue[];
  health: number;
  healthReason: string;
  rubricHash: string;
  model: string | null;
  provider: string | null;
  gezelId: string | null;
  gezelName: string | null;
  appVersion: string | null;
  reviewedAt: string | null;
}

export interface CurrentFileReviewIssues {
  path: string;
  contentHash: string;
  issues: FileReviewIssue[];
}

export interface OpenOptions {
  collectionId: string;
  kind: CollectionKind;
  rootPath: string;
  label?: string;
}

interface FileRow {
  path: string;
  hash: string | null;
  size: number;
  mtime_ms: number;
  lang: string | null;
  kind: string | null;
  modality: string | null;
  trivial: number;
  indexed_at: string | null;
  loc: number | null;
}

function symbolId(filePath: string, name: string): string {
  return `${filePath}#${name}`;
}

/** Escape a user string into a safe FTS5 MATCH term (quoted phrase). */
function ftsPhrase(query: string): string {
  return `"${query.replace(/"/g, '""')}"`;
}

/** Tolerant parse of the file_reviews.issues JSON column — bad JSON → []. */
function parseIssuesJson(raw: string | null): FileReviewIssue[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as FileReviewIssue[]) : [];
  } catch {
    return [];
  }
}

/** ORDER BY fragment that sorts security findings critical→info. */
const SEVERITY_RANK_SQL =
  "CASE sf.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END";

/** Summarize retries per content hash before the enrichment gate gives up. */
export const MAX_ENRICH_ATTEMPTS = 3;

/**
 * Invalidate the text vectors when the embedding model changed. Vectors from a
 * different embedder are not comparable to the current model's query vectors
 * (garbage cosine similarity), so on a model swap we drop `vec_text` (recreated
 * at the current dim — handles a dim change too) and clear `enrichments` so the
 * enrichment loop re-embeds every file. Summaries + chunks survive, so
 * re-embedding pays no LLM cost (see enrichFile's summary reuse). First-ever
 * open just stamps the model; matching model is a no-op (no write on the hot
 * read-open path).
 */
function reconcileEmbedModel(db: SqliteDriver, vecAvailable: boolean): void {
  const current = embedModelId();
  const stored = db
    .prepare("SELECT value FROM meta WHERE key = 'embed_model'")
    .get<{ value: string }>()?.value;
  if (stored === current) return;
  if (stored) {
    if (vecAvailable) {
      db.exec('DROP TABLE IF EXISTS vec_text');
      db.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS vec_text USING vec0(embedding float[${TEXT_EMBED_DIM}]);`,
      );
    }
    db.exec('DELETE FROM enrichments');
  }
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('embed_model', ?)").run(current);
}

export class IndexStore {
  private constructor(
    private readonly db: SqliteDriver,
    readonly collectionId: string,
    private readonly caps: { fts: boolean; vec: boolean },
  ) {}

  static async open(dbPath: string, opts: OpenOptions): Promise<IndexStore | null> {
    const db = await openIndexDatabase(dbPath);
    if (!db) return null;
    try {
      const caps = applySchema(db);
      reconcileEmbedModel(db, caps.vec);
      db.prepare(
        'INSERT OR REPLACE INTO collections (id, kind, root_path, label, created_at) VALUES (?, ?, ?, ?, ?)',
      ).run(opts.collectionId, opts.kind, opts.rootPath, opts.label ?? null, nowIso());
      return new IndexStore(db, opts.collectionId, caps);
    } catch (error) {
      db.close();
      if (isUnavailableIndexError(error)) return null;
      throw error;
    }
  }

  get vecAvailable(): boolean {
    return this.caps.vec;
  }
  get ftsAvailable(): boolean {
    return this.caps.fts;
  }

  close(): void {
    this.db.close();
  }

  // ── files ──────────────────────────────────────────────────────────────

  upsertFile(rec: FileRecord): void {
    this.db
      .prepare(
        `INSERT INTO files (collection_id, path, hash, size, mtime_ms, lang, kind, modality, trivial, indexed_at, loc)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(collection_id, path) DO UPDATE SET
           hash=excluded.hash, size=excluded.size, mtime_ms=excluded.mtime_ms,
           lang=excluded.lang, kind=excluded.kind, modality=excluded.modality,
           trivial=excluded.trivial, indexed_at=excluded.indexed_at, loc=excluded.loc`,
      )
      .run(
        this.collectionId,
        rec.path,
        rec.hash,
        rec.size,
        rec.mtimeMs,
        rec.lang,
        rec.kind,
        rec.modality,
        rec.trivial ? 1 : 0,
        rec.indexedAt,
        rec.loc,
      );
  }

  getFile(path: string): FileRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM files WHERE collection_id = ? AND path = ?')
      .get<FileRow>(this.collectionId, path);
    return row ? rowToFile(row) : undefined;
  }

  allFiles(): FileRecord[] {
    return this.db
      .prepare('SELECT * FROM files WHERE collection_id = ? ORDER BY path')
      .all<FileRow>(this.collectionId)
      .map(rowToFile);
  }

  /** Total indexed file count for this collection. */
  fileCount(): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM files WHERE collection_id = ?')
      .get<{ n: number }>(this.collectionId);
    return row?.n ?? 0;
  }

  /**
   * Histogram of file extensions (lowercase, no dot) across the collection,
   * derived from `path`. HTML/CSS et al. aren't classified as a `lang`, so
   * extension is the reliable file-shape signal for project-type detection.
   */
  extensionCounts(): Record<string, number> {
    const out: Record<string, number> = {};
    const rows = this.db
      .prepare('SELECT path FROM files WHERE collection_id = ?')
      .all<{ path: string }>(this.collectionId);
    for (const r of rows) {
      const dot = r.path.lastIndexOf('.');
      const slash = Math.max(r.path.lastIndexOf('/'), r.path.lastIndexOf('\\'));
      if (dot <= slash + 1) continue; // no extension (or dotfile)
      const ext = r.path.slice(dot + 1).toLowerCase();
      if (ext) out[ext] = (out[ext] ?? 0) + 1;
    }
    return out;
  }

  /** Histogram of file modalities (`code`, `text`, `image`, …). */
  modalityCounts(): Record<string, number> {
    const out: Record<string, number> = {};
    const rows = this.db
      .prepare(
        'SELECT modality, COUNT(*) AS n FROM files WHERE collection_id = ? GROUP BY modality',
      )
      .all<{ modality: string | null; n: number }>(this.collectionId);
    for (const r of rows) if (r.modality) out[r.modality] = r.n;
    return out;
  }

  deleteFile(path: string): void {
    this.db.transaction(() => {
      for (const table of [
        'files',
        'symbols',
        'symbol_summaries',
        'chunks',
        'metadata',
        'imports',
        'security_findings',
      ]) {
        this.db
          .prepare(`DELETE FROM ${table} WHERE collection_id = ? AND ${pathCol(table)} = ?`)
          .run(this.collectionId, path);
      }
      this.pruneFtsForFile(path);
    });
  }

  // ── symbols ────────────────────────────────────────────────────────────

  /** Replace all symbols for a file (idempotent re-index of one file). */
  putSymbols(filePath: string, fileHash: string | null, symbols: SymbolInput[]): void {
    this.db.transaction(() => {
      this.db
        .prepare('DELETE FROM symbols WHERE collection_id = ? AND file_path = ?')
        .run(this.collectionId, filePath);
      if (this.caps.fts) {
        this.db
          .prepare('DELETE FROM fts_symbols WHERE file_path = ? AND collection_id = ?')
          .run(filePath, this.collectionId);
      }
      const ins = this.db.prepare(
        `INSERT INTO symbols (collection_id, file_path, file_hash, name, kind, line_start, line_end, signature, parent)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const fts = this.caps.fts
        ? this.db.prepare(
            'INSERT INTO fts_symbols (name, signature, file_path, kind, line_start, line_end, symbol_id, collection_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          )
        : null;
      for (const s of symbols) {
        ins.run(
          this.collectionId,
          filePath,
          fileHash,
          s.name,
          s.kind,
          s.lineStart,
          s.lineEnd,
          s.signature ?? '',
          s.parent ?? null,
        );
        fts?.run(
          s.name,
          s.signature ?? '',
          filePath,
          s.kind,
          s.lineStart,
          s.lineEnd,
          symbolId(filePath, s.name),
          this.collectionId,
        );
      }
    });
  }

  symbolsForFile(filePath: string): SymbolHit[] {
    return this.db
      .prepare(
        'SELECT name, kind, line_start, line_end, signature, parent FROM symbols WHERE collection_id = ? AND file_path = ? ORDER BY line_start',
      )
      .all<{
        name: string;
        kind: string;
        line_start: number;
        line_end: number;
        signature: string;
        parent: string | null;
      }>(this.collectionId, filePath)
      .map((r) => ({
        id: symbolId(filePath, r.name),
        filePath,
        name: r.name,
        kind: r.kind,
        lineStart: r.line_start,
        lineEnd: r.line_end,
        signature: r.signature,
        ...(r.parent ? { parent: r.parent } : {}),
      }));
  }

  /** Every symbol in the collection, ordered by file then line — bulk read for
   *  the city-map's "buildings" (avoids one query per file). */
  allSymbols(): Array<{
    filePath: string;
    name: string;
    kind: string;
    lineStart: number;
    lineEnd: number;
  }> {
    return this.db
      .prepare(
        'SELECT file_path, name, kind, line_start, line_end FROM symbols WHERE collection_id = ? ORDER BY file_path, line_start',
      )
      .all<{
        file_path: string;
        name: string;
        kind: string;
        line_start: number;
        line_end: number;
      }>(this.collectionId)
      .map((r) => ({
        filePath: r.file_path,
        name: r.name,
        kind: r.kind,
        lineStart: r.line_start,
        lineEnd: r.line_end,
      }));
  }

  /** Find definitions by name. Exact match first, then FTS prefix when sparse. */
  searchSymbols(opts: { name: string; kind?: string; limit?: number }): SymbolHit[] {
    const limit = opts.limit ?? 50;
    const kindClause = opts.kind ? ' AND kind = ?' : '';
    const params: (string | number)[] = [this.collectionId, opts.name];
    if (opts.kind) params.push(opts.kind);
    params.push(limit);
    const rows = this.db
      .prepare(
        `SELECT file_path, name, kind, line_start, line_end, signature
         FROM symbols WHERE collection_id = ? AND name = ?${kindClause}
         ORDER BY file_path LIMIT ?`,
      )
      .all<{
        file_path: string;
        name: string;
        kind: string;
        line_start: number;
        line_end: number;
        signature: string;
      }>(...params);
    return rows.map((r) => ({
      id: symbolId(r.file_path, r.name),
      filePath: r.file_path,
      name: r.name,
      kind: r.kind,
      lineStart: r.line_start,
      lineEnd: r.line_end,
      signature: r.signature,
    }));
  }

  /** Full-text symbol search (name + signature) — fuzzier than searchSymbols. */
  ftsSymbols(query: string, limit = 20): SymbolHit[] {
    if (!this.caps.fts) return [];
    return this.db
      .prepare(
        `SELECT file_path, name, kind, line_start, line_end, signature
         FROM fts_symbols WHERE fts_symbols MATCH ? AND collection_id = ? LIMIT ?`,
      )
      .all<{
        file_path: string;
        name: string;
        kind: string;
        line_start: number;
        line_end: number;
        signature: string;
      }>(ftsPhrase(query), this.collectionId, limit)
      .map((r) => ({
        id: symbolId(r.file_path, r.name),
        filePath: r.file_path,
        name: r.name,
        kind: r.kind,
        lineStart: r.line_start,
        lineEnd: r.line_end,
        signature: r.signature,
      }));
  }

  /**
   * Non-trivial files whose current content hash hasn't been enriched
   * (summary + embeddings) yet — the boekwachter work-list. Hash-gated via the
   * `enrichments` table, so a content change re-queues a file but an mtime touch
   * does not. A gate row with `embedded_at NULL` is a failed summarize attempt:
   * the file stays on the list while `attempts` < MAX_ENRICH_ATTEMPTS, then
   * drops off (gave up for this hash). Ordered by path for stable progress.
   */
  filesNeedingEnrichment(limit = 20): FileRecord[] {
    return this.db
      .prepare(
        `SELECT f.* FROM files f
         LEFT JOIN enrichments e ON e.content_hash = f.hash
         WHERE f.collection_id = ? AND f.trivial = 0 AND f.hash IS NOT NULL
           AND (f.modality IN ('code','text','doc')
                OR EXISTS (SELECT 1 FROM shadow_state s
                           WHERE s.content_hash = f.hash AND s.state = 'ok'))
           AND (e.content_hash IS NULL
                OR (e.embedded_at IS NULL AND COALESCE(e.attempts, 0) < ${MAX_ENRICH_ATTEMPTS}))
         ORDER BY f.path LIMIT ?`,
      )
      .all<FileRow>(this.collectionId, limit)
      .map(rowToFile);
  }

  /** COUNT companion to {@link filesNeedingEnrichment} — same predicate, no
   *  row payload. Cheap enough to call on each foreground UI status poll to
   *  answer "is the AI scan still pending?". */
  countNeedingEnrichment(): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM files f
         LEFT JOIN enrichments e ON e.content_hash = f.hash
         WHERE f.collection_id = ? AND f.trivial = 0 AND f.hash IS NOT NULL
           AND (f.modality IN ('code','text','doc')
                OR EXISTS (SELECT 1 FROM shadow_state s
                           WHERE s.content_hash = f.hash AND s.state = 'ok'))
           AND (e.content_hash IS NULL
                OR (e.embedded_at IS NULL AND COALESCE(e.attempts, 0) < ${MAX_ENRICH_ATTEMPTS}))`,
      )
      .get<{ n: number }>(this.collectionId);
    return row?.n ?? 0;
  }

  /**
   * Image/audio files whose AI shadow (description / transcript) is missing
   * or stale for the current content hash. Same capped-retry discipline as
   * {@link filesNeedingEnrichment}; an 'ok' row is the terminal success.
   */
  filesNeedingAiShadow(limit = 5, maxAttempts = MAX_ENRICH_ATTEMPTS): FileRecord[] {
    return this.db
      .prepare(
        `SELECT f.* FROM files f
         LEFT JOIN shadow_state s ON s.content_hash = f.hash
         WHERE f.collection_id = ? AND f.trivial = 0 AND f.hash IS NOT NULL
           AND f.modality IN ('image','audio')
           AND (s.content_hash IS NULL
                OR (s.state <> 'ok' AND COALESCE(s.attempts, 0) < ?))
         ORDER BY f.path LIMIT ?`,
      )
      .all<FileRow>(this.collectionId, maxAttempts, limit)
      .map(rowToFile);
  }

  markAiShadowOk(contentHash: string, filePath: string, model?: string): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO shadow_state (content_hash, collection_id, file_path, state, attempts, model, updated_at)
         VALUES (?, ?, ?, 'ok', 0, ?, ?)`,
      )
      .run(contentHash, this.collectionId, filePath, model ?? null, nowIso());
  }

  markAiShadowAttempt(contentHash: string, filePath: string): number {
    this.db
      .prepare(
        `INSERT INTO shadow_state (content_hash, collection_id, file_path, state, attempts, updated_at)
         VALUES (?, ?, ?, 'failed', 1, ?)
         ON CONFLICT(content_hash) DO UPDATE SET
           state='failed', attempts=COALESCE(shadow_state.attempts, 0) + 1,
           updated_at=excluded.updated_at`,
      )
      .run(contentHash, this.collectionId, filePath, nowIso());
    return Number(
      this.db
        .prepare('SELECT attempts FROM shadow_state WHERE content_hash = ?')
        .get<{ attempts: number }>(contentHash)?.attempts ?? 1,
    );
  }

  /**
   * Terminally skip a media hash the AI-shadow tier can never process — a
   * format with no raster decoder in the vision stack (SVG is vector, ICO is
   * multi-frame). Jumps straight to the attempt cap under a distinct state so
   * the row reads as "wrong tool", not "engine flaked three times".
   */
  markAiShadowUnsupported(contentHash: string, filePath: string): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO shadow_state (content_hash, collection_id, file_path, state, attempts, updated_at)
         VALUES (?, ?, ?, 'unsupported', ${MAX_ENRICH_ATTEMPTS}, ?)`,
      )
      .run(contentHash, this.collectionId, filePath, nowIso());
  }

  /**
   * Enrichment coverage counts. `summarized` counts real summaries (join on
   * the summaries table), deliberately NOT the enrichments gate — the gate also
   * carries failed-attempt rows (embedded_at NULL), and historically a failed
   * summarize consumed it outright.
   */
  enrichmentCounts(): {
    eligible: number;
    summarized: number;
    embedded: number;
    pending: number;
    skipped: number;
    shadowsPending: number;
    embedModel?: string;
  } {
    const ELIGIBLE = `f.collection_id = ? AND f.trivial = 0 AND f.hash IS NOT NULL
           AND f.modality IN ('code','text','doc')`;
    const count = (sql: string): number =>
      Number(this.db.prepare(sql).get<{ n: number }>(this.collectionId)?.n ?? 0);
    const eligible = count(`SELECT COUNT(*) AS n FROM files f WHERE ${ELIGIBLE}`);
    const summarized = count(
      `SELECT COUNT(*) AS n FROM files f JOIN summaries s ON s.content_hash = f.hash WHERE ${ELIGIBLE}`,
    );
    const embedded = count(
      `SELECT COUNT(*) AS n FROM files f JOIN enrichments e ON e.content_hash = f.hash
       WHERE e.embedded_at IS NOT NULL AND ${ELIGIBLE}`,
    );
    // Attempt-capped files: dropped from the work list but never summarized,
    // so `summarized` can never reach `eligible` while these exist. Counted
    // separately or the status reads as forever-pending with no explanation.
    const skipped = count(
      `SELECT COUNT(*) AS n FROM files f JOIN enrichments e ON e.content_hash = f.hash
       WHERE e.embedded_at IS NULL AND COALESCE(e.attempts, 0) >= ${MAX_ENRICH_ATTEMPTS}
         AND ${ELIGIBLE}`,
    );
    const embedModel = this.getMeta('embed_model');
    return {
      eligible,
      summarized,
      embedded,
      pending: this.countNeedingEnrichment(),
      skipped,
      shadowsPending: this.countNeedingAiShadow(),
      ...(embedModel ? { embedModel } : {}),
    };
  }

  /**
   * COUNT twin of `filesNeedingAiShadow` — media files still awaiting an AI
   * description, attempt-capped ones excluded. The drive works this tier
   * before summaries, so status must surface it or a fresh scan looks stuck.
   */
  countNeedingAiShadow(maxAttempts = MAX_ENRICH_ATTEMPTS): number {
    return Number(
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM files f
           LEFT JOIN shadow_state s ON s.content_hash = f.hash
           WHERE f.collection_id = ? AND f.trivial = 0 AND f.hash IS NOT NULL
             AND f.modality IN ('image','audio')
             AND (s.content_hash IS NULL
                  OR (s.state <> 'ok' AND COALESCE(s.attempts, 0) < ?))`,
        )
        .get<{ n: number }>(this.collectionId, maxAttempts)?.n ?? 0,
    );
  }

  /** Mark a content hash as enriched (vectors built) so it isn't reprocessed. */
  markEnriched(contentHash: string): void {
    this.db
      .prepare('INSERT OR REPLACE INTO enrichments (content_hash, embedded_at) VALUES (?, ?)')
      .run(contentHash, nowIso());
  }

  /**
   * Record a failed summarize attempt for a hash WITHOUT consuming the gate:
   * the row keeps `embedded_at NULL`, so the file stays on the work list until
   * `attempts` reaches MAX_ENRICH_ATTEMPTS. A later success (markEnriched's
   * INSERT OR REPLACE) resets the row.
   */
  markEnrichAttempt(contentHash: string): number {
    this.db
      .prepare(
        `INSERT INTO enrichments (content_hash, embedded_at, attempts) VALUES (?, NULL, 1)
         ON CONFLICT(content_hash) DO UPDATE SET attempts = COALESCE(enrichments.attempts, 0) + 1`,
      )
      .run(contentHash);
    return Number(
      this.db
        .prepare('SELECT attempts FROM enrichments WHERE content_hash = ?')
        .get<{ attempts: number }>(contentHash)?.attempts ?? 1,
    );
  }

  /**
   * Jump a hash straight to the attempt cap — for deterministic failures
   * (a provider policy-blocking the file's content) where every retry would
   * fail identically. The file drops off the work list and counts as
   * `skipped` in {@link enrichmentCounts} until its content changes.
   */
  markEnrichSkipped(contentHash: string): void {
    this.db
      .prepare(
        `INSERT INTO enrichments (content_hash, embedded_at, attempts)
         VALUES (?, NULL, ${MAX_ENRICH_ATTEMPTS})
         ON CONFLICT(content_hash) DO UPDATE
           SET attempts = MAX(COALESCE(enrichments.attempts, 0), ${MAX_ENRICH_ATTEMPTS})`,
      )
      .run(contentHash);
  }

  /**
   * Keyword search over enrichment summaries. fts_summaries rows are
   * content-addressed and never pruned (same discipline as `summaries`), so
   * the join to `files` on the CURRENT hash both drops stale-content rows and
   * serves the current path for renamed-but-unchanged files.
   */
  ftsSummaries(query: string, limit = 20): Array<{ filePath: string; snippet: string }> {
    if (!this.caps.fts) return [];
    return this.db
      .prepare(
        `SELECT f.path AS file_path, s.snip FROM (
           SELECT content_hash, collection_id, snippet(fts_summaries, 0, '', '', '…', 12) AS snip
           FROM fts_summaries WHERE fts_summaries MATCH ? AND collection_id = ? LIMIT ?
         ) s
         JOIN files f ON f.hash = s.content_hash AND f.collection_id = s.collection_id
         LIMIT ?`,
      )
      .all<{ file_path: string; snip: string }>(
        ftsPhrase(query),
        this.collectionId,
        limit * 2,
        limit,
      )
      .map((r) => ({ filePath: r.file_path, snippet: r.snip }));
  }

  /** Hybrid code search: vector neighbours (if available) unioned with FTS over
   *  symbols + summaries + doc chunks, de-duplicated by (path, lineStart). */
  searchCodeHybrid(
    queryVector: number[] | Float32Array | null,
    queryText: string,
    limit: number,
  ): Array<{
    path: string;
    lineStart: number;
    lineEnd: number;
    kind: string;
    name?: string;
    snippet: string;
    score: number;
    source: 'vector' | 'fts';
  }> {
    const out: Array<{
      path: string;
      lineStart: number;
      lineEnd: number;
      kind: string;
      name?: string;
      snippet: string;
      score: number;
      source: 'vector' | 'fts';
    }> = [];
    const seen = new Set<string>();
    const key = (p: string, l: number) => `${p}:${l}`;

    if (queryVector && this.caps.vec) {
      for (const v of this.searchTextVectors(queryVector, limit)) {
        const k = key(v.filePath, v.lineStart);
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({
          path: v.filePath,
          lineStart: v.lineStart,
          lineEnd: v.lineEnd,
          kind: 'chunk',
          snippet: v.text.slice(0, 200),
          score: 1 / (1 + v.distance),
          source: 'vector',
        });
      }
    }

    for (const s of this.ftsSymbols(queryText, limit)) {
      const k = key(s.filePath, s.lineStart);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({
        path: s.filePath,
        lineStart: s.lineStart,
        lineEnd: s.lineEnd,
        kind: s.kind,
        name: s.name,
        snippet: s.signature,
        score: 0.5,
        source: 'fts',
      });
    }
    // Third FTS arm: the LLM summaries. Long write-only (populated on every
    // upsertSummary, never queried) — this is the keyword arm's only NL prose,
    // so natural-language queries stop scoring zero without vectors. Scored
    // between symbols (0.5) and doc chunks (0.4); whole-file hits at line 1.
    for (const s of this.ftsSummaries(queryText, limit)) {
      const k = key(s.filePath, 1);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({
        path: s.filePath,
        lineStart: 1,
        lineEnd: 1,
        kind: 'summary',
        snippet: s.snippet,
        score: 0.45,
        source: 'fts',
      });
    }
    for (const d of this.searchDocs(queryText, limit)) {
      const k = key(d.filePath, d.lineStart);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({
        path: d.filePath,
        lineStart: d.lineStart,
        lineEnd: d.lineStart,
        kind: 'doc',
        snippet: d.snippet,
        score: 0.4,
        source: 'fts',
      });
    }

    return out.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  // ── chunks + fts_docs ──────────────────────────────────────────────────

  /** Replace all chunks for a file and return the inserted chunk ids. */
  putChunks(filePath: string, contentHash: string | null, chunks: ChunkInput[]): number[] {
    return this.db.transaction(() => {
      this.db
        .prepare('DELETE FROM chunks WHERE collection_id = ? AND file_path = ?')
        .run(this.collectionId, filePath);
      if (this.caps.fts) {
        this.db
          .prepare('DELETE FROM fts_docs WHERE file_path = ? AND collection_id = ?')
          .run(filePath, this.collectionId);
      }
      const ins = this.db.prepare(
        `INSERT INTO chunks (collection_id, file_path, content_hash, kind, line_start, line_end, text)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      const fts = this.caps.fts
        ? this.db.prepare(
            'INSERT INTO fts_docs (body, file_path, line_start, chunk_id, collection_id) VALUES (?, ?, ?, ?, ?)',
          )
        : null;
      const ids: number[] = [];
      for (const c of chunks) {
        const { lastInsertRowid } = ins.run(
          this.collectionId,
          filePath,
          contentHash,
          c.kind,
          c.lineStart,
          c.lineEnd,
          c.text,
        );
        ids.push(lastInsertRowid);
        fts?.run(c.text, filePath, c.lineStart, lastInsertRowid, this.collectionId);
      }
      return ids;
    });
  }

  /** All chunks for a file (for embedding during enrichment). */
  chunksForFile(
    filePath: string,
  ): Array<{ id: number; lineStart: number; lineEnd: number; text: string }> {
    return this.db
      .prepare(
        'SELECT id, line_start, line_end, text FROM chunks WHERE collection_id = ? AND file_path = ? ORDER BY id',
      )
      .all<{ id: number; line_start: number; line_end: number; text: string }>(
        this.collectionId,
        filePath,
      )
      .map((r) => ({ id: r.id, lineStart: r.line_start, lineEnd: r.line_end, text: r.text }));
  }

  /** Keyword search over converted-document / chunk text. */
  searchDocs(query: string, limit = 20): DocHit[] {
    if (!this.caps.fts) return [];
    return this.db
      .prepare(
        `SELECT file_path, line_start, chunk_id, snippet(fts_docs, 0, '', '', '…', 12) AS snip
         FROM fts_docs WHERE fts_docs MATCH ? AND collection_id = ? LIMIT ?`,
      )
      .all<{ file_path: string; line_start: number; chunk_id: number; snip: string }>(
        ftsPhrase(query),
        this.collectionId,
        limit,
      )
      .map((r) => ({
        filePath: r.file_path,
        lineStart: r.line_start,
        chunkId: r.chunk_id,
        snippet: r.snip,
      }));
  }

  // ── summaries ──────────────────────────────────────────────────────────

  upsertSummary(rec: {
    contentHash: string;
    filePath: string;
    summaryMd: string;
    tags?: string;
    model: string;
    provenance?: IndexProvenance;
  }): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO summaries (content_hash, collection_id, file_path, summary_md, tags, model,
                                  provider, gezel_id, gezel_name, app_version, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(content_hash) DO UPDATE SET
             file_path=excluded.file_path, summary_md=excluded.summary_md,
             tags=excluded.tags, model=excluded.model,
             provider=excluded.provider, gezel_id=excluded.gezel_id,
             gezel_name=excluded.gezel_name, app_version=excluded.app_version,
             created_at=excluded.created_at`,
        )
        .run(
          rec.contentHash,
          this.collectionId,
          rec.filePath,
          rec.summaryMd,
          rec.tags ?? null,
          rec.model,
          rec.provenance?.provider ?? null,
          rec.provenance?.gezelId ?? null,
          rec.provenance?.gezelName ?? null,
          rec.provenance?.appVersion ?? null,
          nowIso(),
        );
      if (this.caps.fts) {
        this.db
          .prepare('DELETE FROM fts_summaries WHERE content_hash = ? AND collection_id = ?')
          .run(rec.contentHash, this.collectionId);
        this.db
          .prepare(
            'INSERT INTO fts_summaries (summary, file_path, content_hash, collection_id) VALUES (?, ?, ?, ?)',
          )
          .run(rec.summaryMd, rec.filePath, rec.contentHash, this.collectionId);
      }
    });
  }

  getSummary(contentHash: string): string | undefined {
    return this.db
      .prepare('SELECT summary_md FROM summaries WHERE content_hash = ?')
      .get<{ summary_md: string }>(contentHash)?.summary_md;
  }

  /** Every non-trivial file that has an enrichment summary — the area-pass input. */
  fileSummaries(): Array<{ path: string; hash: string; summaryMd: string }> {
    return this.db
      .prepare(
        `SELECT f.path, f.hash, s.summary_md FROM files f
         JOIN summaries s ON s.content_hash = f.hash
         WHERE f.collection_id = ? AND f.trivial = 0 AND f.hash IS NOT NULL
         ORDER BY f.path`,
      )
      .all<{ path: string; hash: string; summary_md: string }>(this.collectionId)
      .map((r) => ({ path: r.path, hash: r.hash, summaryMd: r.summary_md }));
  }

  // ── symbol summaries (per-symbol LLM one-liners) ────────────────────────

  /**
   * Replace one file's symbol one-liners for a given content hash, pruning rows
   * for any other (stale) hash of the same file. Keyed by symbol name only —
   * overloads/same-name symbols share a line (accepted v1 simplification).
   */
  putSymbolSummaries(
    filePath: string,
    fileHash: string,
    entries: Array<{ name: string; summary: string }>,
    model?: string,
    provenance?: IndexProvenance,
  ): void {
    this.db.transaction(() => {
      this.db
        .prepare('DELETE FROM symbol_summaries WHERE collection_id = ? AND file_path = ?')
        .run(this.collectionId, filePath);
      const ins = this.db.prepare(
        `INSERT OR REPLACE INTO symbol_summaries (collection_id, file_path, file_hash, symbol_name, summary, model,
                                                  provider, gezel_id, gezel_name, app_version, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const at = nowIso();
      for (const e of entries) {
        ins.run(
          this.collectionId,
          filePath,
          fileHash,
          e.name,
          e.summary,
          model ?? null,
          provenance?.provider ?? null,
          provenance?.gezelId ?? null,
          provenance?.gezelName ?? null,
          provenance?.appVersion ?? null,
          at,
        );
      }
    });
  }

  /** name → one-liner for exactly this file@hash (empty when unenriched/stale). */
  symbolSummariesFor(filePath: string, fileHash: string): Map<string, string> {
    const out = new Map<string, string>();
    const rows = this.db
      .prepare(
        'SELECT symbol_name, summary FROM symbol_summaries WHERE collection_id = ? AND file_path = ? AND file_hash = ?',
      )
      .all<{ symbol_name: string; summary: string }>(this.collectionId, filePath, fileHash);
    for (const r of rows) out.set(r.symbol_name, r.summary);
    return out;
  }

  // ── file reviews (boekwachter cliffs notes + issues + health) ───────────

  /** Store a successful review; resets any failed-attempt bookkeeping. */
  upsertFileReview(rec: {
    contentHash: string;
    filePath: string;
    rubricHash: string;
    notesMd: string;
    issues: FileReviewIssue[];
    health: number;
    healthReason: string;
    model: string;
    provenance?: IndexProvenance;
  }): void {
    this.db
      .prepare(
        `INSERT INTO file_reviews (content_hash, collection_id, file_path, rubric_hash, notes_md,
                                   issues, health, health_reason, model,
                                   provider, gezel_id, gezel_name, app_version, reviewed_at,
                                   attempt_rubric_hash, attempts, last_attempt_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, NULL)
         ON CONFLICT(content_hash) DO UPDATE SET
           collection_id=excluded.collection_id, file_path=excluded.file_path,
           rubric_hash=excluded.rubric_hash, notes_md=excluded.notes_md,
           issues=excluded.issues, health=excluded.health,
           health_reason=excluded.health_reason, model=excluded.model,
           provider=excluded.provider, gezel_id=excluded.gezel_id,
           gezel_name=excluded.gezel_name, app_version=excluded.app_version,
           reviewed_at=excluded.reviewed_at,
           attempt_rubric_hash=NULL, attempts=0, last_attempt_at=NULL`,
      )
      .run(
        rec.contentHash,
        this.collectionId,
        rec.filePath,
        rec.rubricHash,
        rec.notesMd,
        JSON.stringify(rec.issues),
        rec.health,
        rec.healthReason,
        rec.model,
        rec.provenance?.provider ?? null,
        rec.provenance?.gezelId ?? null,
        rec.provenance?.gezelName ?? null,
        rec.provenance?.appVersion ?? null,
        nowIso(),
      );
  }

  /**
   * Terminal skip for content that CANNOT be reviewed under its current hash
   * — a doc whose conversion was blocked/failed, an empty file, a source
   * deleted between scan and review. Burns the whole attempt budget in one
   * write (success fields untouched) so `filesNeedingReview` stops selecting
   * the file; without this, one blocked doc permanently steals a batch slot
   * from its kind on every sweep. A content change (new hash) or a rubric
   * edit re-admits it exactly like any capped-out attempt.
   */
  markReviewUnavailable(
    contentHash: string,
    filePath: string,
    rubricHash: string,
    maxAttempts: number,
  ): void {
    this.db
      .prepare(
        `INSERT INTO file_reviews (content_hash, collection_id, file_path, attempt_rubric_hash, attempts, last_attempt_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(content_hash) DO UPDATE SET
           attempts = excluded.attempts,
           attempt_rubric_hash = excluded.attempt_rubric_hash,
           last_attempt_at = excluded.last_attempt_at`,
      )
      .run(contentHash, this.collectionId, filePath, rubricHash, maxAttempts, nowIso());
  }

  /**
   * Record a non-empty-but-unparseable review reply WITHOUT touching any
   * success field — a stale-rubric review keeps serving until a new one
   * lands. Attempts reset to 1 when the rubric changed since the last attempt
   * (a rubric edit earns a fresh retry budget).
   */
  recordReviewAttempt(contentHash: string, filePath: string, rubricHash: string): void {
    this.db
      .prepare(
        `INSERT INTO file_reviews (content_hash, collection_id, file_path, attempt_rubric_hash, attempts, last_attempt_at)
         VALUES (?, ?, ?, ?, 1, ?)
         ON CONFLICT(content_hash) DO UPDATE SET
           attempts = CASE WHEN COALESCE(file_reviews.attempt_rubric_hash, '') = excluded.attempt_rubric_hash
                           THEN COALESCE(file_reviews.attempts, 0) + 1 ELSE 1 END,
           attempt_rubric_hash = excluded.attempt_rubric_hash,
           last_attempt_at = excluded.last_attempt_at`,
      )
      .run(contentHash, this.collectionId, filePath, rubricHash, nowIso());
  }

  /** The successful review for a content hash (attempt-only rows excluded). */
  getFileReview(contentHash: string): FileReviewRow | undefined {
    const row = this.db
      .prepare(
        `SELECT notes_md, issues, health, health_reason, rubric_hash, model,
                provider, gezel_id, gezel_name, app_version, reviewed_at
         FROM file_reviews
         WHERE content_hash = ? AND notes_md IS NOT NULL AND health IS NOT NULL`,
      )
      .get<{
        notes_md: string;
        issues: string | null;
        health: number;
        health_reason: string | null;
        rubric_hash: string | null;
        model: string | null;
        provider: string | null;
        gezel_id: string | null;
        gezel_name: string | null;
        app_version: string | null;
        reviewed_at: string | null;
      }>(contentHash);
    if (!row) return undefined;
    return {
      notesMd: row.notes_md,
      issues: parseIssuesJson(row.issues),
      health: row.health,
      healthReason: row.health_reason ?? '',
      rubricHash: row.rubric_hash ?? '',
      model: row.model,
      provider: row.provider,
      gezelId: row.gezel_id,
      gezelName: row.gezel_name,
      appVersion: row.app_version,
      reviewedAt: row.reviewed_at,
    };
  }

  /**
   * Current file-hash review observations, including clean reviews. The
   * durable Boekwachter registry consumes these so a later file edit cannot
   * erase identity/lifecycle merely by invalidating `file_reviews`.
   */
  currentFileReviewIssues(): CurrentFileReviewIssues[] {
    return this.db
      .prepare(
        `SELECT f.path, f.hash AS content_hash, r.issues
         FROM files f
         JOIN file_reviews r ON r.content_hash = f.hash
         WHERE f.collection_id = ? AND f.hash IS NOT NULL AND r.notes_md IS NOT NULL
         ORDER BY f.path`,
      )
      .all<{ path: string; content_hash: string; issues: string | null }>(this.collectionId)
      .map((row) => ({
        path: row.path,
        contentHash: row.content_hash,
        issues: parseIssuesJson(row.issues),
      }));
  }

  /**
   * Files of one kind whose current hash needs a review under the given
   * rubric: no row yet, or covered by a DIFFERENT rubric and still holding
   * retry budget (attempts for another rubric don't count against it).
   * One query per kind — kinds with rubrics are few and LIMIT stays correct.
   */
  filesNeedingReview(
    kind: string,
    rubricHash: string,
    limit: number,
    maxAttempts: number,
  ): FileRecord[] {
    return this.db
      .prepare(
        `SELECT f.* FROM files f
         LEFT JOIN file_reviews r ON r.content_hash = f.hash
         WHERE f.collection_id = ? AND f.trivial = 0 AND f.hash IS NOT NULL
           AND f.kind = ? AND f.modality IN ('code','text','doc')
           AND (r.content_hash IS NULL
                OR (COALESCE(r.rubric_hash, '') <> ?
                    AND (COALESCE(r.attempt_rubric_hash, '') <> ? OR COALESCE(r.attempts, 0) < ?)))
         ORDER BY f.path LIMIT ?`,
      )
      .all<FileRow>(this.collectionId, kind, rubricHash, rubricHash, maxAttempts, limit)
      .map(rowToFile);
  }

  /** COUNT companion to {@link filesNeedingReview}. */
  countNeedingReview(kind: string, rubricHash: string, maxAttempts: number): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM files f
         LEFT JOIN file_reviews r ON r.content_hash = f.hash
         WHERE f.collection_id = ? AND f.trivial = 0 AND f.hash IS NOT NULL
           AND f.kind = ? AND f.modality IN ('code','text','doc')
           AND (r.content_hash IS NULL
                OR (COALESCE(r.rubric_hash, '') <> ?
                    AND (COALESCE(r.attempt_rubric_hash, '') <> ? OR COALESCE(r.attempts, 0) < ?)))`,
      )
      .get<{ n: number }>(this.collectionId, kind, rubricHash, rubricHash, maxAttempts);
    return row?.n ?? 0;
  }

  /**
   * Review coverage across the given rubric set. `reviewed` counts ANY
   * successful review on a current file hash regardless of rubric — coverage
   * must not visually wipe when a rubric is edited; `stale` are the reviewed
   * rows whose rubric has since changed (still served, lazily refreshed).
   * `pending` excludes attempt-capped files so it reaches 0 ("gave up" is
   * terminal until the content changes).
   */
  reviewCounts(
    rubrics: Array<{ kind: string; hash: string }>,
    maxAttempts: number,
  ): { eligible: number; reviewed: number; stale: number; pending: number } {
    let eligible = 0;
    let reviewed = 0;
    let stale = 0;
    let pending = 0;
    const BASE = `f.collection_id = ? AND f.trivial = 0 AND f.hash IS NOT NULL
           AND f.kind = ? AND f.modality IN ('code','text','doc')`;
    for (const r of rubrics) {
      eligible += Number(
        this.db
          .prepare(`SELECT COUNT(*) AS n FROM files f WHERE ${BASE}`)
          .get<{ n: number }>(this.collectionId, r.kind)?.n ?? 0,
      );
      reviewed += Number(
        this.db
          .prepare(
            `SELECT COUNT(*) AS n FROM files f
             JOIN file_reviews fr ON fr.content_hash = f.hash AND fr.notes_md IS NOT NULL
             WHERE ${BASE}`,
          )
          .get<{ n: number }>(this.collectionId, r.kind)?.n ?? 0,
      );
      stale += Number(
        this.db
          .prepare(
            `SELECT COUNT(*) AS n FROM files f
             JOIN file_reviews fr ON fr.content_hash = f.hash AND fr.notes_md IS NOT NULL
             WHERE ${BASE} AND COALESCE(fr.rubric_hash, '') <> ?`,
          )
          .get<{ n: number }>(this.collectionId, r.kind, r.hash)?.n ?? 0,
      );
      pending += this.countNeedingReview(r.kind, r.hash, maxAttempts);
    }
    return { eligible, reviewed, stale, pending };
  }

  /**
   * Aggregate health rollup for map_repo / the Overview page. `eligibleFiles`
   * depends on which kinds currently have rubrics; the other aggregates cover
   * every successful review on a current file hash (a review whose kind lost
   * its rubric is still served per-file, so it still counts here).
   */
  reviewRollup(rubrics: Array<{ kind: string; hash: string }>): {
    reviewedFiles: number;
    eligibleFiles: number;
    avgHealth: number;
    issueCounts: { major: number; minor: number; info: number };
    worstFiles: Array<{ path: string; health: number; reason?: string }>;
  } {
    const REVIEWED = `f.collection_id = ? AND f.trivial = 0 AND f.hash IS NOT NULL
           AND f.modality IN ('code','text','doc')
           AND r.notes_md IS NOT NULL AND r.health IS NOT NULL`;
    const agg = this.db
      .prepare(
        `SELECT COUNT(*) AS n, AVG(r.health) AS avg FROM files f
         JOIN file_reviews r ON r.content_hash = f.hash
         WHERE ${REVIEWED}`,
      )
      .get<{ n: number; avg: number | null }>(this.collectionId);
    let eligibleFiles = 0;
    for (const ru of rubrics) {
      eligibleFiles += Number(
        this.db
          .prepare(
            `SELECT COUNT(*) AS n FROM files f
             WHERE f.collection_id = ? AND f.trivial = 0 AND f.hash IS NOT NULL
               AND f.kind = ? AND f.modality IN ('code','text','doc')`,
          )
          .get<{ n: number }>(this.collectionId, ru.kind)?.n ?? 0,
      );
    }
    const issueCounts = { major: 0, minor: 0, info: 0 };
    for (const row of this.db
      .prepare(
        `SELECT COALESCE(json_extract(j.value, '$.severity'), 'info') AS sev, COUNT(*) AS n
         FROM files f
         JOIN file_reviews r ON r.content_hash = f.hash
         CROSS JOIN json_each(COALESCE(r.issues, '[]')) j
         WHERE ${REVIEWED}
         GROUP BY sev`,
      )
      .all<{ sev: string; n: number }>(this.collectionId)) {
      if (row.sev === 'major' || row.sev === 'minor' || row.sev === 'info') {
        issueCounts[row.sev] = Number(row.n);
      }
    }
    const worstFiles = this.db
      .prepare(
        `SELECT f.path, r.health, r.health_reason FROM files f
         JOIN file_reviews r ON r.content_hash = f.hash
         WHERE ${REVIEWED}
         ORDER BY r.health ASC, f.path LIMIT 5`,
      )
      .all<{ path: string; health: number; health_reason: string | null }>(this.collectionId)
      .map((r) => ({
        path: r.path,
        health: r.health,
        ...(r.health_reason ? { reason: r.health_reason } : {}),
      }));
    return {
      reviewedFiles: Number(agg?.n ?? 0),
      eligibleFiles,
      avgHealth: agg?.avg != null ? Math.round(agg.avg * 10) / 10 : 0,
      issueCounts,
      worstFiles,
    };
  }

  /**
   * Flat issue list across current-hash reviews, worst-severity first. Serves
   * `list_file_issues`; counts are aggregated separately (GROUP BY, unlimited)
   * so the LIMIT here can't under-count them.
   */
  fileIssues(
    filter: {
      severity?: string;
      category?: string;
      pathPrefix?: string;
      limit?: number;
    } = {},
  ): {
    issues: Array<{
      path: string;
      severity: string;
      category: string;
      message: string;
      line?: number;
    }>;
    counts: {
      total: number;
      bySeverity: Record<string, number>;
      byCategory: Record<string, number>;
    };
    reviewers: Array<{
      model: string | null;
      provider: string | null;
      gezelName: string | null;
      files: number;
    }>;
  } {
    const where: string[] = [
      `f.collection_id = ? AND f.trivial = 0 AND f.hash IS NOT NULL
       AND f.modality IN ('code','text','doc') AND r.notes_md IS NOT NULL`,
    ];
    const params: (string | number)[] = [this.collectionId];
    if (filter.severity) {
      where.push(`json_extract(j.value, '$.severity') = ?`);
      params.push(filter.severity);
    }
    if (filter.category) {
      where.push(`json_extract(j.value, '$.category') = ?`);
      params.push(filter.category);
    }
    if (filter.pathPrefix) {
      where.push("f.path LIKE ? || '%'");
      params.push(filter.pathPrefix);
    }
    const FROM = `FROM files f
         JOIN file_reviews r ON r.content_hash = f.hash
         CROSS JOIN json_each(COALESCE(r.issues, '[]')) j
         WHERE ${where.join(' AND ')}`;
    const SEV_RANK = `CASE json_extract(j.value, '$.severity') WHEN 'major' THEN 0 WHEN 'minor' THEN 1 ELSE 2 END`;
    const rows = this.db
      .prepare(
        `SELECT f.path,
                COALESCE(json_extract(j.value, '$.severity'), 'info') AS severity,
                COALESCE(json_extract(j.value, '$.category'), 'general') AS category,
                COALESCE(json_extract(j.value, '$.message'), '') AS message,
                json_extract(j.value, '$.line') AS line
         ${FROM}
         ORDER BY ${SEV_RANK}, f.path LIMIT ?`,
      )
      .all<{
        path: string;
        severity: string;
        category: string;
        message: string;
        line: number | null;
      }>(...params, filter.limit ?? 200);
    const tally = (expr: string): Record<string, number> => {
      const out: Record<string, number> = {};
      for (const r of this.db
        .prepare(`SELECT ${expr} AS k, COUNT(*) AS n ${FROM} GROUP BY k`)
        .all<{ k: string | null; n: number }>(...params)) {
        if (r.k) out[r.k] = Number(r.n);
      }
      return out;
    };
    const bySeverity = tally(`COALESCE(json_extract(j.value, '$.severity'), 'info')`);
    // Distinct reviewer identities over the same filtered row set — the
    // provenance line for list_file_issues. DISTINCT content_hash (not the
    // json_each product) so a 10-issue file still counts as one file.
    const reviewers = this.db
      .prepare(
        `SELECT r.model, r.provider, r.gezel_name, COUNT(DISTINCT r.content_hash) AS files
         ${FROM}
         GROUP BY r.model, r.provider, r.gezel_name
         ORDER BY files DESC LIMIT 5`,
      )
      .all<{
        model: string | null;
        provider: string | null;
        gezel_name: string | null;
        files: number;
      }>(...params)
      .map((r) => ({
        model: r.model,
        provider: r.provider,
        gezelName: r.gezel_name,
        files: Number(r.files),
      }));
    return {
      issues: rows
        .filter((r) => r.message)
        .map((r) => ({
          path: r.path,
          severity: r.severity,
          category: r.category,
          message: r.message,
          ...(typeof r.line === 'number' && r.line > 0 ? { line: r.line } : {}),
        })),
      counts: {
        total: Object.values(bySeverity).reduce((a, b) => a + b, 0),
        bySeverity,
        byCategory: tally(`COALESCE(json_extract(j.value, '$.category'), 'general')`),
      },
      reviewers,
    };
  }

  // ── area summaries (deep pass) ─────────────────────────────────────────

  upsertAreaSummary(rec: {
    areaPath: string;
    inputHash: string;
    summaryMd: string;
    model: string;
    provenance?: IndexProvenance;
  }): void {
    this.db
      .prepare(
        `INSERT INTO area_summaries (collection_id, area_path, input_hash, summary_md, model,
                                     provider, gezel_id, gezel_name, app_version, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(collection_id, area_path) DO UPDATE SET
           input_hash=excluded.input_hash, summary_md=excluded.summary_md,
           model=excluded.model,
           provider=excluded.provider, gezel_id=excluded.gezel_id,
           gezel_name=excluded.gezel_name, app_version=excluded.app_version,
           created_at=excluded.created_at`,
      )
      .run(
        this.collectionId,
        rec.areaPath,
        rec.inputHash,
        rec.summaryMd,
        rec.model,
        rec.provenance?.provider ?? null,
        rec.provenance?.gezelId ?? null,
        rec.provenance?.gezelName ?? null,
        rec.provenance?.appVersion ?? null,
        nowIso(),
      );
  }

  getAreaSummary(areaPath: string): { summaryMd: string; inputHash: string } | undefined {
    const row = this.db
      .prepare(
        'SELECT summary_md, input_hash FROM area_summaries WHERE collection_id = ? AND area_path = ?',
      )
      .get<{ summary_md: string; input_hash: string }>(this.collectionId, areaPath);
    return row ? { summaryMd: row.summary_md, inputHash: row.input_hash } : undefined;
  }

  allAreaSummaries(): Array<{ areaPath: string; summaryMd: string; inputHash: string }> {
    return this.db
      .prepare(
        'SELECT area_path, summary_md, input_hash FROM area_summaries WHERE collection_id = ?',
      )
      .all<{ area_path: string; summary_md: string; input_hash: string }>(this.collectionId)
      .map((r) => ({ areaPath: r.area_path, summaryMd: r.summary_md, inputHash: r.input_hash }));
  }

  // ── metadata ───────────────────────────────────────────────────────────

  /** Replace a file's metadata. Keys under the reserved `git:` prefix are
   *  preserved — they belong to the git-stats ingester, and a frontmatter or
   *  image re-index must never clobber them. */
  setMetadata(filePath: string, entries: Array<{ key: string; value: string }>): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          "DELETE FROM metadata WHERE collection_id = ? AND path = ? AND key NOT LIKE 'git:%'",
        )
        .run(this.collectionId, filePath);
      const ins = this.db.prepare(
        'INSERT INTO metadata (collection_id, path, key, value) VALUES (?, ?, ?, ?)',
      );
      for (const e of entries) ins.run(this.collectionId, filePath, e.key, e.value);
    });
  }

  getMetadata(filePath: string): Record<string, string> {
    const rows = this.db
      .prepare('SELECT key, value FROM metadata WHERE collection_id = ? AND path = ?')
      .all<{ key: string; value: string }>(this.collectionId, filePath);
    const out: Record<string, string> = {};
    for (const r of rows) out[r.key] = r.value;
    return out;
  }

  /** Upsert specific metadata keys for one file (delete-then-insert; the
   *  table has no unique constraint). */
  mergeMetadata(filePath: string, entries: Array<{ key: string; value: string }>): void {
    if (entries.length === 0) return;
    this.db.transaction(() => {
      const del = this.db.prepare(
        'DELETE FROM metadata WHERE collection_id = ? AND path = ? AND key = ?',
      );
      const ins = this.db.prepare(
        'INSERT INTO metadata (collection_id, path, key, value) VALUES (?, ?, ?, ?)',
      );
      for (const e of entries) {
        del.run(this.collectionId, filePath, e.key);
        ins.run(this.collectionId, filePath, e.key, e.value);
      }
    });
  }

  /** Atomically replace every metadata row whose key starts with `prefix`.
   *  A full rewrite per ingest is idempotent and self-prunes rows for files
   *  that no longer exist. */
  replaceMetadataForKeyPrefix(
    prefix: string,
    rows: Array<{ path: string; key: string; value: string }>,
  ): void {
    this.db.transaction(() => {
      this.db
        .prepare("DELETE FROM metadata WHERE collection_id = ? AND key LIKE ? || '%'")
        .run(this.collectionId, prefix);
      const ins = this.db.prepare(
        'INSERT INTO metadata (collection_id, path, key, value) VALUES (?, ?, ?, ?)',
      );
      for (const r of rows) ins.run(this.collectionId, r.path, r.key, r.value);
    });
  }

  /** Bulk read: all files' values for the given keys in one query
   *  (path → key → value). The map build reads churn this way instead of
   *  issuing per-file getMetadata calls. */
  metadataValuesForKeys(keys: string[]): Map<string, Record<string, string>> {
    const out = new Map<string, Record<string, string>>();
    if (keys.length === 0) return out;
    const placeholders = keys.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `SELECT path, key, value FROM metadata WHERE collection_id = ? AND key IN (${placeholders})`,
      )
      .all<{ path: string; key: string; value: string }>(this.collectionId, ...keys);
    for (const r of rows) {
      let rec = out.get(r.path);
      if (!rec) {
        rec = {};
        out.set(r.path, rec);
      }
      rec[r.key] = r.value;
    }
    return out;
  }

  // ── images ───────────────────────────────────────────────────────────────

  /** Image files, optionally restricted to a folder prefix. */
  imageFiles(prefix?: string): FileRecord[] {
    const clause = prefix ? " AND path LIKE ? || '%'" : '';
    const params: string[] = [this.collectionId];
    if (prefix) params.push(prefix.endsWith('/') ? prefix : `${prefix}/`);
    return this.db
      .prepare(
        `SELECT * FROM files WHERE collection_id = ? AND modality = 'image'${clause} ORDER BY path`,
      )
      .all<FileRow>(...params)
      .map(rowToFile);
  }

  /** Store a CLIP-style image embedding (boekwachter, when a vision model runs). */
  addImageVector(chunkId: number, filePath: string, vec: number[] | Float32Array): void {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO image_vectors (chunk_id, collection_id, file_path, vec) VALUES (?, ?, ?, ?)',
      )
      .run(BigInt(Math.trunc(chunkId)), this.collectionId, filePath, vectorToBlob(vec));
  }

  /** All stored image vectors for this collection (brute-force similarity). */
  allImageVectors(): Array<{ chunkId: number; filePath: string; vec: Float32Array }> {
    return this.db
      .prepare('SELECT chunk_id, file_path, vec FROM image_vectors WHERE collection_id = ?')
      .all<{ chunk_id: number; file_path: string; vec: Uint8Array }>(this.collectionId)
      .map((r) => ({
        chunkId: Number(r.chunk_id),
        filePath: r.file_path,
        vec: new Float32Array(r.vec.buffer, r.vec.byteOffset, Math.floor(r.vec.byteLength / 4)),
      }));
  }

  /** The id of an image file's single indexed chunk (vec rowid key). */
  imageChunkId(filePath: string): number | null {
    const c = this.chunksForFile(filePath)[0];
    return c ? c.id : null;
  }

  // ── entities (meta-boekwachter) ────────────────────────────────────────────

  /** Find an entity by (kind, canonical), creating it if absent. Returns its id. */
  upsertEntity(kind: string, label: string, canonical: string): number {
    const existing = this.db
      .prepare('SELECT id FROM entities WHERE kind = ? AND canonical = ?')
      .get<{ id: number }>(kind, canonical);
    if (existing) return Number(existing.id);
    const { lastInsertRowid } = this.db
      .prepare('INSERT INTO entities (kind, label, canonical) VALUES (?, ?, ?)')
      .run(kind, label, canonical);
    return Number(lastInsertRowid);
  }

  addEntityMention(
    entityId: number,
    filePath: string,
    opts: { line?: number; confidence?: number } = {},
  ): void {
    this.db
      .prepare(
        'INSERT INTO entity_mentions (entity_id, collection_id, file_path, line, confidence) VALUES (?, ?, ?, ?, ?)',
      )
      .run(
        BigInt(Math.trunc(entityId)),
        this.collectionId,
        filePath,
        opts.line ?? null,
        opts.confidence ?? null,
      );
  }

  /** Clear all entities + mentions for this collection (rebuild). */
  clearEntities(): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM entity_mentions WHERE collection_id = ?').run(this.collectionId);
      // entities are per-db; drop any with no remaining mentions.
      this.db.exec(
        'DELETE FROM entities WHERE id NOT IN (SELECT DISTINCT entity_id FROM entity_mentions)',
      );
    });
  }

  /** Entities matching a label substring (or all), with mention counts. */
  findEntities(
    query: string | undefined,
    opts: { kind?: string; limit?: number } = {},
  ): Array<{ id: number; kind: string; label: string; canonical: string; mentions: number }> {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (query) {
      where.push("e.label LIKE '%' || ? || '%'");
      params.push(query);
    }
    if (opts.kind) {
      where.push('e.kind = ?');
      params.push(opts.kind);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    params.push(opts.limit ?? 50);
    return this.db
      .prepare(
        `SELECT e.id, e.kind, e.label, e.canonical, COUNT(m.entity_id) AS mentions
         FROM entities e
         JOIN entity_mentions m ON m.entity_id = e.id AND m.collection_id = ?
         ${clause}
         GROUP BY e.id ORDER BY mentions DESC LIMIT ?`,
      )
      .all<{ id: number; kind: string; label: string; canonical: string; mentions: number }>(
        this.collectionId,
        ...params,
      )
      .map((r) => ({ ...r, id: Number(r.id), mentions: Number(r.mentions) }));
  }

  entityMentions(entityId: number, limit = 100): Array<{ filePath: string; line: number | null }> {
    return this.db
      .prepare(
        'SELECT file_path, line FROM entity_mentions WHERE entity_id = ? AND collection_id = ? LIMIT ?',
      )
      .all<{ file_path: string; line: number | null }>(
        BigInt(Math.trunc(entityId)),
        this.collectionId,
        limit,
      )
      .map((r) => ({ filePath: r.file_path, line: r.line }));
  }

  // ── text vectors ───────────────────────────────────────────────────────

  addTextVector(chunkId: number, embedding: number[] | Float32Array): void {
    if (!this.caps.vec) return;
    // vec0 rejects a REAL primary key; node:sqlite binds JS numbers as REAL, so
    // bind the rowid as a BigInt to force INTEGER affinity.
    this.db
      .prepare('INSERT OR REPLACE INTO vec_text (rowid, embedding) VALUES (?, ?)')
      .run(BigInt(Math.trunc(chunkId)), vectorToBlob(embedding));
  }

  /** KNN over text chunk vectors, joined back to chunk metadata. */
  searchTextVectors(embedding: number[] | Float32Array, k = 10): VectorHit[] {
    if (!this.caps.vec) return [];
    // Overfetch then join+filter by collection (vec_text has no collection col).
    const rows = this.db
      .prepare(
        'SELECT rowid, distance FROM vec_text WHERE embedding MATCH ? ORDER BY distance LIMIT ?',
      )
      .all<{ rowid: number | bigint; distance: number }>(vectorToBlob(embedding), k * 4);
    const hits: VectorHit[] = [];
    const get = this.db.prepare(
      'SELECT file_path, line_start, line_end, text FROM chunks WHERE id = ? AND collection_id = ?',
    );
    for (const r of rows) {
      const chunkId = Number(r.rowid);
      const c = get.get<{
        file_path: string;
        line_start: number;
        line_end: number;
        text: string;
      }>(chunkId, this.collectionId);
      if (!c) continue;
      hits.push({
        chunkId,
        filePath: c.file_path,
        lineStart: c.line_start,
        lineEnd: c.line_end,
        text: c.text,
        distance: r.distance,
      });
      if (hits.length >= k) break;
    }
    return hits;
  }

  // ── imports (dependency edges) ───────────────────────────────────────────

  /** Replace all import edges for a file (idempotent re-index of one file). */
  putImports(srcPath: string, fileHash: string | null, edges: ImportEdgeInput[]): void {
    this.db.transaction(() => {
      this.db
        .prepare('DELETE FROM imports WHERE collection_id = ? AND src_path = ?')
        .run(this.collectionId, srcPath);
      const ins = this.db.prepare(
        `INSERT OR IGNORE INTO imports (collection_id, src_path, raw_specifier, dst_path, file_hash, bindings)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      // '[]' (recorded, takes no names — side-effect import) is distinct from
      // NULL (not recorded — legacy row or undissected language, counts as a
      // whole-module import).
      for (const e of edges) {
        ins.run(
          this.collectionId,
          srcPath,
          e.raw,
          null,
          fileHash,
          e.bindings ? JSON.stringify(e.bindings) : null,
        );
      }
    });
  }

  /** Every raw import edge in the collection (resolved to targets at build time). */
  allImports(): Array<{ srcPath: string; raw: string }> {
    return this.db
      .prepare('SELECT src_path, raw_specifier FROM imports WHERE collection_id = ?')
      .all<{ src_path: string; raw_specifier: string }>(this.collectionId)
      .map((r) => ({ srcPath: r.src_path, raw: r.raw_specifier }));
  }

  /** Every raw import edge including parsed bindings (null = never recorded). */
  allImportsWithBindings(): Array<{
    srcPath: string;
    raw: string;
    bindings: ImportBinding[] | null;
  }> {
    return this.db
      .prepare('SELECT src_path, raw_specifier, bindings FROM imports WHERE collection_id = ?')
      .all<{ src_path: string; raw_specifier: string; bindings: string | null }>(this.collectionId)
      .map((r) => ({
        srcPath: r.src_path,
        raw: r.raw_specifier,
        bindings: parseBindings(r.bindings),
      }));
  }

  /** One file's outbound raw imports including bindings. */
  importsForFile(srcPath: string): Array<{ raw: string; bindings: ImportBinding[] | null }> {
    return this.db
      .prepare(
        'SELECT raw_specifier, bindings FROM imports WHERE collection_id = ? AND src_path = ?',
      )
      .all<{ raw_specifier: string; bindings: string | null }>(this.collectionId, srcPath)
      .map((r) => ({ raw: r.raw_specifier, bindings: parseBindings(r.bindings) }));
  }

  /** Every indexed path — the probe set for import resolution. */
  allFilePaths(): string[] {
    return this.db
      .prepare('SELECT path FROM files WHERE collection_id = ? ORDER BY path')
      .all<{ path: string }>(this.collectionId)
      .map((r) => r.path);
  }

  // ── security findings + dependencies (security-intel) ────────────────────

  /**
   * Replace one file's BUILT-IN findings (the per-file hot-path tier). Scoped to
   * `source='builtin'` so it never wipes the whole-repo OSS-tool findings for the
   * same file; hash-gated like symbols/imports.
   */
  putBuiltinFindings(
    filePath: string,
    fileHash: string | null,
    findings: SecurityFindingInput[],
  ): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          "DELETE FROM security_findings WHERE collection_id = ? AND file_path = ? AND source = 'builtin'",
        )
        .run(this.collectionId, filePath);
      const ins = this.db.prepare(
        `INSERT INTO security_findings (collection_id, file_path, line, rule_id, category, severity, source, title, evidence, fingerprint, file_hash)
         VALUES (?, ?, ?, ?, ?, ?, 'builtin', ?, ?, ?, ?)`,
      );
      for (const f of findings) {
        ins.run(
          this.collectionId,
          filePath,
          f.line,
          f.ruleId,
          f.category,
          f.severity,
          f.title,
          f.evidence ?? null,
          f.fingerprint ?? `${f.ruleId}:${filePath}:${f.line ?? 0}`,
          fileHash,
        );
      }
      this.pruneOrphanedFindingLifecycle();
    });
  }

  /**
   * Replace ALL findings from one OSS tool (whole-repo, per scan). Each finding
   * carries its own `filePath`. Clearing-then-inserting per `source` keeps the
   * built-in tier and the other tools independent.
   */
  replaceToolFindings(
    source: Exclude<SecuritySource, 'builtin'>,
    findings: Array<SecurityFindingInput & { filePath: string }>,
  ): void {
    this.db.transaction(() => {
      this.db
        .prepare('DELETE FROM security_findings WHERE collection_id = ? AND source = ?')
        .run(this.collectionId, source);
      const ins = this.db.prepare(
        `INSERT INTO security_findings (collection_id, file_path, line, rule_id, category, severity, source, title, evidence, fingerprint, file_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      );
      for (const f of findings) {
        ins.run(
          this.collectionId,
          f.filePath,
          f.line,
          f.ruleId,
          f.category,
          f.severity,
          source,
          f.title,
          f.evidence ?? null,
          f.fingerprint ?? `${source}:${f.ruleId}:${f.filePath}:${f.line ?? 0}`,
        );
      }
      this.pruneOrphanedFindingLifecycle();
    });
  }

  /** Drop lifecycle state once its scanner-owned finding has disappeared. */
  private pruneOrphanedFindingLifecycle(): void {
    this.db
      .prepare(
        `DELETE FROM security_finding_lifecycle
         WHERE collection_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM security_findings sf
             WHERE sf.collection_id = security_finding_lifecycle.collection_id
               AND sf.fingerprint = security_finding_lifecycle.fingerprint
           )`,
      )
      .run(this.collectionId);
  }

  /** Replace the query overlay from Store's durable project-owned state. */
  syncSecurityFindingLifecycle(
    findings: Record<
      string,
      { status: SecurityFindingStatus; taskRef?: string; resolvedAt?: string }
    >,
  ): void {
    this.db.transaction(() => {
      this.db
        .prepare('DELETE FROM security_finding_lifecycle WHERE collection_id = ?')
        .run(this.collectionId);
      const insert = this.db.prepare(
        `INSERT INTO security_finding_lifecycle
           (collection_id, fingerprint, status, task_ref, resolved_at)
         VALUES (?, ?, ?, ?, ?)`,
      );
      for (const [fingerprint, row] of Object.entries(findings)) {
        insert.run(
          this.collectionId,
          fingerprint,
          row.status,
          row.taskRef ?? null,
          row.resolvedAt ?? null,
        );
      }
    });
  }

  /** Scanner-owned fingerprints after a completed refresh. */
  securityFindingFingerprints(): Set<string> {
    const rows = this.db
      .prepare(
        `SELECT source, rule_id, file_path, line, fingerprint
         FROM security_findings WHERE collection_id = ?`,
      )
      .all<{
        source: string | null;
        rule_id: string;
        file_path: string;
        line: number | null;
        fingerprint: string | null;
      }>(this.collectionId);
    return new Set(
      rows.map((row) =>
        row.fingerprint
          ? row.fingerprint
          : row.source === 'builtin'
            ? `${row.rule_id}:${row.file_path}:${row.line ?? 0}`
            : `${row.source ?? 'builtin'}:${row.rule_id}:${row.file_path}:${row.line ?? 0}`,
      ),
    );
  }

  /** Findings, newest-severity-first, with optional filters. */
  securityFindings(
    filter: {
      severity?: SecuritySeverity;
      category?: string;
      pathPrefix?: string;
      source?: SecuritySource;
      limit?: number;
    } = {},
  ): SecurityFindingRow[] {
    const where: string[] = ['sf.collection_id = ?', "COALESCE(l.status, 'open') <> 'resolved'"];
    const params: (string | number)[] = [this.collectionId];
    if (filter.severity) {
      where.push('sf.severity = ?');
      params.push(filter.severity);
    }
    if (filter.category) {
      where.push('sf.category = ?');
      params.push(filter.category);
    }
    if (filter.source) {
      where.push('sf.source = ?');
      params.push(filter.source);
    }
    if (filter.pathPrefix) {
      where.push("sf.file_path LIKE ? || '%'");
      params.push(filter.pathPrefix);
    }
    params.push(filter.limit ?? 500);
    return this.db
      .prepare(
        `SELECT sf.file_path, sf.line, sf.rule_id, sf.category, sf.severity, sf.source,
                sf.title, sf.evidence, sf.fingerprint,
                COALESCE(l.status, 'open') AS finding_status, l.task_ref
         FROM security_findings sf
         LEFT JOIN security_finding_lifecycle l
           ON l.collection_id = sf.collection_id AND l.fingerprint = sf.fingerprint
         WHERE ${where.join(' AND ')}
         ORDER BY ${SEVERITY_RANK_SQL}, sf.file_path, sf.line LIMIT ?`,
      )
      .all<SecurityFindingDbRow>(...params)
      .map(rowToFinding);
  }

  /** One file's findings, exact-path match, line order. */
  securityFindingsForFile(filePath: string, limit = 100): SecurityFindingRow[] {
    return this.db
      .prepare(
        `SELECT sf.file_path, sf.line, sf.rule_id, sf.category, sf.severity, sf.source,
                sf.title, sf.evidence, sf.fingerprint,
                COALESCE(l.status, 'open') AS finding_status, l.task_ref
         FROM security_findings sf
         LEFT JOIN security_finding_lifecycle l
           ON l.collection_id = sf.collection_id AND l.fingerprint = sf.fingerprint
         WHERE sf.collection_id = ? AND sf.file_path = ?
           AND COALESCE(l.status, 'open') <> 'resolved'
         ORDER BY sf.line IS NULL, sf.line, ${SEVERITY_RANK_SQL} LIMIT ?`,
      )
      .all<SecurityFindingDbRow>(this.collectionId, filePath, limit)
      .map(rowToFinding);
  }

  /** Exact lifecycle target used by the resolve/delegate HTTP actions. */
  securityFindingByFingerprint(fingerprint: string): SecurityFindingRow | null {
    const row = this.db
      .prepare(
        `SELECT sf.file_path, sf.line, sf.rule_id, sf.category, sf.severity, sf.source,
                sf.title, sf.evidence, sf.fingerprint,
                COALESCE(l.status, 'open') AS finding_status, l.task_ref
         FROM security_findings sf
         LEFT JOIN security_finding_lifecycle l
           ON l.collection_id = sf.collection_id AND l.fingerprint = sf.fingerprint
         WHERE sf.collection_id = ? AND sf.fingerprint = ? LIMIT 1`,
      )
      .get<SecurityFindingDbRow>(this.collectionId, fingerprint);
    return row ? rowToFinding(row) : null;
  }

  /** Mark one finding open/in-progress/resolved without mutating scanner rows. */
  setSecurityFindingStatus(
    fingerprint: string,
    status: SecurityFindingStatus,
    taskRef?: string,
  ): boolean {
    const exists = this.db
      .prepare(
        'SELECT 1 AS present FROM security_findings WHERE collection_id = ? AND fingerprint = ? LIMIT 1',
      )
      .get<{ present: number }>(this.collectionId, fingerprint);
    if (!exists) return false;
    this.db
      .prepare(
        `INSERT INTO security_finding_lifecycle
           (collection_id, fingerprint, status, task_ref, resolved_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(collection_id, fingerprint) DO UPDATE SET
           status = excluded.status,
           task_ref = excluded.task_ref,
           resolved_at = excluded.resolved_at`,
      )
      .run(
        this.collectionId,
        fingerprint,
        status,
        taskRef ?? null,
        status === 'resolved' ? nowIso() : null,
      );
    return true;
  }

  /** Close every finding linked to a successfully completed worker task. */
  resolveSecurityFindingsForTask(taskRef: string): number {
    const result = this.db
      .prepare(
        `UPDATE security_finding_lifecycle
         SET status = 'resolved', resolved_at = ?
         WHERE collection_id = ? AND task_ref = ? AND status <> 'resolved'`,
      )
      .run(nowIso(), this.collectionId, taskRef);
    return Number(result.changes ?? 0);
  }

  /** A canceled worker task gives ownership back to the open queue. */
  reopenSecurityFindingsForTask(taskRef: string): number {
    const result = this.db
      .prepare(
        `UPDATE security_finding_lifecycle
         SET status = 'open', task_ref = NULL, resolved_at = NULL
         WHERE collection_id = ? AND task_ref = ? AND status = 'in_progress'`,
      )
      .run(this.collectionId, taskRef);
    return Number(result.changes ?? 0);
  }

  /**
   * Per-file finding tallies for the map's health layer — a full aggregate,
   * deliberately not built on `securityFindings()` (its 500-row limit would
   * silently under-count on big repos).
   */
  securityFindingCountsByFile(): Map<string, { count: number; maxSeverity: string | null }> {
    const rank: Record<string, number> = { critical: 5, high: 4, medium: 3, low: 2, info: 1 };
    const out = new Map<string, { count: number; maxSeverity: string | null }>();
    const rows = this.db
      .prepare(
        `SELECT sf.file_path, sf.severity, COUNT(*) AS n FROM security_findings sf
         LEFT JOIN security_finding_lifecycle l
           ON l.collection_id = sf.collection_id AND l.fingerprint = sf.fingerprint
         WHERE sf.collection_id = ? AND COALESCE(l.status, 'open') <> 'resolved'
         GROUP BY sf.file_path, sf.severity`,
      )
      .all<{ file_path: string; severity: string | null; n: number }>(this.collectionId);
    for (const r of rows) {
      const cur = out.get(r.file_path) ?? { count: 0, maxSeverity: null };
      cur.count += r.n;
      const sev = r.severity?.toLowerCase() ?? null;
      if (sev && (rank[sev] ?? 0) > (cur.maxSeverity ? (rank[cur.maxSeverity] ?? 0) : 0)) {
        cur.maxSeverity = sev;
      }
      out.set(r.file_path, cur);
    }
    return out;
  }

  /** Aggregate finding counts by severity / category / source. */
  securityFindingCounts(): {
    total: number;
    bySeverity: Record<string, number>;
    byCategory: Record<string, number>;
    bySource: Record<string, number>;
  } {
    const tally = (col: string): Record<string, number> => {
      const out: Record<string, number> = {};
      for (const r of this.db
        .prepare(
          `SELECT sf.${col} AS k, COUNT(*) AS n FROM security_findings sf
           LEFT JOIN security_finding_lifecycle l
             ON l.collection_id = sf.collection_id AND l.fingerprint = sf.fingerprint
           WHERE sf.collection_id = ? AND COALESCE(l.status, 'open') <> 'resolved'
           GROUP BY sf.${col}`,
        )
        .all<{ k: string | null; n: number }>(this.collectionId)) {
        if (r.k) out[r.k] = Number(r.n);
      }
      return out;
    };
    const bySeverity = tally('severity');
    return {
      total: Object.values(bySeverity).reduce((a, b) => a + b, 0),
      bySeverity,
      byCategory: tally('category'),
      bySource: tally('source'),
    };
  }

  /** Replace the whole-repo dependency inventory. */
  replaceDependencies(deps: DependencyInput[]): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM dependencies WHERE collection_id = ?').run(this.collectionId);
      const ins = this.db.prepare(
        `INSERT OR REPLACE INTO dependencies (collection_id, name, ecosystem, version, direct, advisory_ids, max_severity, license)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const d of deps) {
        ins.run(
          this.collectionId,
          d.name,
          d.ecosystem,
          d.version,
          d.direct ? 1 : 0,
          d.advisoryIds?.length ? JSON.stringify(d.advisoryIds) : null,
          d.maxSeverity ?? null,
          d.license ?? null,
        );
      }
    });
  }

  /** The dependency inventory, advisory-bearing first then by name. */
  dependencies(): DependencyRow[] {
    return this.db
      .prepare(
        `SELECT name, ecosystem, version, direct, advisory_ids, max_severity, license
         FROM dependencies WHERE collection_id = ?
         ORDER BY (advisory_ids IS NOT NULL) DESC, name`,
      )
      .all<{
        name: string;
        ecosystem: string;
        version: string | null;
        direct: number;
        advisory_ids: string | null;
        max_severity: string | null;
        license: string | null;
      }>(this.collectionId)
      .map((r) => ({
        name: r.name,
        ecosystem: r.ecosystem,
        version: r.version,
        direct: !!r.direct,
        advisoryIds: r.advisory_ids ? (JSON.parse(r.advisory_ids) as string[]) : [],
        maxSeverity: (r.max_severity as SecuritySeverity | null) ?? null,
        license: r.license,
      }));
  }

  // ── map layout (persisted city coordinates) ──────────────────────────────

  /** All stored layout nodes for a domain (live + tombstoned). */
  layoutNodes(domain: string): LayoutRow[] {
    return this.db
      .prepare(
        `SELECT node_kind, node_id, parent_id, content_hash, x, y, w, h, weight, placed_at, removed_at
         FROM map_layout WHERE collection_id = ? AND domain = ?`,
      )
      .all<{
        node_kind: string;
        node_id: string;
        parent_id: string | null;
        content_hash: string | null;
        x: number;
        y: number;
        w: number;
        h: number;
        weight: number;
        placed_at: string | null;
        removed_at: string | null;
      }>(this.collectionId, domain)
      .map((r) => ({
        nodeKind: r.node_kind as LayoutRow['nodeKind'],
        nodeId: r.node_id,
        parentId: r.parent_id,
        contentHash: r.content_hash,
        x: r.x,
        y: r.y,
        w: r.w,
        h: r.h,
        weight: r.weight,
        placedAt: r.placed_at,
        removedAt: r.removed_at,
      }));
  }

  /** Persist the full layout for a domain: upsert live nodes, drop stale rows. */
  replaceLayout(domain: string, rows: LayoutRow[]): void {
    this.db.transaction(() => {
      this.db
        .prepare('DELETE FROM map_layout WHERE collection_id = ? AND domain = ?')
        .run(this.collectionId, domain);
      const stmt = this.db.prepare(
        `INSERT INTO map_layout (collection_id, domain, node_kind, node_id, parent_id, content_hash, x, y, w, h, weight, placed_at, removed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const n of rows) {
        stmt.run(
          this.collectionId,
          domain,
          n.nodeKind,
          n.nodeId,
          n.parentId,
          n.contentHash,
          n.x,
          n.y,
          n.w,
          n.h,
          n.weight,
          n.placedAt,
          n.removedAt,
        );
      }
    });
  }

  // ── history mirror ─────────────────────────────────────────────────────

  /**
   * Insert history events, skipping ids already present (JSONL backfill and
   * live-subscription feeds overlap; the id makes replay idempotent). The FTS
   * row is only written when the base insert actually landed.
   */
  putHistoryEvents(events: HistoryEvent[]): void {
    if (events.length === 0) return;
    this.db.transaction(() => {
      const ins = this.db.prepare(
        `INSERT OR IGNORE INTO history_events (id, collection_id, at, kind, project_id, gezel_id, summary, details)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const fts = this.caps.fts
        ? this.db.prepare(
            'INSERT INTO fts_history (body, event_id, collection_id) VALUES (?, ?, ?)',
          )
        : null;
      for (const ev of events) {
        const { changes } = ins.run(
          ev.id,
          this.collectionId,
          ev.at,
          ev.kind,
          ev.projectId ?? null,
          ev.gezelId ?? null,
          ev.summary,
          ev.details ? JSON.stringify(ev.details) : null,
        );
        if (changes > 0) fts?.run(historyFtsBody(ev), ev.id, this.collectionId);
      }
    });
  }

  replaceHistoryEvents(events: HistoryEvent[]): void {
    this.db.transaction(() => {
      if (this.caps.fts) {
        this.db.prepare('DELETE FROM fts_history WHERE collection_id = ?').run(this.collectionId);
      }
      this.db.prepare('DELETE FROM history_events WHERE collection_id = ?').run(this.collectionId);
    });
    this.putHistoryEvents(events);
  }

  /**
   * Filtered event query, newest-first. Structured filters run as SQL WHERE;
   * only `q` touches FTS. When `q` is set but FTS is unavailable, returns null
   * so the caller falls back to the JSONL scan instead of silently missing.
   */
  searchHistory(filter: HistoryFilter = {}): HistoryEvent[] | null {
    if (filter.q && !this.caps.fts) return null;
    const where: string[] = ['h.collection_id = ?'];
    const params: SqlValue[] = [this.collectionId];
    if (filter.projectId) {
      where.push('h.project_id = ?');
      params.push(filter.projectId);
    }
    if (filter.gezelId) {
      where.push('h.gezel_id = ?');
      params.push(filter.gezelId);
    }
    if (filter.kinds && filter.kinds.length > 0) {
      where.push(`h.kind IN (${filter.kinds.map(() => '?').join(', ')})`);
      params.push(...filter.kinds);
    }
    if (filter.from) {
      where.push('h.at >= ?');
      params.push(filter.from);
    }
    if (filter.to) {
      where.push('h.at <= ?');
      params.push(filter.to);
    }
    let sql: string;
    if (filter.q) {
      sql = `SELECT h.id, h.at, h.kind, h.project_id, h.gezel_id, h.summary, h.details
             FROM fts_history f JOIN history_events h ON h.id = f.event_id
             WHERE f.fts_history MATCH ? AND f.collection_id = ? AND ${where.join(' AND ')}
             ORDER BY h.at DESC LIMIT ?`;
      params.unshift(ftsPhrase(filter.q), this.collectionId);
    } else {
      sql = `SELECT h.id, h.at, h.kind, h.project_id, h.gezel_id, h.summary, h.details
             FROM history_events h WHERE ${where.join(' AND ')}
             ORDER BY h.at DESC LIMIT ?`;
    }
    params.push(filter.limit ?? 500);
    return this.db
      .prepare(sql)
      .all<{
        id: string;
        at: string;
        kind: string;
        project_id: string | null;
        gezel_id: string | null;
        summary: string;
        details: string | null;
      }>(...params)
      .map((r) => ({
        id: r.id,
        at: r.at,
        kind: r.kind as HistoryEvent['kind'],
        summary: r.summary,
        ...(r.project_id ? { projectId: r.project_id } : {}),
        ...(r.gezel_id ? { gezelId: r.gezel_id } : {}),
        ...(r.details ? { details: parseDetails(r.details) } : {}),
      }));
  }

  /** Mirrored event count — the backfill/reconcile drift check. */
  historyCount(): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM history_events WHERE collection_id = ?')
      .get<{ n: number }>(this.collectionId);
    return Number(row?.n ?? 0);
  }

  // ── meta kv ────────────────────────────────────────────────────────────

  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value);
  }
  getMeta(key: string): string | undefined {
    return this.db.prepare('SELECT value FROM meta WHERE key = ?').get<{ value: string }>(key)
      ?.value;
  }

  // ── helpers ────────────────────────────────────────────────────────────

  private pruneFtsForFile(filePath: string): void {
    if (!this.caps.fts) return;
    for (const table of ['fts_symbols', 'fts_docs', 'fts_summaries', 'fts_metadata']) {
      this.db
        .prepare(`DELETE FROM ${table} WHERE file_path = ? AND collection_id = ?`)
        .run(filePath, this.collectionId);
    }
  }
}

function rowToFile(row: FileRow): FileRecord {
  return {
    path: row.path,
    hash: row.hash,
    size: row.size,
    mtimeMs: row.mtime_ms,
    lang: row.lang,
    kind: row.kind,
    modality: (row.modality as Modality) ?? 'text',
    trivial: !!row.trivial,
    indexedAt: row.indexed_at ?? '',
    loc: row.loc ?? null,
  };
}

function pathCol(table: string): string {
  return table === 'files' || table === 'metadata'
    ? 'path'
    : table === 'imports'
      ? 'src_path'
      : 'file_path';
}

const HISTORY_FTS_BODY_CAP = 2000;

/** FTS body for one event: summary + flattened details key/value pairs. */
function historyFtsBody(ev: HistoryEvent): string {
  let body = ev.summary;
  if (ev.details) {
    for (const [key, value] of Object.entries(ev.details)) {
      if (body.length >= HISTORY_FTS_BODY_CAP) break;
      const rendered =
        typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value);
      body += `\n${key}: ${rendered}`;
    }
  }
  return body.slice(0, HISTORY_FTS_BODY_CAP);
}

function parseDetails(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function rowToFinding(r: SecurityFindingDbRow): SecurityFindingRow {
  const source = (r.source as SecuritySource) ?? 'builtin';
  const fingerprint =
    r.fingerprint ??
    (source === 'builtin'
      ? `${r.rule_id}:${r.file_path}:${r.line ?? 0}`
      : `${source}:${r.rule_id}:${r.file_path}:${r.line ?? 0}`);
  return {
    filePath: r.file_path,
    line: r.line,
    ruleId: r.rule_id,
    category: r.category,
    severity: (r.severity as SecuritySeverity) ?? 'info',
    source,
    title: r.title,
    ...(r.evidence ? { evidence: r.evidence } : {}),
    fingerprint,
    status: (r.finding_status as SecurityFindingStatus) ?? 'open',
    ...(r.task_ref ? { taskRef: r.task_ref } : {}),
  };
}

function parseBindings(raw: string | null): ImportBinding[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as ImportBinding[]) : null;
  } catch {
    return null;
  }
}
