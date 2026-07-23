/**
 * Mail as the first `native` connector adapter. Wraps a `MailProvider` in the
 * generic `ConnectorAdapter` contract: folders become scopes, envelopes become
 * record refs (UID → `ordinalKey`), and a fetched message is normalized to a
 * `NormalizedRecord` via `messageToRecord`. The provider (IMAP / Gmail / Graph)
 * and its cursor mechanics are unchanged — this is a thin shim over them.
 */

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
    const changes = await this.provider.listChangesSince(scope, cursor);
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

  close(): Promise<void> {
    return this.provider.close();
  }
}
