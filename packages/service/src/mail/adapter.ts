/**
 * Mail as a `native` connector adapter. Wraps a `MailProvider` in the generic
 * `ConnectorAdapter` contract: folders become scopes, envelopes become record
 * refs (UID or received time → `ordinalKey`), and a fetched message is
 * normalized to a `NormalizedRecord` via `messageToRecord`.
 *
 * Two write actions, both committed through the outbox and never on the
 * model's tool surface: `send` transmits (cleared by `recipient-allowlist`),
 * and `save-draft` files the message in the account's own Drafts folder
 * (cleared by `mailbox-draft`) for the person to review and send themselves.
 */

import { isThrottle } from '../connectors/natives/oauth-session.js';
import type {
  ChangeBatch,
  ConnectorAdapter,
  ListChangesOptions,
  NormalizedRecord,
  RecordRef,
} from '../connectors/types.js';
import { canonicalRecipients, recipientEntries } from './recipient.js';
import { messageToRecord } from './storage.js';
import type { FetchHint, MailCursor, MailProvider, OutgoingMail } from './types.js';

interface MailActionInput {
  to?: unknown;
  cc?: unknown;
  bcc?: unknown;
  subject?: unknown;
  body?: unknown;
  inReplyTo?: unknown;
}

/** The action input as an `OutgoingMail`, parsed the way the consent enforcers parse it. */
function outgoingFrom(input: unknown): OutgoingMail {
  const o = (input ?? {}) as MailActionInput;
  const cc = canonicalRecipients(recipientEntries(o.cc));
  const bcc = canonicalRecipients(recipientEntries(o.bcc));
  return {
    to: canonicalRecipients(recipientEntries(o.to)),
    ...(cc.length ? { cc } : {}),
    ...(bcc.length ? { bcc } : {}),
    subject: typeof o.subject === 'string' ? o.subject : '',
    bodyMarkdown: typeof o.body === 'string' ? o.body : '',
    ...(typeof o.inReplyTo === 'string' && o.inReplyTo.trim()
      ? { inReplyTo: o.inReplyTo.trim() }
      : {}),
  };
}

function hintFrom(raw: unknown): FetchHint | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const r = raw as FetchHint;
  const hint: FetchHint = {
    ...(Array.isArray(r.flags) ? { flags: r.flags } : {}),
    ...(typeof r.url === 'string' ? { url: r.url } : {}),
  };
  return hint.flags || hint.url ? hint : undefined;
}

export class MailConnectorAdapter implements ConnectorAdapter<NormalizedRecord, MailCursor> {
  readonly typeId: string;
  /**
   * Thread folders used to be named for each message's date; they are now
   * named for the conversation. A message re-fetched (read-state change,
   * cursor resync) into an older corpus lands in its new folder, and the
   * engine drops the copy left at the old one.
   */
  readonly recordsMayMove = true;

  constructor(
    private readonly provider: MailProvider,
    private readonly folders: string[],
    private readonly accountId: string,
    private readonly identity: { address?: string; displayName?: string } = {},
  ) {
    this.typeId = `mail-${provider.kind}`;
  }

  ensureAuth(): Promise<void> {
    return this.provider.ensureAuth();
  }

  async listScopes(): Promise<string[]> {
    if (this.folders.length) return this.folders;
    return (await this.provider.listFolders()).map((f) => f.path);
  }

  async listChangesSince(
    scope: string,
    cursor: MailCursor | undefined,
    opts?: ListChangesOptions,
  ): Promise<ChangeBatch<MailCursor>> {
    let changes: Awaited<ReturnType<MailProvider['listChangesSince']>>;
    try {
      changes = await this.provider.listChangesSince(scope, cursor, {
        ...(opts?.limit !== undefined ? { limit: opts.limit } : {}),
      });
    } catch (err) {
      // A throttled list call is backpressure, not a failure: keep the cursor,
      // report rateLimited so the engine stops the pass and the manager backs
      // the binding off.
      if (isThrottle(err)) return { records: [], cursor: cursor ?? {}, rateLimited: true };
      throw err;
    }
    const records: RecordRef[] = changes.envelopes.map((e) => {
      const hint = hintFrom(e);
      return {
        id: e.id,
        ...(e.ordinalKey !== undefined ? { ordinalKey: e.ordinalKey } : {}),
        ...(hint ? { raw: hint } : {}),
      };
    });
    return {
      records,
      cursor: changes.cursor,
      ...(changes.partial ? { partial: true } : {}),
      ...(changes.rateLimited ? { rateLimited: true } : {}),
    };
  }

  async fetchRecord(scope: string, ref: RecordRef): Promise<NormalizedRecord> {
    const message = await this.provider.fetchMessage(scope, ref.id, hintFrom(ref.raw));
    return messageToRecord(this.accountId, message, { quarantineNamespace: this.typeId });
  }

  /** The identity a message is written from, when the binding names one. */
  private fromAddress(): string | undefined {
    const address = this.identity.address;
    if (!address) return undefined;
    return this.identity.displayName ? `${this.identity.displayName} <${address}>` : address;
  }

  /**
   * Commit-time write actions. The commit path has already verified the
   * action is declared and cleared its consent scope; recipients are re-read
   * here through the same parser the enforcers use, so nothing reaches the
   * provider that the enforcer did not check.
   */
  async runAction(action: string, input: unknown): Promise<unknown> {
    if (action === 'send') {
      const mail = outgoingFrom(input);
      if (!mail.to.length) throw new Error('send requires a non-empty `to` list');
      const from = this.fromAddress();
      if (!from) throw new Error('this mail binding has no address to send from');
      const sent = await this.provider.send(from, mail);
      return sent.messageId ? { messageId: sent.messageId } : { sent: true };
    }
    if (action === 'save-draft') {
      const mail = outgoingFrom(input);
      if (!mail.subject.trim() && !mail.bodyMarkdown.trim()) {
        throw new Error('save-draft needs a subject or a body');
      }
      const saved = await this.provider.saveDraft(this.fromAddress(), mail);
      return { draftId: saved.draftId, ...(saved.webLink ? { webLink: saved.webLink } : {}) };
    }
    throw new Error(`mail connector has no action '${action}'`);
  }

  close(): Promise<void> {
    return this.provider.close();
  }
}
