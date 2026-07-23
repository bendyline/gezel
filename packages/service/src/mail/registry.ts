/**
 * Mail provider factory + credential keys, plus mail's registration as a set of
 * `native` connector adapters. `createMailProvider` reads the legacy mail secret
 * (`mail-<provider>`/accountId); `mailAdapterFactory` reads the generic connector
 * secret (`connector-<type>`/bindingId) so a mail binding created through the
 * `/connectors/*` path drives the exact same providers + core.
 */

import type { ProjectMailAccount } from '@bendyline/gezel';
import { connectorSecretKey, registerNativeAdapter } from '../connectors/registry.js';
import type { AdapterFactory } from '../connectors/types.js';
import type { SecretStore } from '../secrets/types.js';
import { MailConnectorAdapter } from './adapter.js';
import type { OAuthCredential } from './oauth.js';
import { GmailMailProvider } from './providers/gmail.js';
import { GraphMailProvider } from './providers/graph.js';
import { ImapMailProvider } from './providers/imap.js';
import type { ImapCredential, MailProvider } from './types.js';

/** Toolset id under which IMAP connection blobs are stored in the SecretStore. */
export const IMAP_TOOLSET_ID = 'mail-imap';

export class MailCredentialMissingError extends Error {
  constructor(accountId: string) {
    super(`no stored credential for mail account ${accountId}`);
    this.name = 'MailCredentialMissingError';
  }
}

/** The SecretStore key holding an account's connection credential. */
export function mailSecretKey(account: Pick<ProjectMailAccount, 'id' | 'provider'>) {
  return { kind: 'toolset' as const, toolsetId: `mail-${account.provider}`, fieldId: account.id };
}

/** Build a provider from an already-fetched credential blob + re-persist callback. */
export function buildMailProvider(
  account: Pick<ProjectMailAccount, 'provider' | 'address'>,
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

/** Construct a connected-capable provider for an account (legacy mail secret). */
export async function createMailProvider(
  account: ProjectMailAccount,
  secrets: SecretStore,
): Promise<MailProvider> {
  const raw = await secrets.get(mailSecretKey(account));
  if (!raw) throw new MailCredentialMissingError(account.id);
  return buildMailProvider(account, raw, (cred) =>
    secrets.set(mailSecretKey(account), JSON.stringify(cred)),
  );
}

/**
 * Native connector adapter for mail: reconstructs the account from the binding
 * config and reads the credential from the generic connector secret key.
 */
export const mailAdapterFactory: AdapterFactory = async (binding, deps) => {
  const config = (binding.config ?? {}) as {
    provider?: ProjectMailAccount['provider'];
    address?: string;
    syncFolders?: string[];
  };
  const account = {
    provider: (config.provider ?? 'imap') as ProjectMailAccount['provider'],
    address: String(config.address ?? ''),
  };
  const folders = Array.isArray(config.syncFolders) ? config.syncFolders : ['INBOX'];
  const key = connectorSecretKey(binding.type, binding.id);
  const blob = await deps.secrets.get(key);
  if (!blob) throw new MailCredentialMissingError(binding.id);
  const provider = buildMailProvider(account, blob, (cred) =>
    deps.secrets.set(key, JSON.stringify(cred)),
  );
  return new MailConnectorAdapter(provider, folders, binding.id);
};

/** Register mail's four provider variants as native connector adapters. */
export function registerMailAdapters(): void {
  for (const id of ['mail-imap', 'mail-gmail', 'mail-microsoft365', 'mail-outlook']) {
    registerNativeAdapter(id, mailAdapterFactory);
  }
}
