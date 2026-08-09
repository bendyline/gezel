/**
 * Microsoft Graph provider — covers Microsoft 365 (work/school) and
 * Outlook.com (consumer); the two differ only by OAuth tenant. Incremental
 * sync via the messages `delta` query (the `@odata.deltaLink` is the cursor),
 * raw-MIME fetch via `/$value`, and outbound via `/sendMail`.
 */

import { HttpStatusError, createLogger } from '@bendyline/gezel';
import { extractEmail } from '../../connectors/consent.js';
import { parseRawMessage } from '../mime.js';
import { type OAuthCredential, isExpired, refreshAccessToken } from '../oauth.js';
import type {
  FolderChanges,
  MailCursor,
  MailEnvelope,
  MailFolder,
  MailMessage,
  MailProvider,
  MailProviderKind,
  OutgoingMail,
} from '../types.js';

const log = createLogger('mail');
const GRAPH = 'https://graph.microsoft.com/v1.0/me';
const GRAPH_ORIGIN = 'https://graph.microsoft.com';

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

interface GraphMessage {
  id: string;
  conversationId?: string;
  internetMessageId?: string;
  '@removed'?: unknown;
}
interface GraphDeltaResponse {
  value?: GraphMessage[];
  '@odata.nextLink'?: string;
  '@odata.deltaLink'?: string;
}

function recipients(addrs: string[] | undefined) {
  return (addrs ?? []).map((a) => ({ emailAddress: { address: extractEmail(a) } }));
}

export class GraphMailProvider implements MailProvider {
  readonly kind: MailProviderKind;

  constructor(
    private cred: OAuthCredential,
    private readonly persist: (cred: OAuthCredential) => Promise<void>,
  ) {
    this.kind = cred.provider;
  }

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

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.cred.accessToken}` };
  }

  private async getJson<T>(url: string): Promise<T> {
    const safeUrl = validateGraphUrl(url);
    const res = await fetch(safeUrl, {
      headers: this.headers(),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new HttpStatusError(
        res.status,
        `graph ${url} failed: HTTP ${res.status} ${body}`.slice(0, 300),
      );
    }
    return res.json() as Promise<T>;
  }

  async listFolders(): Promise<MailFolder[]> {
    const data = await this.getJson<{ value?: { id: string; displayName: string }[] }>(
      '/mailFolders?$top=100',
    );
    return (data.value ?? []).map((f) => ({ path: f.id, name: f.displayName }));
  }

  async listChangesSince(folder: string, cursor: MailCursor | undefined): Promise<FolderChanges> {
    const envelopes: MailEnvelope[] = [];
    let url =
      cursor?.graphDeltaLink ??
      `${GRAPH}/mailFolders/${encodeURIComponent(mapFolder(folder))}/messages/delta?$select=id,conversationId,internetMessageId`;
    let deltaLink = cursor?.graphDeltaLink;

    // Page through nextLinks until the server hands back the deltaLink.
    for (let guard = 0; guard < 1000; guard++) {
      const data = await this.getJson<GraphDeltaResponse>(url);
      for (const m of data.value ?? []) {
        if (m['@removed']) continue;
        envelopes.push({
          id: m.id,
          messageId: m.internetMessageId ?? m.id,
          threadKey: m.conversationId ?? m.id,
          date: new Date(0).toISOString(),
          from: '',
          subject: '',
          flags: [],
          folder,
        });
      }
      if (data['@odata.nextLink']) {
        url = validateGraphUrl(data['@odata.nextLink']);
        continue;
      }
      deltaLink = data['@odata.deltaLink'] ? validateGraphUrl(data['@odata.deltaLink']) : deltaLink;
      break;
    }

    const newCursor: MailCursor = {
      ...(cursor ?? {}),
      ...(deltaLink ? { graphDeltaLink: deltaLink } : {}),
    };
    return { envelopes, cursor: newCursor };
  }

  async fetchMessage(folder: string, id: string): Promise<MailMessage> {
    const res = await fetch(`${GRAPH}/messages/${encodeURIComponent(id)}/$value`, {
      headers: this.headers(),
    });
    if (!res.ok) {
      throw new Error(`graph message ${id} fetch failed: HTTP ${res.status}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    // $value doesn't carry read-state; flags are resolved lazily elsewhere.
    return parseRawMessage(buf, { folder, id, flags: [] });
  }

  async send(from: string, mail: OutgoingMail): Promise<{ messageId: string }> {
    const res = await fetch(`${GRAPH}/sendMail`, {
      method: 'POST',
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
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
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`graph sendMail failed: HTTP ${res.status} ${body}`.slice(0, 300));
    }
    log.info(`graph sent message from ${from}`);
    return { messageId: '' }; // sendMail returns 202 with no id
  }

  async close(): Promise<void> {
    /* stateless HTTP client */
  }
}
