/**
 * Mail provider factory + mail's registration as a set of `native` connector
 * adapters. A mail account is an ordinary connector binding: the credential
 * lives under the generic connector secret key (`connector-<type>`/bindingId),
 * the account identity (`provider` / `address` / `syncFolders`) lives in the
 * binding config, and `mailAdapterFactory` reconstructs the provider from
 * both.
 */

import { connectorSecretKey, registerNativeAdapter } from '../connectors/registry.js';
import type { AdapterFactory } from '../connectors/types.js';
import { MailConnectorAdapter } from './adapter.js';
import type { OAuthCredential } from './oauth.js';
import { GmailMailProvider } from './providers/gmail.js';
import { GraphMailProvider } from './providers/graph.js';
import { ImapMailProvider } from './providers/imap.js';
import type { ImapCredential, MailProvider, MailProviderKind } from './types.js';

export class MailCredentialMissingError extends Error {
  constructor(accountId: string) {
    super(`no stored credential for mail account ${accountId}`);
    this.name = 'MailCredentialMissingError';
  }
}

/** Provider-appropriate default sync folder ids. */
export function defaultFoldersFor(provider: MailProviderKind): string[] {
  if (provider === 'microsoft365' || provider === 'outlook') return ['inbox'];
  return ['INBOX']; // Gmail's system inbox label is also 'INBOX'
}

/** Build a provider from an already-fetched credential blob + re-persist callback. */
export function buildMailProvider(
  account: { provider: MailProviderKind; address: string },
  blob: string,
  persist: (cred: OAuthCredential) => Promise<void>,
): MailProvider {
  switch (account.provider) {
    case 'imap':
      return new ImapMailProvider(account.address, JSON.parse(blob) as ImapCredential);
    case 'gmail':
      return new GmailMailProvider(JSON.parse(blob) as OAuthCredential, persist);
    case 'microsoft365':
    case 'outlook':
      return new GraphMailProvider(JSON.parse(blob) as OAuthCredential, persist);
    default:
      throw new Error(`unknown mail provider: ${String(account.provider)}`);
  }
}

/**
 * Native connector adapter for mail: reconstructs the account from the binding
 * config and reads the credential from the generic connector secret key.
 */
export const mailAdapterFactory: AdapterFactory = async (binding, deps) => {
  const config = (binding.config ?? {}) as {
    provider?: MailProviderKind;
    address?: string;
    displayName?: string;
    syncFolders?: string[];
  };
  const provider = (config.provider ?? 'imap') as MailProviderKind;
  const address = String(config.address ?? '');
  const folders =
    Array.isArray(config.syncFolders) && config.syncFolders.length
      ? config.syncFolders
      : defaultFoldersFor(provider);
  const key = connectorSecretKey(binding.type, binding.id);
  const blob = await deps.secrets.get(key);
  if (!blob) throw new MailCredentialMissingError(binding.id);
  const mailProvider = buildMailProvider({ provider, address }, blob, (cred) =>
    deps.secrets.set(key, JSON.stringify(cred)),
  );
  const accountId = address ? `${provider}:${address}` : binding.id;
  return new MailConnectorAdapter(mailProvider, folders, accountId, {
    ...(address ? { address } : {}),
    ...(config.displayName ? { displayName: config.displayName } : {}),
  });
};

/** Register mail's four provider variants as native connector adapters. */
export function registerMailAdapters(): void {
  for (const id of ['mail-imap', 'mail-gmail', 'mail-microsoft365', 'mail-outlook']) {
    registerNativeAdapter(id, mailAdapterFactory);
  }
}
