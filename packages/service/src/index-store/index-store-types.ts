import type { FileReviewIssue } from '@bendyline/gezel';

/**
 * Record shapes the content index reads and writes: rows, inputs, and hits
 * shared by `IndexStore` and its callers. Types only, so any module can
 * import them without loading the store.
 */

/** A photo's file row with its metadata pivoted on (see `IndexStore.photoRows`). */
export interface PhotoRow {
  path: string;
  hash: string | null;
  size: number | null;
  mtime_ms: number | null;
  taken_at: string | null;
  camera_make: string | null;
  camera_model: string | null;
  lens: string | null;
  gps_lat: string | null;
  gps_lon: string | null;
  width: string | null;
  height: string | null;
  format: string | null;
  screenshot: string | null;
  cloud_only: string | null;
}

export type Modality = 'text' | 'code' | 'doc' | 'image' | 'audio' | 'video' | 'email';
/** The modalities the media tier embeds (one row per image, per window otherwise). */
export type MediaVectorModality = 'image' | 'audio' | 'video';

export interface MediaVectorRow {
  contentHash: string;
  filePath: string;
  modality: MediaVectorModality;
  startMs: number;
  endMs: number | null;
  vec: Float32Array;
}
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
  lineEnd: number;
  chunkId: number;
  snippet: string;
}

export interface VectorHit {
  chunkId: number;
  filePath: string;
  lineStart: number;
  lineEnd: number;
  text: string;
  /**
   * Raw sqlite-vec distance — RANK ORDER ONLY, and not comparable across
   * installs: fresh vec_text tables declare cosine, but tables created before
   * the declaration report L2 until a re-embed migration recreates them. Read
   * {@link VectorHit.similarity} instead of converting this by hand; it
   * accounts for the declared metric.
   */
  distance: number;
  /**
   * Cosine similarity in 0..1-ish, normalized across both declared metrics
   * (see {@link IndexStore.similarityForDistance}). This is the value a
   * relevance floor may be compared against; `distance` is not.
   */
  similarity: number;
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
  /**
   * Skip vector-table creation AND the embed-model reconcile. For stores
   * that never hold embeddings (the global FTS mirror) — without this, every
   * embed-model swap ran a pointless vec_text DROP/CREATE + enrichments
   * clear against a vectorless database.
   */
  vectorless?: boolean;
}
