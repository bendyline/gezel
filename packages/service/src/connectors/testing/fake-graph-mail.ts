/**
 * A stateful in-process Microsoft Graph mailbox (`/v1.0/me`) for connector
 * tests.
 *
 * Models the message `delta` round-trip faithfully: an initial request that
 * snapshots the folder (honoring `$select` and the one supported
 * `$filter=receivedDateTime ge …`), pages sized by `Prefer:
 * odata.maxpagesize` (default 10) linked by `$skiptoken` nextLinks in Graph's
 * `mailFolders('<id>')` form, a closing `$deltatoken` deltaLink, and later
 * rounds that return only what changed — created and updated messages, plus
 * `@removed` entries for deletes and moves out (which, as the docs warn, are
 * not filtered). Tokens stay replayable until `expireTokens()`, after which
 * Graph answers 410 `syncStateNotFound`. Also `/$value` raw MIME, message
 * metadata, `sendMail` (JSON or base64 MIME) and draft creation through
 * `POST /me/messages` (403 without `Mail.ReadWrite`).
 *
 * References:
 *   https://learn.microsoft.com/en-us/graph/api/message-delta?view=graph-rest-1.0
 *   https://learn.microsoft.com/en-us/graph/delta-query-messages
 *   https://learn.microsoft.com/en-us/graph/api/user-post-messages?view=graph-rest-1.0
 */

import { createHash } from 'node:crypto';
import { type FakeHttp, type FakeRequest, bytes, json, status } from './fake-http.js';
import { type FixtureMessage, buildMime } from './mime.js';

export const FAKE_GRAPH_ROOT = 'https://graph.microsoft.com/v1.0/me';

export interface FakeGraphMessage {
  id: string;
  folderId: string;
  conversationId: string;
  internetMessageId: string;
  receivedDateTime: string;
  isRead: boolean;
  isDraft: boolean;
  subject: string;
  raw: Buffer;
}

export interface FakeGraphFixture extends FixtureMessage {
  /** Folder id or well-known name; default `inbox`. */
  folder?: string;
  /** Default false. */
  isRead?: boolean;
  /** Default the fixture's `date`. */
  receivedDateTime?: string;
}

interface Change {
  seq: number;
  folderId: string;
  id: string;
  removed: boolean;
}

interface Round {
  folderId: string;
  select: string[] | null;
  values: Record<string, unknown>[];
  /** Change-log position the round's closing deltaLink resumes from. */
  endSeq: number;
  generation: number;
}

interface DeltaState {
  folderId: string;
  select: string[] | null;
  seq: number;
  generation: number;
}

export interface CapturedSend {
  kind: 'json' | 'mime';
  body: unknown;
  raw?: Buffer;
}

function graphError(code: number, errorCode: string, message: string): Response {
  return status(code, {
    error: {
      code: errorCode,
      message,
      innerError: {
        date: '2026-10-19T00:00:00',
        'request-id': 'fake',
        'client-request-id': 'fake',
      },
    },
  });
}

/** Decode a base64 MIME body, or null when it is not base64 at all. */
function decodeMimeBody(text: string): Buffer | null {
  const compact = text.replace(/\s+/g, '');
  if (!compact || !/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) return null;
  return Buffer.from(compact, 'base64');
}

