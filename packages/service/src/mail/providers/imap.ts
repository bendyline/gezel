/**
 * IMAP mail provider (imapflow). Connects with implicit TLS by default and
 * fetches raw RFC822 for the shared MIME parser. Runs in the trusted service
 * process (not the sandbox), like the other network providers.
 *
 * A folder's first sync is a window, not the whole folder: the UIDs whose
 * internal date falls in the last `backfillDays` (`SEARCH SINCE`), fetched
 * newest-first one engine batch at a time. The UID high-water mark is taken
 * from `UIDNEXT` before the backfill starts, so mail arriving meanwhile is
 * listed as new mail rather than lost. A UIDVALIDITY change renumbers the
 * folder, and starts the window over.
 *
 * The IMAP client and the SMTP transport are injectable so tests drive the
 * provider against in-memory fakes (`connectors/testing/fake-imap.ts`).
 */

import { createLogger } from '@bendyline/gezel';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { RecordGoneError } from '../../connectors/types.js';
import { composeMime, normalizeMessageId } from '../compose.js';
import { parseRawMessage } from '../mime.js';
import { canonicalRecipients } from '../recipient.js';
import {
  type FolderChanges,
  type ImapCredential,
  type ImapFolderCursor,
  type ListOptions,
  type MailCursor,
  type MailFolder,
  type MailMessage,
  type MailProvider,
  type MailSyncOptions,
  type OutgoingMail,
  type SavedDraft,
  backfillStartMs,
  batchLimit,
} from '../types.js';

const log = createLogger('mail');

/** The slice of imapflow's `ImapFlow` this provider uses. */
export interface ImapClient {
  usable: boolean;
  mailbox: false | { uidValidity: bigint | number; uidNext?: number; exists: number };
  connect(): Promise<void>;
  on(event: 'error', listener: (err: Error) => void): unknown;
  list(): Promise<{ path: string; name: string; specialUse?: string }[]>;
  getMailboxLock(path: string): Promise<{ release(): void }>;
  search(
    query: { since?: Date; uid?: string; all?: boolean },
    options: { uid: true },
  ): Promise<number[] | false>;
  fetchOne(
    range: string,
    query: { uid: true; source: true; flags: true; internalDate: true },
    options: { uid: true },
  ): Promise<
    false | { uid: number; source?: Buffer; flags?: Set<string>; internalDate?: Date | string }
  >;
  append(
    path: string,
    content: Buffer,
    flags?: string[],
    idate?: Date,
  ): Promise<false | { destination: string; uid?: number }>;
  logout(): Promise<void>;
  close(): void;
}

export interface ImapClientOptions {
  host: string;
  port: number;
  secure: boolean;
  auth: { user: string; pass: string };
  logger: false;
  socketTimeout: number;
}
export type ImapClientFactory = (options: ImapClientOptions) => ImapClient;

/** The slice of a nodemailer transport this provider uses. */
export interface SmtpTransport {
  sendMail(mail: Record<string, unknown>): Promise<{ messageId?: string }>;
  close(): void;
}
export interface SmtpTransportOptions {
  host: string;
  port: number;
  secure: boolean;
  auth: { user: string; pass: string };
}
export type SmtpTransportFactory = (options: SmtpTransportOptions) => SmtpTransport;

export const defaultImapClientFactory: ImapClientFactory = (options) => new ImapFlow(options);

export const defaultSmtpTransportFactory: SmtpTransportFactory = (options) =>
  nodemailer.createTransport(options) as unknown as SmtpTransport;

export interface ImapProviderOptions extends MailSyncOptions {
  createClient?: ImapClientFactory;
  createTransport?: SmtpTransportFactory;
}

/** UIDs a search returned, as a number array (imapflow answers `false` on failure). */
const uids = (r: number[] | false): number[] => (Array.isArray(r) ? r : []);

export class ImapMailProvider implements MailProvider {
  readonly kind = 'imap' as const;
  private client: ImapClient | null = null;

  constructor(
    private readonly accountAddress: string,
    private readonly cred: ImapCredential,
    private readonly opts: ImapProviderOptions = {},
  ) {}

