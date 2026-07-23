/**
 * Provider-agnostic mail types. A `MailProvider` is the adapter contract every
 * backend (IMAP today; Gmail / Microsoft Graph later) implements. The sync
 * engine and message writer speak only these types, never a provider SDK.
 */

import type { ProjectMailAccount } from '@bendyline/gezel';

export type MailProviderKind = ProjectMailAccount['provider'];
export type MailCursor = NonNullable<ProjectMailAccount['cursor']>;

/** A mailbox folder / label. */
export interface MailFolder {
  /** Provider-native path/id (what `listChangesSince`/`fetchMessage` take). */
  path: string;
  /** Human label. */
  name: string;
}

/** Lightweight message header info — enough to decide whether to fetch fully. */
export interface MailEnvelope {
  /** Provider fetch handle passed back to `fetchMessage` (IMAP UID as string,
   *  Gmail message id, Graph message id). The portable identifier. */
  id: string;
  /** IMAP UID (numeric) — used for cursor math + newest-first ordering. Absent
   *  for API providers (Gmail/Graph), which order results themselves. */
  uid?: number;
  /** RFC Message-ID (`<...>`), or a synthesized stable id when absent. */
  messageId: string;
  /** Conversation key: provider thread id, References-root, or messageId. */
  threadKey: string;
  /** Normalized ISO-8601 UTC. */
  date: string;
  from: string;
  subject: string;
  flags: string[];
  folder: string;
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
  /** Body as markdown, already quote/signature-stripped + HTML-converted. */
  bodyMarkdown: string;
  attachments: MailAttachment[];
}

/** A message to send. */
export interface OutgoingMail {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  /** Body authored as markdown; sent as plain text (and optionally as HTML). */
  bodyMarkdown: string;
  /** Threading headers when this is a reply. */
  inReplyTo?: string;
  references?: string[];
}

/** Result of an incremental folder scan. */
export interface FolderChanges {
  envelopes: MailEnvelope[];
  /** Advanced cursor to persist; resume from here next sync. */
  cursor: MailCursor;
  /** Provider asked us to back off (rate limited) — resume next tick. */
  rateLimited?: boolean;
}

/**
 * Adapter contract. Implementations are constructed by `createMailProvider`
 * with the account + a resolved credential, and are single-use per sync pass
 * (connect on first call, `close()` when done).
 */
export interface MailProvider {
  readonly kind: MailProviderKind;
  /** Establish/refresh the connection + auth. Throws on hard auth failure. */
  ensureAuth(): Promise<void>;
  listFolders(): Promise<MailFolder[]>;
  /** Envelopes added since `cursor` in `folder`, plus the advanced cursor. */
  listChangesSince(folder: string, cursor: MailCursor | undefined): Promise<FolderChanges>;
  /** Fetch + parse a single message by its envelope `id` (raw RFC822 →
   *  normalized MailMessage). */
  fetchMessage(folder: string, id: string): Promise<MailMessage>;
  /** Send a message. Returns the transmitted Message-ID. */
  send(from: string, mail: OutgoingMail): Promise<{ messageId: string }>;
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
