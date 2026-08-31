/**
 * Connector core contracts — the provider-agnostic shape every external-data
 * source implements, generalized from the mail pipeline (`mail/types.ts`'s
 * `MailProvider`). The sync engine, the shared writer, and the registry speak
 * only these types, never a source SDK.
 *
 * A `ConnectorAdapter` fetches records from one source and normalizes each into
 * a `NormalizedRecord`; the shared writer (`connectors/writer.ts`) turns that
 * into the on-disk corpus (trust frontmatter, injection scan, quarantine, path
 * safety). Credentials + the network fetch live behind the adapter; the AI only
 * ever sees the written files.
 */

import type { Store } from '../fs/store.js';
import type { SecretStore } from '../secrets/types.js';

/** Lightweight handle to one record — enough to sort/skip before fetching. */
export interface RecordRef {
  /** Adapter fetch handle passed back to `fetchRecord` (IMAP UID string, Gmail
   *  message id, issue id, …). The portable identifier within a scope. */
  id: string;
  /** Newest-first ordering key (generalizes IMAP `uid`; generic drivers derive
   *  it from the record timestamp). When absent the engine's newest-first sort
   *  is a stable no-op and the adapter's own ordering is preserved — only safe
   *  for sources that order results themselves (Gmail history, Graph delta). */
  ordinalKey?: number;
  /** The raw list item, when a source returns full records from its list call
   *  (no separate fetch). `fetchRecord` may normalize this directly. */
  raw?: unknown;
  /** Record timestamp (ISO), when the list surfaces one — used to derive a
   *  rolling-window cursor for sources without a native one. */
  ts?: string;
}

/** Options the engine passes to an incremental scan. */
export interface ListChangesOptions {
  /**
   * Batch-size hint. An adapter that can page SHOULD return at most this many
   * records with `partial: true` and a cursor covering exactly the returned
   * batch — the engine then loops the scope until done. An adapter that
   * over-returns keeps working: the engine sorts newest-first, takes `limit`,
   * counts the overflow as skipped, and logs it (the mail backfill-cap model).
   */
  limit?: number;
}

/** Result of an incremental scan of one scope. */
export interface ChangeBatch<Cur> {
  records: RecordRef[];
  /** Advanced cursor to persist; resume from here next sync. */
  cursor: Cur;
  /**
   * More changes remain beyond this batch and `cursor` covers exactly the
   * records returned — the engine may continue the scope immediately.
   */
  partial?: boolean;
  /**
   * This single batch is the complete current state of the scope (a full
   * re-list, not an incremental delta). Under a mirror-completeness type this
   * lets the engine prune records the source no longer returns. Mutually
   * exclusive with `partial`; never set on incremental batches.
   */
  enumeratedAll?: boolean;
  /** Source asked us to back off (rate limited) — resume next tick. */
  rateLimited?: boolean;
}

/**
 * The shared writer's ONLY input — driver-agnostic. An adapter's `fetchRecord`
 * produces this; `writeRecord` stamps `trust`/`scan_action`, scans the body,
 * quarantines or writes, and manages attachments + the flags sidecar.
 *
 * Path components (`dirSegments`, `fileStem`) are already slugged by the adapter
 * (domain slugging stays with the source); the writer only joins them through
 * `resolveInside` and adds the ordinal + content hash.
 */
export interface NormalizedRecord {
  /** Content identity (mail: Message-ID). Hashed for idempotency + the filename. */
  recordId: string;
  /** Slugged, path-safe dir components under the corpus dir + engine-owned
   *  scope level — optional adapter partitioning only (mail: the thread dir;
   *  calendar: the month bucket). Adapters must NOT re-derive the scope here. */
  dirSegments: string[];
  /** Slugged filename stem, sans ordinal + hash (mail: `<iso-min>--from-<local>`).
   *  The writer builds `<NNN>--<fileStem>--<hash8>.md`. */
  fileStem: string;
  /** Domain frontmatter (through `direction`); the writer appends
   *  `trust`/`scan_action`/`scan_flags`, preserving insertion order. */
  frontmatter: Record<string, string>;
  /** Raw record body; the writer scans it (cleaned vs quarantine-stub). */
  bodyMarkdown: string;
  /** Content-scanner origin (mail: `email`). Widened to string for non-mail
   *  sources; the scanner input is cast at the call site until it's widened. */
  scanOrigin: string;
  /** Subdir under `.gezel/quarantine/` for a diverted body (mail: `mail`). */
  quarantineNamespace: string;
  /** Human prefix for the quarantine stub (mail: `Message from <sender>`). */
  quarantineLabel: string;
  /**
   * Binary payloads belonging to this record. Small sources may keep bytes in
   * memory; large sources should stream to a private temporary file and pass a
   * verified digest. The shared writer atomically copies file-backed payloads
   * into the corpus before the adapter removes its staging directory.
   */
  attachments?: NormalizedAttachment[];
  /** Mutable per-record flags → the `_flags.json` sidecar. */
  flags?: string[];
  /** Read/seen state for the sidecar (mail: `\Seen` present). */
  seen?: boolean;
}

export type NormalizedAttachment =
  | {
      filename: string;
      content: Uint8Array;
      /** Optional precomputed digest; the writer computes it when omitted. */
      sha256?: string;
      size?: number;
      sourcePath?: never;
    }
  | {
      filename: string;
      /** Absolute path owned by the native adapter for the duration of a sync. */
      sourcePath: string;
      /** Digest of the staged bytes, required for idempotency without rereading. */
      sha256: string;
      size: number;
      content?: never;
    };