  async ensureAuth(): Promise<void> {
    if (this.client?.usable) return;
    const secure = this.cred.secure ?? true;
    const port = this.cred.port ?? (secure ? 993 : 143);
    const client = (this.opts.createClient ?? defaultImapClientFactory)({
      host: this.cred.host,
      port,
      secure,
      auth: { user: this.cred.user, pass: this.cred.pass },
      logger: false,
      // Don't let a wedged server hang a sync tick forever.
      socketTimeout: 60_000,
    });
    client.on('error', (err) => log.warn(`imap error (${this.accountAddress}): ${err}`));
    try {
      await client.connect();
    } catch (err) {
      const e = err as Error & { authenticationFailed?: boolean; response?: string };
      if (e.authenticationFailed) {
        const said = e.response ? ` (the server said: ${String(e.response).slice(0, 120)})` : '';
        throw new Error(
          `${this.cred.host} refused the sign-in for ${this.cred.user}${said}. Check the app password saved for this connector — most providers need an app-specific password rather than your normal one — and re-enter it in the project's Connections.`,
        );
      }
      throw new Error(`could not connect to ${this.cred.host}:${port}: ${e.message}`);
    }
    this.client = client;
  }

  private require(): ImapClient {
    if (!this.client) throw new Error('imap provider not connected; call ensureAuth() first');
    return this.client;
  }

  async listFolders(): Promise<MailFolder[]> {
    const list = await this.require().list();
    return list.map((f) => ({ path: f.path, name: f.name }));
  }

  private async lock(client: ImapClient, folder: string): Promise<{ release(): void }> {
    try {
      return await client.getMailboxLock(folder);
    } catch (err) {
      throw new Error(`could not open the IMAP folder '${folder}': ${(err as Error).message}`);
    }
  }

  async listChangesSince(
    folder: string,
    cursor: MailCursor | undefined,
    opts?: ListOptions,
  ): Promise<FolderChanges> {
    const client = this.require();
    const limit = batchLimit(opts);
    const lock = await this.lock(client, folder);
    try {
      const mailbox = client.mailbox;
      if (!mailbox) return { envelopes: [], cursor: cursor ?? {} };
      const uidValidity = Number(mailbox.uidValidity);
      const prev = cursor?.imap?.[folder];
      let state: ImapFolderCursor;
      if (prev && prev.uidValidity === uidValidity) {
        state = { ...prev };
      } else {
        if (prev) log.info(`imap ${folder}: UIDVALIDITY changed; resyncing the window`);
        const top =
          mailbox.uidNext && mailbox.uidNext > 0
            ? mailbox.uidNext - 1
            : uids(await client.search({ all: true }, { uid: true })).reduce(
                (max, u) => Math.max(max, u),
                0,
              );
        state = {
          uidValidity,
          lastUid: top,
          backfillBelow: top + 1,
          since: new Date(backfillStartMs(this.opts)).toISOString(),
        };
      }

      const picked: number[] = [];
      let partial = false;
      // New mail first, oldest first: `lastUid` must cover a contiguous run,
      // or a batch cut short would skip the mail between.
      if (mailbox.exists > 0) {
        const fresh = uids(await client.search({ uid: `${state.lastUid + 1}:*` }, { uid: true }))
          .filter((u) => u > state.lastUid)
          .sort((a, b) => a - b);
        const take = fresh.slice(0, limit);
        picked.push(...take);
        if (take.length) state.lastUid = take[take.length - 1]!;
        if (fresh.length > take.length) partial = true;
      }
      // Then the window, newest first, below where the last batch stopped.
      if (state.backfillBelow !== undefined) {
        const budget = limit - picked.length;
        if (budget <= 0) {
          partial = true;
        } else {
          const below = state.backfillBelow;
          const since = new Date(state.since ?? backfillStartMs(this.opts));
          const window = uids(await client.search({ since }, { uid: true }))
            .filter((u) => u < below)
            .sort((a, b) => b - a);
          const take = window.slice(0, budget);
          picked.push(...take);
          if (window.length > take.length) {
            state.backfillBelow = take[take.length - 1]!;
            partial = true;
          } else {
            delete state.backfillBelow;
            delete state.since;
          }
        }
      }

      return {
        envelopes: picked.map((uid) => ({ id: String(uid), ordinalKey: uid })),
        cursor: { imap: { [folder]: state } },
        ...(partial ? { partial: true } : {}),
      };
    } finally {
      lock.release();
    }
  }