export class FakeGraphMail {
  readonly folders = new Map<string, { id: string; displayName: string; wellKnownName: string }>();
  readonly messages = new Map<string, FakeGraphMessage>();
  readonly sent: CapturedSend[] = [];
  /** Bodies of `POST /me/messages` (draft creation). */
  readonly createdDrafts: CapturedSend[] = [];
  /** The grant includes Mail.ReadWrite (drafts). */
  allowReadWrite = true;
  /** Refuse every bearer token (a revoked grant). */
  rejectTokens = false;
  private readonly changes: Change[] = [];
  private readonly rounds = new Map<string, Round>();
  private readonly deltas = new Map<string, DeltaState>();
  private generation = 0;
  private seq = 0;
  private ids = 0;
  private readonly now: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
    for (const [wellKnownName, displayName] of [
      ['inbox', 'Inbox'],
      ['drafts', 'Drafts'],
      ['sentitems', 'Sent Items'],
      ['archive', 'Archive'],
    ] as const) {
      const id = `AQMkAD${wellKnownName.toUpperCase()}AAAAAEMAAA=`;
      this.folders.set(id, { id, displayName, wellKnownName });
    }
  }

  folderId(nameOrId: string): string | undefined {
    if (this.folders.has(nameOrId)) return nameOrId;
    const lower = nameOrId.toLowerCase();
    for (const f of this.folders.values()) if (f.wellKnownName === lower) return f.id;
    return undefined;
  }

  private log(m: FakeGraphMessage, folderId: string, removed: boolean): void {
    this.changes.push({ seq: ++this.seq, folderId, id: m.id, removed });
  }

  private newId(): string {
    // Real ids are long base64 strings that may carry `=`, `-`, and `_`.
    return `AAMkAGI2_${(++this.ids).toString(36)}-msgAAA=`;
  }

  addMessage(fixture: FakeGraphFixture = {}): string {
    const folderId = this.folderId(fixture.folder ?? 'inbox');
    if (!folderId) throw new Error(`FakeGraphMail: no folder ${fixture.folder}`);
    const date = fixture.date ?? new Date(this.now()).toISOString();
    const internetMessageId = fixture.messageId ?? `graph-${this.ids + 1}@fixture.test`;
    const root = fixture.references?.[0] ?? fixture.inReplyTo ?? internetMessageId;
    const m: FakeGraphMessage = {
      id: this.newId(),
      folderId,
      conversationId: `AAQk${createHash('sha256').update(root).digest('hex').slice(0, 16)}=`,
      internetMessageId: `<${internetMessageId}>`,
      receivedDateTime: (fixture.receivedDateTime ?? date).replace(/\.\d{3}Z$/, 'Z'),
      isRead: fixture.isRead ?? false,
      isDraft: false,
      subject: fixture.subject ?? '(fixture)',
      raw: buildMime({ ...fixture, messageId: internetMessageId, date }),
    };
    this.messages.set(m.id, m);
    this.log(m, folderId, false);
    return m.id;
  }

  markRead(id: string, isRead = true): void {
    const m = this.must(id);
    m.isRead = isRead;
    this.log(m, m.folderId, false);
  }

  deleteMessage(id: string): void {
    const m = this.must(id);
    this.messages.delete(id);
    this.log(m, m.folderId, true);
  }

  /** Move to another folder. Graph ids change on a move. */
  moveMessage(id: string, folder: string): string {
    const m = this.must(id);
    const to = this.folderId(folder);
    if (!to) throw new Error(`FakeGraphMail: no folder ${folder}`);
    this.messages.delete(id);
    this.log(m, m.folderId, true);
    const moved = { ...m, id: this.newId(), folderId: to };
    this.messages.set(moved.id, moved);
    this.log(moved, to, false);
    return moved.id;
  }

  /** Invalidate every outstanding skip and delta token (Graph's cache eviction). */
  expireTokens(): void {
    this.generation++;
  }

  messageIds(): string[] {
    return [...this.messages.keys()];
  }

  private must(id: string): FakeGraphMessage {
    const m = this.messages.get(id);
    if (!m) throw new Error(`FakeGraphMail: no message ${id}`);
    return m;
  }

  private webLink(id: string): string {
    return `https://outlook.office365.com/owa/?ItemID=${encodeURIComponent(id)}&exvsurl=1&viewmodel=ReadMessageItem`;
  }

  private view(m: FakeGraphMessage, select: string[] | null): Record<string, unknown> {
    const all: Record<string, unknown> = {
      id: m.id,
      conversationId: m.conversationId,
      internetMessageId: m.internetMessageId,
      receivedDateTime: m.receivedDateTime,
      isRead: m.isRead,
      isDraft: m.isDraft,
      subject: m.subject,
      parentFolderId: m.folderId,
      webLink: this.webLink(m.id),
    };
    const out: Record<string, unknown> = {
      '@odata.type': '#microsoft.graph.message',
      '@odata.etag': `W/"${m.id}-${m.isRead ? 1 : 0}"`,
      id: m.id,
    };
    for (const [k, v] of Object.entries(all)) if (!select || select.includes(k)) out[k] = v;
    return out;
  }

  private authorized(req: FakeRequest): Response | null {
    if (!req.bearer || this.rejectTokens) {
      return graphError(
        401,
        'InvalidAuthenticationToken',
        'Access token has expired or is not yet valid.',
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
        `${FAKE_GRAPH_ROOT}${path}`,
        (req, p) => this.authorized(req) ?? handler(req, p),
      );

    route('GET', '/mailFolders', () =>
      json({
        value: [...this.folders.values()].map((f) => ({
          id: f.id,
          displayName: f.displayName,
          totalItemCount: [...this.messages.values()].filter((m) => m.folderId === f.id).length,
        })),
      }),
    );

    route('GET', '/mailFolders/:folder/messages/delta', (req, p) => this.delta(req, p.folder!));
    // nextLink / deltaLink form: `/me/mailFolders('<id>')/messages/delta`.
    route('GET', '/:folderRef/messages/delta', (req, p) => {
      const m = /^mailFolders\('([^']+)'\)$/i.exec(p.folderRef!);
      if (!m) return graphError(400, 'BadRequest', `Unsupported segment ${p.folderRef}`);
      return this.delta(req, m[1]!);
    });

    route('GET', '/messages/:id/$value', (_req, p) => {
      const m = this.messages.get(p.id!);
      if (!m)
        return graphError(
          404,
          'ErrorItemNotFound',
          'The specified object was not found in the store.',
        );
      return bytes(m.raw, 'text/plain');
    });

    route('GET', '/messages/:id', (req, p) => {
      const m = this.messages.get(p.id!);
      if (!m)
        return graphError(
          404,
          'ErrorItemNotFound',
          'The specified object was not found in the store.',
        );
      const select = req.url.searchParams.get('$select');
      return json(this.view(m, select ? select.split(',') : null));
    });

    route('POST', '/sendMail', (req) => {
      const captured = this.capture(req);
      if (captured instanceof Response) return captured;
      this.sent.push(captured);
      return new Response(null, { status: 202 });
    });

    route('POST', '/messages', (req) => {
      if (!this.allowReadWrite) {
        return graphError(
          403,
          'ErrorAccessDenied',
          'Access is denied. Check credentials and try again.',
        );
      }
      const captured = this.capture(req);
      if (captured instanceof Response) return captured;
      this.createdDrafts.push(captured);
      const draftsId = this.folderId('drafts')!;
      const header = captured.raw
        ? /^Message-ID:\s*(<[^>]+>)/im.exec(captured.raw.toString('utf8'))
        : null;
      const subject =
        (captured.raw
          ? /^Subject:\s*(.*)$/im.exec(captured.raw.toString('utf8'))?.[1]
          : undefined) ?? String((captured.body as { subject?: unknown }).subject ?? '');
      const m: FakeGraphMessage = {
        id: this.newId(),
        folderId: draftsId,
        conversationId: `AAQkdraft${this.ids}=`,
        internetMessageId: header?.[1] ?? `<draft-${this.ids}@fake.outlook>`,
        receivedDateTime: new Date(this.now()).toISOString().replace(/\.\d{3}Z$/, 'Z'),
        isRead: true,
        isDraft: true,
        subject,
        raw: captured.raw ?? Buffer.from(''),
      };
      this.messages.set(m.id, m);
      this.log(m, draftsId, false);
      return json(this.view(m, null), { status: 201 });
    });

    return this;
  }

  private capture(req: FakeRequest): CapturedSend | Response {
    const type = req.headers.get('content-type') ?? '';
    if (type.startsWith('text/plain')) {
      const raw = decodeMimeBody(req.bodyText);
      if (!raw) {
        return graphError(
          400,
          'ErrorMimeContentInvalidBase64String',
          'Invalid base64 string for MIME content.',
        );
      }
      return { kind: 'mime', body: req.bodyText, raw };
    }
    if (type.startsWith('application/json')) return { kind: 'json', body: req.json() };
    return graphError(415, 'UnsupportedMediaType', `Unsupported content type ${type}`);
  }

  private pageSize(req: FakeRequest): number {
    const m = /odata\.maxpagesize=(\d+)/i.exec(req.headers.get('prefer') ?? '');
    return m ? Math.max(1, Number(m[1])) : 10;
  }

  private delta(req: FakeRequest, folderRef: string): Response {
    const params = req.url.searchParams;
    const skip = params.get('$skiptoken');
    const deltaToken = params.get('$deltatoken');
    const expired = () =>
      graphError(
        410,
        'syncStateNotFound',
        'The sync state generation is not found. Resync is required.',
      );
    if (skip) {
      const [roundId, offsetRaw] = skip.split('.');
      const round = this.rounds.get(roundId ?? '');
      if (!round) return graphError(400, 'BadRequest', 'Invalid skip token');
      if (round.generation !== this.generation) return expired();
      return this.page(req, roundId!, round, Number(offsetRaw));
    }
    if (deltaToken) {
      const state = this.deltas.get(deltaToken);
      if (!state) return graphError(400, 'BadRequest', 'Invalid delta token');
      if (state.generation !== this.generation) return expired();
      // Changes since the token: the latest change per message, unfiltered.
      const latest = new Map<string, Change>();
      for (const c of this.changes) {
        if (c.seq > state.seq && c.folderId === state.folderId) latest.set(c.id, c);
      }
      const values: Record<string, unknown>[] = [];
      for (const c of latest.values()) {
        const m = this.messages.get(c.id);
        if (c.removed || !m || m.folderId !== state.folderId) {
          values.push({
            '@odata.type': '#microsoft.graph.message',
            id: c.id,
            '@removed': { reason: 'deleted' },
          });
        } else {
          values.push(this.view(m, state.select));
        }
      }
      return this.startRound(req, state.folderId, state.select, values);
    }
    const folderId = this.folderId(folderRef);
    if (!folderId) {
      return graphError(
        404,
        'ErrorItemNotFound',
        'The specified object was not found in the store.',
      );
    }
    const select = params.get('$select')?.split(',') ?? null;
    const filter = params.get('$filter');
    let ge: number | undefined;
    if (filter) {
      const m = /^receivedDateTime (ge|gt) (\S+)$/.exec(filter.trim());
      if (!m)
        return graphError(400, 'ErrorInvalidRestriction', `Unsupported delta filter: ${filter}`);
      ge = Date.parse(m[2]!) + (m[1] === 'gt' ? 1 : 0);
      if (!Number.isFinite(ge)) return graphError(400, 'BadRequest', `Invalid date in ${filter}`);
    }
    const values = [...this.messages.values()]
      .filter((m) => m.folderId === folderId)
      .filter((m) => ge === undefined || Date.parse(m.receivedDateTime) >= ge)
      .map((m) => this.view(m, select));
    return this.startRound(req, folderId, select, values);
  }

  private startRound(
    req: FakeRequest,
    folderId: string,
    select: string[] | null,
    values: Record<string, unknown>[],
  ): Response {
    const roundId = `R${this.rounds.size + 1}x${this.generation}`;
    const round: Round = {
      folderId,
      select,
      values,
      endSeq: this.seq,
      generation: this.generation,
    };
    this.rounds.set(roundId, round);
    return this.page(req, roundId, round, 0);
  }

  private page(req: FakeRequest, roundId: string, round: Round, offset: number): Response {
    const size = this.pageSize(req);
    const slice = round.values.slice(offset, offset + size);
    const base = `${FAKE_GRAPH_ROOT}/mailFolders('${round.folderId}')/messages/delta`;
    const body: Record<string, unknown> = {
      '@odata.context': 'https://graph.microsoft.com/v1.0/$metadata#Collection(message)',
    };
    if (offset + size < round.values.length) {
      body['@odata.nextLink'] = `${base}?$skiptoken=${roundId}.${offset + size}`;
    } else {
      const token = `D${this.deltas.size + 1}x${this.generation}`;
      this.deltas.set(token, {
        folderId: round.folderId,
        select: round.select,
        seq: round.endSeq,
        generation: round.generation,
      });
      body['@odata.deltaLink'] = `${base}?$deltatoken=${token}`;
    }
    body.value = slice;
    return json(body, { headers: { 'Preference-Applied': `odata.maxpagesize=${size}` } });
  }
}
