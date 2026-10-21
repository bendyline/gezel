/**
 * A stateful in-process Gmail (REST v1, `users/me`) for connector tests.
 *
 * Models the parts of the API the mail adapter drives, with the real shapes:
 * labels, `messages.list` (newest first, `labelIds`, `q=after:<epoch>` and
 * `rfc822msgid:`, `maxResults`/`pageToken`), `messages.get?format=raw`
 * (base64url MIME built by `testing/mime.ts`), `history.list` (a monotonically
 * increasing history id, `labelId` + repeated `historyTypes` filters, paging,
 * and the documented 404 once `startHistoryId` has aged out), `/profile`,
 * `drafts.create`, and `messages.send`. Bearer tokens are checked, so a
 * revoked grant shows up as the 401 the adapter must turn into "re-link".
 *
 * References:
 *   https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.history/list
 *   https://developers.google.com/workspace/gmail/api/guides/sync
 */

import { type FakeHttp, type FakeRequest, json, status } from './fake-http.js';
import { type FixtureMessage, buildMime } from './mime.js';

export const FAKE_GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';

export interface FakeGmailMessage {
  id: string;
  threadId: string;
  labelIds: Set<string>;
  raw: Buffer;
  /** ms since epoch. */
  internalDate: number;
  /** RFC Message-ID, without angle brackets. */
  rfc822MessageId: string;
}

type HistoryKind = 'messageAdded' | 'messageDeleted' | 'labelAdded' | 'labelRemoved';

interface HistoryRecord {
  id: number;
  kind: HistoryKind;
  messageId: string;
  threadId: string;
  /** The message's labels after the change (what `labelId` filters on). */
  labelsAfter: string[];
  /** Labels the change added or removed. */
  changed?: string[];
}

export interface FakeGmailFixture extends FixtureMessage {
  /** Default `['INBOX']`. */
  labelIds?: string[];
  /** Default true. */
  unread?: boolean;
  threadId?: string;
  /** ms since epoch; default the fixture's `date`. */
  internalDate?: number;
}

function googleError(code: number, message: string, statusText: string, reason?: string): Response {
  return status(code, {
    error: {
      code,
      message,
      errors: [{ message, domain: 'global', reason: reason ?? statusText.toLowerCase() }],
      status: statusText,
    },
  });
}

const encodeToken = (o: Record<string, unknown>) =>
  Buffer.from(JSON.stringify(o)).toString('base64url');
