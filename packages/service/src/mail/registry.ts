/**
 * Mail provider factory + mail's registration as a set of `native` connector
 * adapters. A mail account is an ordinary connector binding: the credential
 * lives under the generic connector secret key (`connector-<type>`/bindingId),
 * the account identity (`address` / `syncFolders` / `backfillDays`) lives in
 * the binding config, and the factory reconstructs the provider from both.
 *
 * Which provider a binding uses comes from the connector type, never from a
 * config key: a `mail-gmail` binding linked without `config.provider` used to
 * fall through to IMAP and parse its OAuth blob as an IMAP password.
 */

import { connectorSecretKey, registerNativeAdapter } from '../connectors/registry.js';
import type { AdapterDeps, AdapterFactory, ConnectorBindingRef } from '../connectors/types.js';
import { MailConnectorAdapter } from './adapter.js';
import { createMailOAuthSession } from './oauth.js';
import { GmailMailProvider } from './providers/gmail.js';
import { GraphMailProvider } from './providers/graph.js';
import { ImapMailProvider, type ImapProviderOptions } from './providers/imap.js';
import {
  DEFAULT_BACKFILL_DAYS,
  type ImapCredential,
  type MailProvider,
  type MailProviderKind,
} from './types.js';

export class MailCredentialMissingError extends Error {
  constructor(accountId: string) {
    super(
      `No stored sign-in for mail account ${accountId}. Re-link the account from the project's Connections.`,
    );
    this.name = 'MailCredentialMissingError';
  }
}

/** Connector type (and native adapter id) → mail provider. */
export const MAIL_TYPE_PROVIDERS: Readonly<Record<string, MailProviderKind>> = {
  'mail-imap': 'imap',
  'mail-gmail': 'gmail',
  'mail-microsoft365': 'microsoft365',
  'mail-outlook': 'outlook',
};

const PROVIDER_KINDS = new Set<string>(Object.values(MAIL_TYPE_PROVIDERS));

/**
 * The provider a binding speaks. `adapterKind` (the registered adapter id's
 * provider) wins; otherwise the binding's type decides. A `config.provider`
 * that disagrees is an error, not a hint — guessing would hand one provider's
 * credential to another.
 */
export function mailProviderFor(
  binding: ConnectorBindingRef,
  adapterKind?: MailProviderKind,
): MailProviderKind {
  const declared = (binding.config as { provider?: unknown } | undefined)?.provider;
  const fromType = MAIL_TYPE_PROVIDERS[binding.type];
  if (adapterKind && fromType && adapterKind !== fromType) {
    throw new Error(
      `mail binding ${binding.id} (${binding.type}) reached the ${adapterKind} adapter`,
    );
  }
  const kind = adapterKind ?? fromType;
  if (!kind) {
    if (typeof declared === 'string' && PROVIDER_KINDS.has(declared)) {
      return declared as MailProviderKind;
    }
    throw new Error(
      `connector type '${binding.type}' is not a mail type; expected one of ${Object.keys(MAIL_TYPE_PROVIDERS).join(', ')}`,
    );
  }
  if (declared !== undefined && declared !== kind) {
    throw new Error(
      `mail binding ${binding.id} is a ${kind} account but its config names provider '${String(declared)}'. Remove the provider setting or re-link the account.`,
    );
  }
  return kind;
}

/** Provider-appropriate default sync folder ids. */
export function defaultFoldersFor(provider: MailProviderKind): string[] {
  if (provider === 'microsoft365' || provider === 'outlook') return ['inbox'];
  return ['INBOX']; // Gmail's system inbox label is also 'INBOX'
}

/** `config.backfillDays` when it is a sane day count, else the default. */
export function backfillDaysFrom(config: Record<string, unknown> | undefined): number {
  const v = config?.backfillDays;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 1) return DEFAULT_BACKFILL_DAYS;
  return Math.min(Math.floor(v), 3650);
}

export interface MailAdapterOverrides {
  /** IMAP client / SMTP transport seams (tests). */
  imap?: Pick<ImapProviderOptions, 'createClient' | 'createTransport'>;
  /** Clock seam (tests). */
  now?: () => number;
}

async function buildProvider(
  kind: MailProviderKind,
  binding: ConnectorBindingRef,
  deps: AdapterDeps,
  address: string,
  backfillDays: number,
  overrides: MailAdapterOverrides,
): Promise<MailProvider> {
  const sync = { backfillDays, ...(overrides.now ? { now: overrides.now } : {}) };
  if (kind === 'imap') {
    const blob = await deps.secrets.get(connectorSecretKey(binding.type, binding.id));
    if (!blob) throw new MailCredentialMissingError(binding.id);
    let cred: ImapCredential;
    try {
      cred = JSON.parse(blob) as ImapCredential;
    } catch {
      throw new Error(
        `The stored IMAP settings for mail account ${binding.id} are unreadable. Re-enter the server and app password in the project's Connections.`,
      );
    }
    if (!cred || typeof cred.host !== 'string' || typeof cred.user !== 'string') {
      throw new Error(
        `The stored IMAP settings for mail account ${binding.id} name no server or user. Re-enter them in the project's Connections.`,
      );
    }
    return new ImapMailProvider(address, cred, { ...sync, ...(overrides.imap ?? {}) });
  }
  const session = createMailOAuthSession(binding, deps, kind);
  const fetchImpl = deps.fetch ?? fetch;
  if (kind === 'gmail') return new GmailMailProvider({ session, fetchImpl, ...sync });
  return new GraphMailProvider(kind, { session, fetchImpl, ...sync });
}

/**
 * Build the connector adapter for a mail binding. `adapterKind` pins the
 * provider for adapters registered per provider; tests use `overrides` to
 * reach the IMAP and clock seams.
 */
export async function createMailAdapter(
  binding: ConnectorBindingRef,
  deps: AdapterDeps,
  adapterKind?: MailProviderKind,
  overrides: MailAdapterOverrides = {},
): Promise<MailConnectorAdapter> {
  const config = (binding.config ?? {}) as {
    address?: unknown;
    displayName?: unknown;
    syncFolders?: unknown;
  };
  const provider = mailProviderFor(binding, adapterKind);
  const address = typeof config.address === 'string' ? config.address : '';
  const folders =
    Array.isArray(config.syncFolders) && config.syncFolders.length
      ? config.syncFolders.filter((f): f is string => typeof f === 'string' && f.length > 0)
      : defaultFoldersFor(provider);
  const mailProvider = await buildProvider(
    provider,
    binding,
    deps,
    address,
    backfillDaysFrom(binding.config),
    overrides,
  );
  const accountId = address ? `${provider}:${address}` : binding.id;
  return new MailConnectorAdapter(mailProvider, folders, accountId, {
    ...(address ? { address } : {}),
    ...(typeof config.displayName === 'string' && config.displayName
      ? { displayName: config.displayName }
      : {}),
  });
}

/** Native adapter factory that derives the provider from the binding's type. */
export const mailAdapterFactory: AdapterFactory = (binding, deps) =>
  createMailAdapter(binding, deps);

/** Register mail's four provider variants as native connector adapters. */
export function registerMailAdapters(): void {
  for (const [adapterId, kind] of Object.entries(MAIL_TYPE_PROVIDERS)) {
    registerNativeAdapter(adapterId, (binding, deps) => createMailAdapter(binding, deps, kind));
  }
}