  async fetchMessage(folder: string, id: string): Promise<MailMessage> {
    const uid = Number(id);
    const client = this.require();
    const lock = await this.lock(client, folder);
    try {
      const msg = await client.fetchOne(
        String(uid),
        { uid: true, source: true, flags: true, internalDate: true },
        { uid: true },
      );
      if (!msg || !msg.source) {
        throw new RecordGoneError(`imap message uid ${uid} is no longer in ${folder}`);
      }
      const internal = msg.internalDate ? new Date(msg.internalDate) : undefined;
      return parseRawMessage(msg.source, {
        folder,
        id,
        uid,
        flags: msg.flags ? [...msg.flags] : [],
        ...(internal && !Number.isNaN(internal.getTime())
          ? { fallbackDate: internal.toISOString() }
          : {}),
      });
    } finally {
      lock.release();
    }
  }

  async send(from: string, mail: OutgoingMail): Promise<{ messageId: string }> {
    const smtp = this.cred.smtp;
    if (!smtp) {
      throw new Error('no SMTP configuration for this account; cannot send');
    }
    const secure = smtp.secure ?? false;
    const transport = (this.opts.createTransport ?? defaultSmtpTransportFactory)({
      host: smtp.host,
      port: smtp.port ?? (secure ? 465 : 587),
      secure,
      auth: { user: smtp.user ?? this.cred.user, pass: smtp.pass ?? this.cred.pass },
    });
    const inReplyTo = normalizeMessageId(mail.inReplyTo);
    const references = mail.references?.length ? mail.references : inReplyTo ? [inReplyTo] : [];
    try {
      const info = await transport.sendMail({
        from,
        to: canonicalRecipients(mail.to),
        ...(mail.cc?.length ? { cc: canonicalRecipients(mail.cc) } : {}),
        ...(mail.bcc?.length ? { bcc: canonicalRecipients(mail.bcc) } : {}),
        subject: mail.subject,
        text: mail.bodyMarkdown,
        ...(inReplyTo ? { inReplyTo } : {}),
        ...(references.length ? { references } : {}),
      });
      return { messageId: info.messageId ?? '' };
    } finally {
      transport.close();
    }
  }

  /**
   * APPEND to the special-use `\Drafts` folder (RFC 6154), else a folder
   * named Drafts, with the `\Draft` flag. Nothing is transmitted.
   */
  async saveDraft(from: string | undefined, mail: OutgoingMail): Promise<SavedDraft> {
    const client = this.require();
    const folders = await client.list();
    const drafts =
      folders.find((f) => f.specialUse === '\\Drafts') ??
      folders.find((f) => /^drafts$/i.test(f.name)) ??
      folders.find((f) => /(^|[./])drafts$/i.test(f.path));
    if (!drafts) {
      throw new Error(
        'this mailbox has no Drafts folder to save into; create one named "Drafts" in your mail app first',
      );
    }
    const sender = from?.trim() || (this.cred.user.includes('@') ? this.cred.user : '');
    if (!sender) throw new Error('this mail binding has no address to write the draft from');
    const date = new Date((this.opts.now ?? Date.now)());
    const { raw, messageId } = composeMime(sender, mail, { date });
    const res = await client.append(drafts.path, raw, ['\\Draft', '\\Seen'], date);
    if (!res) throw new Error(`the mail server refused to save the draft in ${drafts.path}`);
    log.info(`imap saved draft ${messageId} in ${drafts.path}`);
    return { draftId: messageId };
  }

  async close(): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.logout();
    } catch {
      // best-effort; force-close on failure
      try {
        this.client.close();
      } catch {
        /* ignore */
      }
    }
    this.client = null;
  }
}