/**
 * The second corpus shape: a page of rows, not a document.
 *
 * A document corpus writes one markdown file per record, which is right for
 * mail, issues, calendar entries — corpora in the 10^3-10^4 range where each
 * record is prose a human reads. It is wrong by four to six orders of
 * magnitude for telemetry (Azure Monitor, CDN logs, billing exports), and it
 * fails three separate ways: a million inodes per binding per day; retrieval
 * that cannot express `GROUP BY`; and near-identical log text collapsing the
 * vector space, which degrades retrieval for the corpora that need it.
 *
 * So observation corpora land as partitioned columnar files and are read
 * back through SQL. The gezel never sees a row — it writes a query and reads
 * a result set. That is what decouples corpus size from context size, and it
 * is why a 500M-row table has no equivalent of the document corpus's
 * `MAX_ARTIFACT_FILES` ceiling.
 *
 * ONE `RecordRef` IS ONE PAGE, NOT ONE ROW. The engine's `backfillLimit`
 * (default 500, capped at 5,000) and `MAX_PARTIAL_ROUNDS` then bound pages
 * per pass rather than rows, so a 10k-row page yields a 200M-row-per-pass
 * ceiling without touching a single existing constant.
 */
export interface ObservationBatch {
  /** Table slug within the binding's corpus. One adapter may feed several. */
  table: string;
  /**
   * Partition this page belongs to (conventionally an ISO date, `2026-08-28`).
   * Omitted means the writer derives it from the table manifest's time column,
   * falling back to a single `unpartitioned` bucket.
   */
  partition?: string;
  /** The page's rows, pre-normalization. The writer coerces them to the
   *  table manifest's declared columns before they touch disk. */
  rows: Record<string, unknown>[];
  /**
   * Adapter-side row count, when the source reports one. Compared against the
   * rows actually written so a silently truncated page fails the pass instead
   * of quietly shrinking the corpus.
   */
  expectedRows?: number;
}

/**
 * What an adapter's `fetchRecord` returns. The two shapes are deliberately a
 * discriminated union rather than two adapter interfaces: the sync engine's
 * scope iteration, cursor envelope, paging, retry, and rate-limit handling
 * are identical for both, and only the terminal write differs.
 */
export type ConnectorRecord =
  | { kind: 'document'; record: NormalizedRecord }
  /**
   * Plural because one fetched page can legitimately span several tables — a
   * query API that returns "here are your metrics AND your errors" is common,
   * and splitting that into separate refs is impossible before the fetch. The
   * writer takes them in order; each is partitioned and sealed on its own.
   */
  | { kind: 'observations'; batches: ObservationBatch[] };

/** Narrowing helper — an adapter that emits rows rather than documents. */
export function isObservationRecord(
  rec: NormalizedRecord | ConnectorRecord,
): rec is { kind: 'observations'; batches: ObservationBatch[] } {
  return (rec as ConnectorRecord).kind === 'observations';
}

/**
 * The adapter contract. Constructed per sync pass (connect on first call,
 * `close()` when done), exactly like the mail providers. Generalizes
 * `MailProvider`; the `scope` axis carries mail's per-folder partitioning —
 * single-scope sources return `['']` and ignore it.
 */
export interface ConnectorAdapter<Rec = NormalizedRecord, Cur = unknown> {
  /** Connector-type id, e.g. `mail-gmail`, `linear-issues`. */
  readonly typeId: string;
  /** Establish/refresh the connection + auth. Throws on hard auth failure. */
  ensureAuth(): Promise<void>;
  /** Partitions to sync (mail folders, calendars). `['']` for single-scope. */
  listScopes(): Promise<string[]>;
  /**
   * Records added since `cursor` in `scope`, plus the advanced cursor. The
   * engine guarantees the cursor it passes for a scope is the cursor the
   * adapter last returned for THAT scope — cursors never leak across scopes.
   */
  listChangesSince(
    scope: string,
    cursor: Cur | undefined,
    opts?: ListChangesOptions,
  ): Promise<ChangeBatch<Cur>>;
  /** Fetch + normalize one record (raw → canonical `NormalizedRecord`). */
  fetchRecord(scope: string, ref: RecordRef): Promise<Rec>;
  /** Write-back (Phase 7). Invoked at commit time by the outbox — never exposed
   *  on the model's tool surface. */
  runAction?(action: string, input: unknown): Promise<unknown>;
  /** Release the connection. Always called, even on error. */
  close(): Promise<void>;
}

/**
 * Minimal binding shape the core engine operates on. The core-schema
 * `ProjectConnectorBinding` (Phase 2) is structurally assignable to this, so the
 * engine never depends on the wire schema.
 */
export interface ConnectorBindingRef {
  id: string;
  type: string;
  config?: Record<string, unknown>;
  cursor?: unknown;
}

/** What an adapter factory is handed to construct an adapter. */
export interface AdapterDeps {
  secrets: SecretStore;
  store: Store;
  /** Present for the `script` driver + script-normalize; injected at wire time. */
  scriptRunner?: import('../scripts/runner.js').ScriptRunner;
  /** The binding's project id (drivers need it to run scripts / scope work). */
  projectId?: string;
}

/**
 * Builds an adapter for a binding. The native registry
 * (`connectors/registry.ts`) maps `adapterId → AdapterFactory`; the driver
 * dispatcher (Phase 4) adds `mcp`/`script`/`spectral` factories.
 */
export type AdapterFactory = (
  binding: ConnectorBindingRef,
  deps: AdapterDeps,
) => Promise<ConnectorAdapter<NormalizedRecord | ConnectorRecord, unknown>>;
