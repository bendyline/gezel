/**
 * Microsoft Graph provider — covers Microsoft 365 (work/school) and
 * Outlook.com (consumer); the two differ only by OAuth tenant.
 *
 * Sync is the per-folder message `delta` query. The first round is filtered to
 * the backfill window (`$filter=receivedDateTime ge …` is one of the two
 * filters message delta supports) and paged with `Prefer: odata.maxpagesize`;
 * an unfinished round persists its `@odata.nextLink` and reports `partial`, so
 * a large folder backfills over several batches instead of restarting from
 * scratch every pass. The round's `@odata.deltaLink` is the cursor after that.
 * https://learn.microsoft.com/en-us/graph/api/message-delta?view=graph-rest-1.0
 *
 * A stored link Graph no longer honors (410 Gone, or `syncStateNotFound` /
 * `resyncRequired`) restarts the round; the writer dedupes what it re-lists.
 * `@removed` entries are ignored: the corpus is a window, and a message moved
 * or deleted upstream stays in it.
 *
 * Raw MIME comes from `/$value`, which carries no read state, so the delta's
 * `isRead` rides along to `fetchMessage` as the `\Seen` flag. Outbound uses
 * `/sendMail`; `save-draft` creates the message in Drafts (`POST /me/messages`),
 * which needs the `Mail.ReadWrite` scope.
 */