function decodeToken(t: string): Record<string, unknown> | null {
  try {
    return JSON.parse(Buffer.from(t, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export class FakeGmail {
  readonly messages = new Map<string, FakeGmailMessage>();
  readonly drafts: { id: string; messageId: string; threadId: string; raw: Buffer }[] = [];
  readonly sent: { id: string; threadId: string; raw: Buffer }[] = [];
  readonly labels = [
    { id: 'INBOX', name: 'INBOX', type: 'system' },
    { id: 'SENT', name: 'SENT', type: 'system' },
    { id: 'DRAFT', name: 'DRAFT', type: 'system' },
    { id: 'UNREAD', name: 'UNREAD', type: 'system' },
    { id: 'Label_1', name: 'Receipts', type: 'user' },
  ];
  /** Server page caps (Gmail's are 500 for both lists). */
  maxListPage = 500;
  maxHistoryPage = 500;
  /** Refuse every bearer token (a revoked grant). */
  rejectTokens = false;
  historyId = 5000;
  readonly emailAddress: string;
  private readonly history: HistoryRecord[] = [];
  /** Start ids below this have aged out of history. */
  private oldestValidStart = 0;
  private seq = 0;
  private readonly now: () => number;

  constructor(opts: { now?: () => number; emailAddress?: string } = {}) {
    this.now = opts.now ?? Date.now;
    this.emailAddress = opts.emailAddress ?? 'me@example.com';
  }

  private record(kind: HistoryKind, m: FakeGmailMessage, changed?: string[]): void {
    // History ids are increasing but not contiguous.
    this.historyId += 1 + (this.seq % 3);
    this.history.push({
      id: this.historyId,
      kind,
      messageId: m.id,
      threadId: m.threadId,
      labelsAfter: [...m.labelIds],
      ...(changed ? { changed } : {}),
    });
  }

  private newId(): string {
    return (0x18f2a000000 + ++this.seq).toString(16);
  }

  /** Deliver a message. Returns its Gmail id. */
  addMessage(fixture: FakeGmailFixture = {}): string {
    const id = this.newId();
    const rfc822MessageId = fixture.messageId ?? `gm-${id}@fixture.test`;
    const date = fixture.date ?? new Date(this.now()).toISOString();
    const raw = buildMime({ ...fixture, messageId: rfc822MessageId, date });
    const labels = new Set(fixture.labelIds ?? ['INBOX']);
    if (fixture.unread !== false) labels.add('UNREAD');
    const message: FakeGmailMessage = {
      id,
      threadId: fixture.threadId ?? this.threadFor(fixture) ?? id,
      labelIds: labels,
      raw,
      internalDate: fixture.internalDate ?? Date.parse(date),
      rfc822MessageId,
    };
    this.messages.set(id, message);
    this.record('messageAdded', message);
    return id;
  }

  /** Gmail threads a reply with the message it references. */
  private threadFor(fixture: FakeGmailFixture): string | undefined {
    const parent = fixture.inReplyTo ?? fixture.references?.[0];
    if (!parent) return undefined;
    for (const m of this.messages.values()) if (m.rfc822MessageId === parent) return m.threadId;
    return undefined;
  }

  addLabels(id: string, labelIds: string[]): void {
    const m = this.must(id);
    const added = labelIds.filter((l) => !m.labelIds.has(l));
    for (const l of added) m.labelIds.add(l);
    if (added.length) this.record('labelAdded', m, added);
  }

  removeLabels(id: string, labelIds: string[]): void {
    const m = this.must(id);
    const removed = labelIds.filter((l) => m.labelIds.has(l));
    for (const l of removed) m.labelIds.delete(l);
    if (removed.length) this.record('labelRemoved', m, removed);
  }

  markRead(id: string): void {
    this.removeLabels(id, ['UNREAD']);
  }

  deleteMessage(id: string): void {
    const m = this.must(id);
    this.messages.delete(id);
    this.record('messageDeleted', m);
  }

  /** Age every existing history id out, as Gmail does after a week or so. */
  expireHistory(): void {
    this.historyId += 7;
    this.oldestValidStart = this.historyId;
  }

  /** Ids in delivery order. */
  ids(): string[] {
    return [...this.messages.keys()];
  }

  private must(id: string): FakeGmailMessage {
    const m = this.messages.get(id);
    if (!m) throw new Error(`FakeGmail: no message ${id}`);
    return m;
  }

  private authorized(req: FakeRequest): Response | null {
    if (!req.bearer || this.rejectTokens) {
      return googleError(
        401,
        'Request had invalid authentication credentials. Expected OAuth 2 access token.',
        'UNAUTHENTICATED',
        'authError',
      );
    }
    return null;
  }

  install(http: FakeHttp): this {
    const route = (
      method: string,
      path: string,
      handler: (req: FakeRequest, p: Record<string, string>) => Response,
    ) =>
      http.on(
        method,
        `${FAKE_GMAIL_API}${path}`,
        (req, p) => this.authorized(req) ?? handler(req, p),
      );

    route('GET', '/profile', () =>
      json({
        emailAddress: this.emailAddress,
        messagesTotal: this.messages.size,
        threadsTotal: new Set([...this.messages.values()].map((m) => m.threadId)).size,
        historyId: String(this.historyId),
      }),
    );

    route('GET', '/labels', () => json({ labels: this.labels }));

    route('GET', '/messages', (req) => this.listMessages(req));

    route('GET', '/messages/:id', (req, p) => {
      const m = this.messages.get(p.id!);
      if (!m) return googleError(404, 'Requested entity was not found.', 'NOT_FOUND', 'notFound');
      const format = req.url.searchParams.get('format') ?? 'full';
      if (format !== 'raw')
        return googleError(400, 'fake supports format=raw only', 'INVALID_ARGUMENT');
      return json({
        id: m.id,
        threadId: m.threadId,
        labelIds: [...m.labelIds],
        snippet: '',
        historyId: String(this.historyId),
        internalDate: String(m.internalDate),
        sizeEstimate: m.raw.length,
        raw: m.raw.toString('base64url'),
      });
    });

    route('GET', '/history', (req) => this.listHistory(req));

    route('POST', '/messages/send', (req) => {
      const body = req.json<{ raw?: string; threadId?: string }>();
      if (!body.raw)
        return googleError(400, "'raw' RFC822 payload message string required", 'INVALID_ARGUMENT');
      const m = this.storeOutgoing(Buffer.from(body.raw, 'base64url'), body.threadId, 'SENT');
      if (!m) return googleError(404, 'Requested entity was not found.', 'NOT_FOUND', 'notFound');
      this.sent.push({ id: m.id, threadId: m.threadId, raw: m.raw });
      return json({ id: m.id, threadId: m.threadId, labelIds: ['SENT'] });
    });

    route('POST', '/drafts', (req) => {
      const body = req.json<{ message?: { raw?: string; threadId?: string } }>();
      if (!body.message?.raw) return googleError(400, 'Invalid draft', 'INVALID_ARGUMENT');
      const m = this.storeOutgoing(
        Buffer.from(body.message.raw, 'base64url'),
        body.message.threadId,
        'DRAFT',
      );
      if (!m) return googleError(404, 'Requested entity was not found.', 'NOT_FOUND', 'notFound');
      const draftId = `r-${this.seq}`;
      this.drafts.push({ id: draftId, messageId: m.id, threadId: m.threadId, raw: m.raw });
      return json({
        id: draftId,
        message: { id: m.id, threadId: m.threadId, labelIds: ['DRAFT'] },
      });
    });

    return this;
  }

  /** A sent message or draft: stored and recorded like any other. */
  private storeOutgoing(
    raw: Buffer,
    threadId: string | undefined,
    label: string,
  ): FakeGmailMessage | null {
    if (threadId && ![...this.messages.values()].some((m) => m.threadId === threadId)) return null;
    const id = this.newId();
    const header = /^Message-ID:\s*<([^>]+)>/im.exec(raw.toString('utf8'));
    const m: FakeGmailMessage = {
      id,
      threadId: threadId ?? id,
      labelIds: new Set([label]),
      raw,
      internalDate: this.now(),
      rfc822MessageId: header?.[1] ?? `${id}@gmail.fake`,
    };
    this.messages.set(id, m);
    this.record('messageAdded', m);
    return m;
  }

  private listMessages(req: FakeRequest): Response {
    const params = req.url.searchParams;
    const labelIds = params.getAll('labelIds');
    let after: number | undefined;
    let rfc822: string | undefined;
    for (const term of (params.get('q') ?? '').split(/\s+/).filter(Boolean)) {
      const [op, ...rest] = term.split(':');
      const value = rest.join(':');
      if (op === 'after') after = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value);
      else if (op === 'rfc822msgid') rfc822 = value.replace(/^<|>$/g, '');
      else
        return googleError(
          400,
          `fake does not support the search operator '${op}'`,
          'INVALID_ARGUMENT',
        );
    }
    const matching = [...this.messages.values()]
      .filter((m) => labelIds.every((l) => m.labelIds.has(l)))
      .filter((m) => after === undefined || m.internalDate >= after)
      .filter((m) => rfc822 === undefined || m.rfc822MessageId === rfc822)
      .sort((a, b) => b.internalDate - a.internalDate || (a.id < b.id ? 1 : -1));
    const max = Math.min(Number(params.get('maxResults') ?? 100), this.maxListPage);
    const token = params.get('pageToken');
    let offset = 0;
    if (token) {
      const t = decodeToken(token);
      if (!t || typeof t.o !== 'number')
        return googleError(400, 'Invalid pageToken', 'INVALID_ARGUMENT');
      offset = t.o;
    }
    const page = matching.slice(offset, offset + max);
    const next = offset + max < matching.length ? encodeToken({ o: offset + max }) : undefined;
    return json({
      ...(page.length ? { messages: page.map((m) => ({ id: m.id, threadId: m.threadId })) } : {}),
      ...(next ? { nextPageToken: next } : {}),
      resultSizeEstimate: matching.length,
    });
  }

  private listHistory(req: FakeRequest): Response {
    const params = req.url.searchParams;
    const startRaw = params.get('startHistoryId');
    if (!startRaw) return googleError(400, 'Missing startHistoryId', 'INVALID_ARGUMENT');
    const start = Number(startRaw);
    if (!Number.isFinite(start) || start < this.oldestValidStart) {
      return googleError(404, 'Requested entity was not found.', 'NOT_FOUND', 'notFound');
    }
    const labelId = params.get('labelId');
    const types = new Set(params.getAll('historyTypes'));
    const matching = this.history.filter(
      (h) =>
        h.id > start &&
        (!labelId || h.labelsAfter.includes(labelId) || h.changed?.includes(labelId)) &&
        (types.size === 0 || types.has(h.kind)),
    );
    const max = Math.min(Number(params.get('maxResults') ?? 100), this.maxHistoryPage);
    const token = params.get('pageToken');
    let offset = 0;
    if (token) {
      const t = decodeToken(token);
      if (!t || typeof t.o !== 'number' || t.s !== start) {
        return googleError(400, 'Invalid pageToken', 'INVALID_ARGUMENT');
      }
      offset = t.o;
    }
    const page = matching.slice(offset, offset + max);
    const next =
      offset + max < matching.length ? encodeToken({ o: offset + max, s: start }) : undefined;
    return json({
      ...(page.length ? { history: page.map((h) => this.historyJson(h)) } : {}),
      ...(next ? { nextPageToken: next } : {}),
      historyId: String(this.historyId),
    });
  }

  private historyJson(h: HistoryRecord): Record<string, unknown> {
    const message = { id: h.messageId, threadId: h.threadId, labelIds: h.labelsAfter };
    const base = { id: String(h.id), messages: [{ id: h.messageId, threadId: h.threadId }] };
    switch (h.kind) {
      case 'messageAdded':
        return { ...base, messagesAdded: [{ message }] };
      case 'messageDeleted':
        return {
          ...base,
          messagesDeleted: [{ message: { id: h.messageId, threadId: h.threadId } }],
        };
      case 'labelAdded':
        return { ...base, labelsAdded: [{ message, labelIds: h.changed ?? [] }] };
      case 'labelRemoved':
        return { ...base, labelsRemoved: [{ message, labelIds: h.changed ?? [] }] };
    }
  }
}
