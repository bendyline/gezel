/**
 * Gmail provider (Gmail REST API). Incremental sync via the History API
 * (`historyId` cursor), raw-MIME fetch for the shared parser, and `messages.send`
 * for outbound. OAuth tokens are refreshed on demand and persisted via the
 * `persist` callback the registry supplies.
 */

import { HttpStatusError, createLogger } from '@bendyline/gezel';
import { buildRawMime } from '../compose.js';
import { parseRawMessage } from '../mime.js';
import { type OAuthCredential, isExpired, refreshAccessToken } from '../oauth.js';
import type {
  FolderChanges,
  MailCursor,
  MailEnvelope,
  MailFolder,
  MailMessage,
  MailProvider,
  OutgoingMail,
} from '../types.js';

const log = createLogger('mail');
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';

interface GmailMsgRef {
  id: string;
  threadId: string;
}

function toEnvelope(m: GmailMsgRef, folder: string): MailEnvelope {
  // Headers (messageId/from/subject/date) are filled in by fetchMessage; the
  // list only carries the fetch handle + thread grouping.
  return {
    id: m.id,
    messageId: m.id,
    threadKey: m.threadId,
    date: new Date(0).toISOString(),
    from: '',
    subject: '',
    flags: [],
    folder,
  };
}

export class GmailMailProvider implements MailProvider {
  readonly kind = 'gmail' as const;

  constructor(
    private cred: OAuthCredential,
    private readonly persist: (cred: OAuthCredential) => Promise<void>,
  ) {}

  async ensureAuth(): Promise<void> {
    if (!isExpired(this.cred)) return;
    const tokens = await refreshAccessToken(this.cred);
    this.cred = {
      ...this.cred,
      accessToken: tokens.accessToken,
      expiresAt: tokens.expiresAt,
      ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
    };
    await this.persist(this.cred);
  }

  private async api<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${GMAIL}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${this.cred.accessToken}`, ...(init?.headers ?? {}) },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new HttpStatusError(
        res.status,
        `gmail api ${path} failed: HTTP ${res.status} ${body}`.slice(0, 300),
      );
    }
    return res.json() as Promise<T>;
  }

  async listFolders(): Promise<MailFolder[]> {
    const data = await this.api<{ labels?: { id: string; name: string }[] }>('/labels');
    return (data.labels ?? []).map((l) => ({ path: l.id, name: l.name }));
  }

  async listChangesSince(folder: string, cursor: MailCursor | undefined): Promise<FolderChanges> {
    const startHistoryId = cursor?.gmailHistoryId;
    const envelopes: MailEnvelope[] = [];
    let newHistoryId = startHistoryId;

    if (startHistoryId) {
      let pageToken: string | undefined;
      do {
        const q = new URLSearchParams({
          startHistoryId,
          historyTypes: 'messageAdded',
          labelId: folder,
        });
        if (pageToken) q.set('pageToken', pageToken);
        const data = await this.api<{
          history?: { messagesAdded?: { message: GmailMsgRef }[] }[];
          historyId?: string;
          nextPageToken?: string;
        }>(`/history?${q.toString()}`);
        for (const h of data.history ?? []) {
          for (const m of h.messagesAdded ?? []) envelopes.push(toEnvelope(m.message, folder));
        }
        if (data.historyId) newHistoryId = data.historyId;
        pageToken = data.nextPageToken;
      } while (pageToken);
    } else {
      // Initial backfill: newest-first message list, then anchor the cursor at
      // the mailbox's current historyId so subsequent syncs go incremental.
      const data = await this.api<{ messages?: GmailMsgRef[] }>(
        `/messages?labelIds=${encodeURIComponent(folder)}&maxResults=100`,
      );
      for (const m of data.messages ?? []) envelopes.push(toEnvelope(m, folder));
      const profile = await this.api<{ historyId?: string }>('/profile');
      newHistoryId = profile.historyId ?? startHistoryId;
    }

    const newCursor: MailCursor = {
      ...(cursor ?? {}),
      ...(newHistoryId ? { gmailHistoryId: newHistoryId } : {}),
    };
    return { envelopes, cursor: newCursor };
  }

  async fetchMessage(folder: string, id: string): Promise<MailMessage> {
    const data = await this.api<{ raw?: string; labelIds?: string[] }>(
      `/messages/${id}?format=raw`,
    );
    if (!data.raw) throw new Error(`gmail message ${id} has no raw payload`);
    const buf = Buffer.from(data.raw, 'base64url');
    const flags = (data.labelIds ?? []).includes('UNREAD') ? [] : ['\\Seen'];
    return parseRawMessage(buf, { folder, id, flags });
  }

  async send(from: string, mail: OutgoingMail): Promise<{ messageId: string }> {
    const raw = buildRawMime(from, mail).toString('base64url');
    const data = await this.api<{ id?: string }>('/messages/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw }),
    });
    log.info(`gmail sent message ${data.id ?? '?'}`);
    return { messageId: data.id ?? '' };
  }

  async close(): Promise<void> {
    /* stateless HTTP client; nothing to release */
  }
}