import { HttpStatusError, createLogger } from '@bendyline/gezel';
import {
  type ApiRequestInit,
  type OAuthSession,
  authorizedFetch,
  authorizedJson,
  hasStatus,
} from '../../connectors/natives/oauth-session.js';
import { RecordGoneError } from '../../connectors/types.js';
import { composeMime } from '../compose.js';
import { parseRawMessage } from '../mime.js';
import { canonicalRecipients } from '../recipient.js';
import {
  type FetchHint,
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
const GRAPH = 'https://graph.microsoft.com/v1.0/me';
const GRAPH_ORIGIN = 'https://graph.microsoft.com';
/** Page size asked of delta; a batch takes whole pages, so it bounds the batch too. */
const DELTA_PAGE = 100;
/** Pages one call may walk (empty or `@removed`-only pages included). */
const MAX_PAGES_PER_CALL = 50;
const DELTA_SELECT = 'id,conversationId,internetMessageId,receivedDateTime,isRead,webLink';

/** Resolve Graph pagination cursors without ever forwarding our bearer token off-origin. */
export function validateGraphUrl(input: string): string {
  const parsed = /^https?:/i.test(input)
    ? new URL(input)
    : new URL(`${GRAPH}${input.startsWith('/') ? input : `/${input}`}`);
  if (
    parsed.origin !== GRAPH_ORIGIN ||
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    (parsed.pathname !== '/v1.0/me' && !parsed.pathname.startsWith('/v1.0/me/'))
  ) {
    throw new Error('refusing an untrusted Microsoft Graph pagination URL');
  }
  return parsed.href;
}

/** Map an IMAP-style folder name to a Graph well-known folder id. */
function mapFolder(folder: string): string {
  const lower = folder.toLowerCase();
  if (lower === 'inbox') return 'inbox';
  if (lower === 'sent' || lower === 'sent items') return 'sentitems';
  if (lower === 'drafts') return 'drafts';
  return folder; // assume a real folder id
}

interface GraphDeltaMessage {
  id: string;
  receivedDateTime?: string;
  /** Boolean in practice; Graph's own samples also show the string form. */
  isRead?: boolean | string;
  webLink?: string;
  '@removed'?: unknown;
}
interface GraphDeltaResponse {
  value?: GraphDeltaMessage[];
  '@odata.nextLink'?: string;
  '@odata.deltaLink'?: string;
}

/** True when Graph says a stored delta link can no longer be resumed. */
export function isDeltaReset(err: unknown): boolean {
  if (hasStatus(err, 410)) return true;
  return (
    err instanceof HttpStatusError &&
    err.status >= 400 &&
    err.status < 500 &&
    /syncStateNotFound|syncStateInvalid|resyncRequired/i.test(err.message)
  );
}

function readFlags(isRead: GraphDeltaMessage['isRead']): string[] | undefined {
  if (isRead === undefined) return undefined;
  return isRead === true || isRead === 'true' ? ['\\Seen'] : [];
}

function recipients(addrs: string[] | undefined) {
  return canonicalRecipients(addrs ?? []).map((address) => ({ emailAddress: { address } }));
}

export interface GraphProviderOptions extends MailSyncOptions {
  session: OAuthSession;
  fetchImpl?: typeof fetch;
}

export class GraphMailProvider implements MailProvider {
  private readonly fetchImpl: typeof fetch;

  constructor(
    readonly kind: 'microsoft365' | 'outlook',
    private readonly opts: GraphProviderOptions,
  ) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async ensureAuth(): Promise<void> {
    await this.opts.session.token();
  }

  private json<T>(url: string, init?: ApiRequestInit): Promise<T> {
    return authorizedJson<T>(
      this.opts.session,
      this.fetchImpl,
      validateGraphUrl(url),
      init,
      'Microsoft Graph',
    );
  }

  private raw(url: string, init?: ApiRequestInit): Promise<Response> {
    return authorizedFetch(
      this.opts.session,
      this.fetchImpl,
      validateGraphUrl(url),
      init,
      'Microsoft Graph',
    );
  }

  async listFolders(): Promise<MailFolder[]> {
    const data = await this.json<{ value?: { id: string; displayName: string }[] }>(
      '/mailFolders?$top=100',
    );
    return (data.value ?? []).map((f) => ({ path: f.id, name: f.displayName }));
  }

  private initialDeltaUrl(folder: string): string {
    const since = new Date(backfillStartMs(this.opts)).toISOString().replace(/\.\d{3}Z$/, 'Z');
    return (
      `${GRAPH}/mailFolders/${encodeURIComponent(mapFolder(folder))}/messages/delta` +
      `?$select=${DELTA_SELECT}&$filter=receivedDateTime+ge+${since}`
    );
  }

  async listChangesSince(
    folder: string,
    cursor: MailCursor | undefined,
    opts?: ListOptions,
  ): Promise<FolderChanges> {
    const limit = batchLimit(opts);
    const pageSize = Math.min(limit, DELTA_PAGE);
    const stored = cursor?.graphNextLink ?? cursor?.graphDeltaLink;
    let url = stored ?? this.initialDeltaUrl(folder);
    let restarted = !stored;
    const envelopes: MailEnvelope[] = [];
    const seen = new Set<string>();
    for (let pages = 0; ; pages++) {
      let data: GraphDeltaResponse;
      try {
        data = await this.json<GraphDeltaResponse>(url, {
          headers: { Prefer: `odata.maxpagesize=${pageSize}` },
        });
      } catch (err) {
        if (!restarted && isDeltaReset(err)) {
          log.info(`graph ${folder}: delta state expired; resyncing the window`);
          restarted = true;
          url = this.initialDeltaUrl(folder);
          continue;
        }
        throw err;
      }
      for (const m of data.value ?? []) {
        if (m['@removed'] || seen.has(m.id)) continue;
        seen.add(m.id);
        const received = m.receivedDateTime ? Date.parse(m.receivedDateTime) : Number.NaN;
        const flags = readFlags(m.isRead);
        envelopes.push({
          id: m.id,
          ...(Number.isFinite(received) ? { ordinalKey: received } : {}),
          ...(flags ? { flags } : {}),
          ...(m.webLink ? { url: m.webLink } : {}),
        });
      }
      const next = data['@odata.nextLink'];
      if (next) {
        const safe = validateGraphUrl(next);
        if (envelopes.length + pageSize > limit || pages + 1 >= MAX_PAGES_PER_CALL) {
          return { envelopes, cursor: { graphNextLink: safe }, partial: true };
        }
        url = safe;
        continue;
      }
      const delta = data['@odata.deltaLink'];
      if (!delta) throw new Error('Microsoft Graph delta returned neither a next nor a delta link');
      return { envelopes, cursor: { graphDeltaLink: validateGraphUrl(delta) } };
    }
  }

  async fetchMessage(folder: string, id: string, hint?: FetchHint): Promise<MailMessage> {
    const path = `/messages/${encodeURIComponent(id)}`;
    let buf: Buffer;
    try {
      const res = await this.raw(`${path}/$value`, { headers: { Accept: '*/*' } });
      buf = Buffer.from(await res.arrayBuffer());
    } catch (err) {
      if (hasStatus(err, 404)) throw new RecordGoneError(`graph message ${id} no longer exists`);
      throw err;
    }
    let flags = hint?.flags;
    let url = hint?.url;
    if (!flags) {
      // A delta update entry carries only the properties that changed.
      try {
        const meta = await this.json<{ isRead?: boolean; webLink?: string }>(
          `${path}?$select=isRead,webLink`,
        );
        flags = readFlags(meta.isRead) ?? [];
        url ??= meta.webLink;
      } catch (err) {
        if (hasStatus(err, 404)) throw new RecordGoneError(`graph message ${id} no longer exists`);
        throw err;
      }
    }
    return parseRawMessage(buf, { folder, id, flags, ...(url ? { url } : {}) });
  }

  /**
   * MIME for anything that must carry In-Reply-To/References: Graph's JSON
   * message shape only accepts custom `x-` headers, so a JSON reply would
   * arrive unthreaded.
   */
  private mime(from: string | undefined, mail: OutgoingMail): string {
    const { raw } = composeMime(from, mail, { date: new Date((this.opts.now ?? Date.now)()) });
    return raw.toString('base64');
  }

  async send(from: string, mail: OutgoingMail): Promise<{ messageId: string }> {
    if (mail.inReplyTo) {
      await this.raw('/sendMail', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: this.mime(from, mail),
      });
    } else {
      await this.raw('/sendMail', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: {
            subject: mail.subject,
            body: { contentType: 'Text', content: mail.bodyMarkdown },
            toRecipients: recipients(mail.to),
            ...(mail.cc?.length ? { ccRecipients: recipients(mail.cc) } : {}),
            ...(mail.bcc?.length ? { bccRecipients: recipients(mail.bcc) } : {}),
          },
          saveToSentItems: true,
        }),
      });
    }
    log.info(`graph sent message from ${from}`);
    return { messageId: '' }; // sendMail answers 202 with no id
  }

  async saveDraft(from: string | undefined, mail: OutgoingMail): Promise<SavedDraft> {
    let data: { id?: string; webLink?: string };
    try {
      data = await this.json('/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: this.mime(from, mail),
      });
    } catch (err) {
      if (hasStatus(err, 403)) {
        throw new Error(
          "Microsoft refused to save the draft: this account was linked without permission to write mail (Mail.ReadWrite). Re-link the account from the project's Connections to allow saving drafts.",
        );
      }
      throw err;
    }
    if (!data.id) throw new Error('Microsoft Graph saved the draft but returned no id');
    log.info(`graph saved draft ${data.id}`);
    return { draftId: data.id, ...(data.webLink ? { webLink: data.webLink } : {}) };
  }

  async close(): Promise<void> {
    /* stateless HTTP client */
  }
}
