/**
 * Mail as the first `native` connector adapter. Wraps a `MailProvider` in the
 * generic `ConnectorAdapter` contract: folders become scopes, envelopes become
 * record refs (UID → `ordinalKey`), and a fetched message is normalized to a
 * `NormalizedRecord` via `messageToRecord`. The provider (IMAP / Gmail / Graph)
 * and its cursor mechanics are unchanged — this is a thin shim over them.
 */

import { HttpStatusError, isRateLimitStatus } from '@bendyline/gezel';
import type {
  ChangeBatch,
  ConnectorAdapter,
  NormalizedRecord,
  RecordRef,
} from '../connectors/types.js';
import { messageToRecord } from './storage.js';
import type { MailCursor, MailProvider } from './types.js';

export class MailConnectorAdapter implements ConnectorAdapter<NormalizedRecord, MailCursor> {
  readonly typeId: string;

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
  ): Promise<ChangeBatch<MailCursor>> {
    let changes: Awaited<ReturnType<MailProvider['listChangesSince']>>;
    try {
      changes = await this.provider.listChangesSince(scope, cursor);
    } catch (err) {
      // A throttled list call is backpressure, not a failure: keep the cursor,
      // report rateLimited so the engine stops the pass and the manager backs
      // the binding off.
      if (err instanceof HttpStatusError && isRateLimitStatus(err.status)) {
        return { records: [], cursor: cursor ?? {}, rateLimited: true };
      }
      throw err;
    }
    const records: RecordRef[] = changes.envelopes.map((e) => ({
      id: e.id,
      ...(e.uid !== undefined ? { ordinalKey: e.uid } : {}),
    }));
    return {
      records,
      cursor: changes.cursor,
      ...(changes.rateLimited ? { rateLimited: true } : {}),
    };
  }

  async fetchRecord(scope: string, ref: RecordRef): Promise<NormalizedRecord> {
    return messageToRecord(this.accountId, await this.provider.fetchMessage(scope, ref.id));
  }

  /**
   * The `send` write action (outbox-committed, never model-invoked directly).
   * The commit path has already verified the action is declared and cleared
   * the `recipient-allowlist` consent scope; this transmits and reports the
   * provider Message-ID. Reply threading rides `inReplyTo`.
   */
  async runAction(action: string, input: unknown): Promise<unknown> {
    if (action !== 'send') throw new Error(`mail connector has no action '${action}'`);
    const send = (input ?? {}) as {
      to?: unknown;
      cc?: unknown;
      bcc?: unknown;
      subject?: unknown;
      body?: unknown;
      inReplyTo?: unknown;
    };
    const list = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
    const to = list(send.to);
    if (!to.length) throw new Error('send requires a non-empty `to` list');
    const address = this.identity.address;
    if (!address) throw new Error('this mail binding has no address to send from');
    const fromAddr = this.identity.displayName
      ? `${this.identity.displayName} <${address}>`
      : address;
    const sent = await this.provider.send(fromAddr, {
      to,
      ...(list(send.cc).length ? { cc: list(send.cc) } : {}),
      ...(list(send.bcc).length ? { bcc: list(send.bcc) } : {}),
      subject: typeof send.subject === 'string' ? send.subject : '',
      bodyMarkdown: typeof send.body === 'string' ? send.body : '',
      ...(typeof send.inReplyTo === 'string' && send.inReplyTo
        ? { inReplyTo: send.inReplyTo }
        : {}),
    });
    return sent.messageId ? { messageId: sent.messageId } : { sent: true };
  }

  close(): Promise<void> {
    return this.provider.close();
  }
}
