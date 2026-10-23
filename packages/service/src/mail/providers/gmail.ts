/**
 * Gmail provider (Gmail REST API).
 *
 * First sync of a label is a bounded backfill: the mailbox's `historyId` is
 * captured from `/profile` BEFORE the first `messages.list` page, then the
 * label is listed newest-first over the last `backfillDays` (`q=after:<epoch>`),
 * one engine batch at a time with a resumable page token. Mail that arrives
 * while the backfill pages is therefore replayed by the history walk that
 * follows instead of falling between the list and the anchor.
 *
 * After that the History API is the cursor. `history.list` answers 404 when
 * `startHistoryId` has aged out (records are kept "at least a week", sometimes
 * only hours), and the documented remedy is a full sync, so a 404 starts a
 * fresh backfill — the writer dedupes what it re-lists.
 * https://developers.google.com/workspace/gmail/api/guides/sync
 *
 * Raw MIME goes to the shared parser; outbound uses `messages.send`, and
 * `drafts.create` saves a draft into the account without sending it.
 */

import { HttpStatusError, createLogger } from '@bendyline/gezel';
import {
  type ApiRequestInit,
  type OAuthSession,
  authorizedJson,
  hasStatus,
} from '../../connectors/natives/oauth-session.js';
import { RecordGoneError } from '../../connectors/types.js';
import { composeMime, normalizeMessageId } from '../compose.js';
import { parseRawMessage } from '../mime.js';
import {
  type FolderChanges,
  type ListOptions,
  type MailCursor,
  type MailEnvelope,
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
export const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';
/** `messages.list` and `history.list` both cap `maxResults` at 500. */
const MAX_PAGE = 500;

interface GmailMsgRef {
  id: string;
  threadId?: string;
  labelIds?: string[];
}

interface GmailHistoryRecord {
  id?: string;
  messagesAdded?: { message: GmailMsgRef }[];
  labelsAdded?: { message: GmailMsgRef; labelIds?: string[] }[];
  labelsRemoved?: { message: GmailMsgRef; labelIds?: string[] }[];
}

interface GmailHistoryPage {
  history?: GmailHistoryRecord[];
  nextPageToken?: string;
  historyId?: string;
}

export interface GmailProviderOptions extends MailSyncOptions {
  session: OAuthSession;
  fetchImpl?: typeof fetch;
}

/**
 * Message ids a page of history touches that this folder should (re)fetch,
 * in record order, deduped: arrivals, moves into the folder, and read-state
 * changes (Gmail's UNREAD label). Removals out of the folder are deliberately
 * ignored — the corpus is a window, and an archived message stays in it.
 */
export function gmailHistoryIds(
  history: GmailHistoryRecord[] | undefined,
  folder: string,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (id: string | undefined) => {
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  };
  for (const h of history ?? []) {
    for (const m of h.messagesAdded ?? []) {
      if (m.message.labelIds && !m.message.labelIds.includes(folder)) continue;
      add(m.message.id);
    }
    for (const m of h.labelsAdded ?? []) {
      if (m.labelIds?.includes(folder) || m.labelIds?.includes('UNREAD')) add(m.message.id);
    }
    for (const m of h.labelsRemoved ?? []) {
      if (m.labelIds?.includes('UNREAD')) add(m.message.id);
    }
  }
  return out;
}

export class GmailMailProvider implements MailProvider {
  readonly kind = 'gmail' as const;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: GmailProviderOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async ensureAuth(): Promise<void> {
    await this.opts.session.token();
  }

  /**
   * Gmail reports per-user throttling as 403 `userRateLimitExceeded` /
   * `rateLimitExceeded` as often as 429; both are backpressure.
   */
  private async api<T>(path: string, init?: ApiRequestInit): Promise<T> {
    try {
      return await authorizedJson<T>(
        this.opts.session,
        this.fetchImpl,
        `${GMAIL_API}${path}`,
        init,
        'Gmail',
      );
    } catch (err) {
      if (hasStatus(err, 403) && /rateLimitExceeded/i.test((err as Error).message)) {
        throw new HttpStatusError(429, (err as Error).message);
      }
      throw err;
    }
  }

  async listFolders(): Promise<MailFolder[]> {
    const data = await this.api<{ labels?: { id: string; name: string }[] }>('/labels');
    return (data.labels ?? []).map((l) => ({ path: l.id, name: l.name }));
  }

  async listChangesSince(
    folder: string,
    cursor: MailCursor | undefined,
    opts?: ListOptions,
  ): Promise<FolderChanges> {
    const limit = batchLimit(opts);
    if (cursor?.gmailHistoryId && !cursor.gmailBackfill) {
      try {
        return await this.historyChanges(
          folder,
          cursor.gmailHistoryId,
          cursor.gmailHistoryPage,
          limit,
        );
      } catch (err) {
        if (hasStatus(err, 404)) {
          log.info(`gmail ${folder}: history ${cursor.gmailHistoryId} has expired; resyncing`);
          return this.backfill(folder, undefined, limit);
        }
        if (hasStatus(err, 400) && cursor.gmailHistoryPage?.token) {
          // A stale page token: walk the same history again from its start.
          log.info(`gmail ${folder}: history page token rejected; restarting the walk`);
          return this.historyChanges(folder, cursor.gmailHistoryId, undefined, limit);
        }
        throw err;
      }
    }
    try {
      return await this.backfill(folder, cursor?.gmailBackfill, limit);
    } catch (err) {
      if (hasStatus(err, 400) && cursor?.gmailBackfill?.pageToken) {
        log.info(`gmail ${folder}: backfill page token rejected; restarting the backfill`);
        return this.backfill(folder, undefined, limit);
      }
      throw err;
    }
  }

  private async backfill(
    folder: string,
    state: MailCursor['gmailBackfill'],
    limit: number,
  ): Promise<FolderChanges> {
    let anchor = state?.anchor;
    let after = state?.after;
    if (!anchor || after === undefined) {
      const profile = await this.api<{ historyId?: string }>('/profile');
      if (!profile.historyId) throw new Error('Gmail returned no history id for this mailbox');
      anchor = profile.historyId;
      after = Math.floor(backfillStartMs(this.opts) / 1000);
    }
    let pageToken = state?.pageToken;
    const envelopes: MailEnvelope[] = [];
    const seen = new Set<string>();
    while (envelopes.length < limit) {
      const q = new URLSearchParams({
        labelIds: folder,
        q: `after:${after}`,
        maxResults: String(Math.min(MAX_PAGE, limit - envelopes.length)),
      });
      if (pageToken) q.set('pageToken', pageToken);
      const data = await this.api<{ messages?: GmailMsgRef[]; nextPageToken?: string }>(
        `/messages?${q.toString()}`,
      );
      for (const m of data.messages ?? []) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        envelopes.push({ id: m.id });
      }
      pageToken = data.nextPageToken;
      if (!pageToken) break;
    }
    if (pageToken) {
      return { envelopes, cursor: { gmailBackfill: { anchor, after, pageToken } }, partial: true };
    }
    return { envelopes, cursor: { gmailHistoryId: anchor } };
  }

  /**
   * Walk history from `start`, resuming at `page`. A batch that runs out of
   * budget mid-page records how many of that page's ids it consumed, so the
   * cursor covers exactly the ids returned.
   */
  private async historyChanges(
    folder: string,
    start: string,
    page: MailCursor['gmailHistoryPage'],
    limit: number,
  ): Promise<FolderChanges> {
    let token = page?.token;
    let skip = page?.skip ?? 0;
    const envelopes: MailEnvelope[] = [];
    const seen = new Set<string>();
    for (;;) {
      const q = new URLSearchParams({ startHistoryId: start, labelId: folder });
      for (const type of ['messageAdded', 'labelAdded', 'labelRemoved']) {
        q.append('historyTypes', type);
      }
      q.set('maxResults', String(MAX_PAGE));
      if (token) q.set('pageToken', token);
      const data = await this.api<GmailHistoryPage>(`/history?${q.toString()}`);
      const ids = gmailHistoryIds(data.history, folder);
      let used = skip;
      while (used < ids.length && envelopes.length < limit) {
        const id = ids[used++]!;
        if (seen.has(id)) continue;
        seen.add(id);
        envelopes.push({ id });
      }
      const at = (t: string | undefined, s: number): MailCursor => ({
        gmailHistoryId: start,
        gmailHistoryPage: { ...(t ? { token: t } : {}), skip: s },
      });
      if (used < ids.length) return { envelopes, cursor: at(token, used), partial: true };
      if (!data.nextPageToken) {
        return { envelopes, cursor: { gmailHistoryId: data.historyId ?? start } };
      }
      token = data.nextPageToken;
      skip = 0;
      if (envelopes.length >= limit) return { envelopes, cursor: at(token, 0), partial: true };
    }
  }

  async fetchMessage(folder: string, id: string): Promise<MailMessage> {
    let data: { raw?: string; labelIds?: string[]; internalDate?: string };
    try {
      data = await this.api(`/messages/${encodeURIComponent(id)}?format=raw`);
    } catch (err) {
      if (hasStatus(err, 404)) throw new RecordGoneError(`gmail message ${id} no longer exists`);
      throw err;
    }
    if (!data.raw) throw new Error(`gmail message ${id} has no raw payload`);
    const buf = Buffer.from(data.raw, 'base64url');
    const flags = (data.labelIds ?? []).includes('UNREAD') ? [] : ['\\Seen'];
    const internal = Number(data.internalDate);
    return parseRawMessage(buf, {
      folder,
      id,
      flags,
      ...(Number.isFinite(internal) && internal > 0
        ? { fallbackDate: new Date(internal).toISOString() }
        : {}),
    });
  }

  /**
   * The Gmail thread a reply belongs to. Gmail files a sent message or draft
   * into a thread only when its `threadId` is given (plus matching headers and
   * subject), and the only handle a draft carries is the parent's Message-ID.
   */
  private async threadIdFor(inReplyTo: string | undefined): Promise<string | undefined> {
    const id = normalizeMessageId(inReplyTo);
    if (!id) return undefined;
    try {
      const q = new URLSearchParams({ q: `rfc822msgid:${id.slice(1, -1)}`, maxResults: '1' });
      const data = await this.api<{ messages?: GmailMsgRef[] }>(`/messages?${q.toString()}`);
      return data.messages?.[0]?.threadId;
    } catch (err) {
      log.warn(`gmail: could not resolve the thread for ${id}: ${(err as Error).message}`);
      return undefined;
    }
  }

  async send(from: string, mail: OutgoingMail): Promise<{ messageId: string }> {
    const { raw } = composeMime(from, mail, { date: new Date((this.opts.now ?? Date.now)()) });
    const threadId = await this.threadIdFor(mail.inReplyTo);
    const data = await this.api<{ id?: string }>('/messages/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: raw.toString('base64url'), ...(threadId ? { threadId } : {}) }),
    });
    log.info(`gmail sent message ${data.id ?? '?'}`);
    return { messageId: data.id ?? '' };
  }

  async saveDraft(from: string | undefined, mail: OutgoingMail): Promise<SavedDraft> {
    const { raw } = composeMime(from, mail, { date: new Date((this.opts.now ?? Date.now)()) });
    const threadId = await this.threadIdFor(mail.inReplyTo);
    const data = await this.api<{ id?: string }>('/drafts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: { raw: raw.toString('base64url'), ...(threadId ? { threadId } : {}) },
      }),
    });
    if (!data.id) throw new Error('Gmail saved the draft but returned no draft id');
    log.info(`gmail saved draft ${data.id}`);
    return { draftId: data.id };
  }

  async close(): Promise<void> {
    /* stateless HTTP client; nothing to release */
  }
}
