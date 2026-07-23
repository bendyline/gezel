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
  /** Newest-first ordering key (generalizes IMAP `uid`). Absent for sources
   *  that order results themselves (Gmail history, Graph delta, REST search). */
  ordinalKey?: number;
  /** The raw list item, when a source returns full records from its list call
   *  (no separate fetch). `fetchRecord` may normalize this directly. */
  raw?: unknown;
  /** Record timestamp (ISO), when the list surfaces one — used to derive a
   *  rolling-window cursor for sources without a native one. */
  ts?: string;
}

/** Result of an incremental scan of one scope. */
export interface ChangeBatch<Cur> {
  records: RecordRef[];
  /** Advanced cursor to persist; resume from here next sync. */
  cursor: Cur;
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
  /** Slugged, path-safe dir components under the corpus dir (mail:
   *  [accountSlug, folderSlug, threadDir]). */
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
  attachments?: { filename: string; content: Uint8Array }[];
  /** Mutable per-record flags → the `_flags.json` sidecar. */
  flags?: string[];
  /** Read/seen state for the sidecar (mail: `\Seen` present). */
  seen?: boolean;
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
  /** Records added since `cursor` in `scope`, plus the advanced cursor. */
  listChangesSince(scope: string, cursor: Cur | undefined): Promise<ChangeBatch<Cur>>;
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
) => Promise<ConnectorAdapter<NormalizedRecord, unknown>>;
