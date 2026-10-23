/**
 * Provider-agnostic mail types. A `MailProvider` is the adapter contract every
 * backend (IMAP, Gmail, Microsoft Graph) implements. The sync engine and the
 * message writer speak only these types, never a provider SDK.
 */

export type MailProviderKind = 'imap' | 'gmail' | 'microsoft365' | 'outlook';

/** Days of mail the first sync of a folder fetches when the binding names none. */
export const DEFAULT_BACKFILL_DAYS = 90;

/** One IMAP folder's position: UID high-water mark plus an unfinished backfill. */
export interface ImapFolderCursor {
  uidValidity: number;
  /** Highest UID already listed; new mail is everything above it. */
  lastUid: number;
  /** The newest-first backfill still owes the window's UIDs below this one. */
  backfillBelow?: number;
  /** Start of the backfill window (ISO), fixed for the life of one backfill. */
  since?: string;
}

/**
 * Provider-shaped incremental-sync cursor. Under the connector engine's
 * per-scope envelope each folder scope carries its own blob.
 */
export interface MailCursor {
  imap?: Record<string, ImapFolderCursor>;
  /** Gmail: history anchor once the folder's backfill has finished. */
  gmailHistoryId?: string;
  /** Gmail: where a history walk that ran out of batch budget stopped. */
  gmailHistoryPage?: { token?: string; skip: number };
  /** Gmail: an unfinished backfill — its anchor, window start, and next page. */
  gmailBackfill?: { anchor: string; after: number; pageToken?: string };
  /** Graph: the finished round's delta link; the next pass starts here. */
  graphDeltaLink?: string;
  /** Graph: the next page of an unfinished round. */
  graphNextLink?: string;
}

/** A mailbox folder / label. */
export interface MailFolder {
  /** Provider-native path/id (what `listChangesSince`/`fetchMessage` take). */
  path: string;
  /** Human label. */
  name: string;
}

/** One listed message: the fetch handle plus what the list call already knew. */
export interface MailEnvelope {
  /** Provider fetch handle passed back to `fetchMessage` (IMAP UID as string,
   *  Gmail message id, Graph message id). */
  id: string;
  /** Newest-first sort key: IMAP UID, or the received time in ms. */
  ordinalKey?: number;
  /** Read state the list call reported (Graph `isRead`); absent when unknown. */
  flags?: string[];
  /** Web permalink the list call reported (Graph `webLink`). */
  url?: string;
}

/** What the list call learned about a message, handed back to `fetchMessage`. */
export interface FetchHint {
  flags?: string[];
  url?: string;
}

export interface MailAttachment {
  filename: string;
  contentType: string;
  size: number;
  content: Uint8Array;
}

/** A fully-parsed message: headers + de-quoted markdown body + attachments. */
export interface MailMessage {
  /** IMAP UID when applicable; absent for API providers. */
  uid?: number;
  messageId: string;
  threadKey: string;
  inReplyTo?: string;
  references: string[];
  date: string;
  from: string;
  to: string;
  cc: string;
  subject: string;
  flags: string[];
  folder: string;
  /** Web permalink, when the provider documents one. */
  url?: string;
  /** Body as markdown, already quote/signature-stripped + HTML-converted. */
  bodyMarkdown: string;
  attachments: MailAttachment[];
}

/** A message to send or to save as a draft. */
export interface OutgoingMail {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  /** Body authored as markdown; sent as plain text. */
  bodyMarkdown: string;
  /** Threading headers when this is a reply. */
  inReplyTo?: string;
  references?: string[];
}

/** A draft saved into the account's own Drafts folder. */
export interface SavedDraft {
  /** Provider handle for the draft (Gmail draft id, Graph message id, IMAP Message-ID). */
  draftId: string;
  /** Link that opens the draft, when the provider returns one. */
  webLink?: string;
}

/** Result of an incremental folder scan. */
export interface FolderChanges {
  envelopes: MailEnvelope[];
  /** Advanced cursor covering exactly `envelopes`; resume from here next round. */
  cursor: MailCursor;
  /** More remain beyond this batch; the engine may continue the folder. */
  partial?: boolean;
  /** Provider asked us to back off (rate limited) — resume next tick. */
  rateLimited?: boolean;
}

export interface ListOptions {
  /** Most envelopes to return; a provider that has more returns `partial`. */
  limit?: number;
}

/**
 * Adapter contract. Implementations are single-use per sync pass (connect on
 * first call, `close()` when done).
 */
export interface MailProvider {
  readonly kind: MailProviderKind;
  /** Establish/refresh the connection + auth. Throws on hard auth failure. */
  ensureAuth(): Promise<void>;
  listFolders(): Promise<MailFolder[]>;
  /** Envelopes changed since `cursor` in `folder`, plus the advanced cursor. */
  listChangesSince(
    folder: string,
    cursor: MailCursor | undefined,
    opts?: ListOptions,
  ): Promise<FolderChanges>;
  /**
   * Fetch + parse a single message by its envelope `id`. Throws
   * `RecordGoneError` when the message no longer exists.
   */
  fetchMessage(folder: string, id: string, hint?: FetchHint): Promise<MailMessage>;
  /** Send a message. Returns the transmitted Message-ID when the provider reports one. */
  send(from: string, mail: OutgoingMail): Promise<{ messageId: string }>;
  /** Save a message to the account's Drafts folder. Never transmits. */
  saveDraft(from: string | undefined, mail: OutgoingMail): Promise<SavedDraft>;
  /** Release the connection. Always called, even on error. */
  close(): Promise<void>;
}

/** SMTP submission config (defaults the auth to the IMAP credential). */
export interface SmtpConfig {
  host: string;
  port?: number;
  /** Implicit TLS (465) vs STARTTLS (587). Default false (STARTTLS on 587). */
  secure?: boolean;
  user?: string;
  pass?: string;
}

/** Stored IMAP connection config (the secret blob, JSON in the SecretStore). */
export interface ImapCredential {
  host: string;
  port?: number;
  /** Implicit TLS (993) vs STARTTLS/plain. Default true. */
  secure?: boolean;
  user: string;
  pass: string;
  /** SMTP submission config for sending. When absent, sending is unavailable. */
  smtp?: SmtpConfig;
}

/** Window and clock settings every provider shares. */
export interface MailSyncOptions {
  /** Days of history the first sync of a folder covers. */
  backfillDays?: number;
  /** Clock seam for tests (ms since epoch). */
  now?: () => number;
}

/** Start of the backfill window for `opts`, in ms since epoch. */
export function backfillStartMs(opts: MailSyncOptions): number {
  const days =
    typeof opts.backfillDays === 'number' && opts.backfillDays > 0
      ? opts.backfillDays
      : DEFAULT_BACKFILL_DAYS;
  return (opts.now ?? Date.now)() - days * 86_400_000;
}

/** A batch limit the engine passed, or a sane default when it passed none. */
export function batchLimit(opts: ListOptions | undefined): number {
  const n = opts?.limit;
  return typeof n === 'number' && Number.isFinite(n) && n >= 1 ? Math.floor(n) : 500;
}
