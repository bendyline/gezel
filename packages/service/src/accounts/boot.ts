import { createLogger } from '@bendyline/gezel';
import type { TokenRecord, TokenStore } from '../http/token-store.js';
import { AccountManager, type AccountManagerOptions, type ResolvedSession } from './manager.js';
import { seedOwnerFromEnvironment } from './seed.js';

const log = createLogger('service');

export interface SetupLink {
  code: string;
  url: string;
}

/**
 * Open the accounts that sign people in on network-facing surfaces (ADR
 * 0029): the container listener, and `gezel start --web --accounts`.
 * Sessions live in their own store; the token store consults it for tokens
 * it does not hold, so every bearer-gated mount accepts a signed-in account.
 * A deployer's owner secret is applied here, while no account exists yet.
 */
export async function openAccounts(opts: {
  home: string;
  history: AccountManagerOptions['history'];
  tokenStore: TokenStore;
  /** Where a person reaches this daemon; setup links are built on it. */
  publicBase: () => string;
}): Promise<{ accounts: AccountManager; announceSetupLink: () => SetupLink | null }> {
  const accounts = await AccountManager.open({
    home: opts.home,
    history: opts.history,
    warn: (m) => log.warn(m),
  });
  opts.tokenStore.setAccountResolver((supplied) => {
    const resolved = accounts.resolve(supplied);
    return resolved ? accountTokenRecord(resolved, supplied) : null;
  });
  try {
    if ((await seedOwnerFromEnvironment(accounts)) === 'created') {
      log.info('[accounts] created the owner account from GEZEL_OWNER_PASSWORD_FILE');
    }
  } catch (err) {
    log.error(
      `[accounts] could not create the owner from GEZEL_OWNER_PASSWORD_FILE: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const announceSetupLink = (): SetupLink | null => {
    const code = accounts.mintSetupCode();
    if (!code) return null;
    const url = `${opts.publicBase()}/?setup=${code}`;
    log.info('[accounts] No account exists yet. Open this link to create the first one.');
    log.info('[accounts] It works once, for an hour:');
    log.info(`[accounts]   ${url}`);
    return { code, url };
  };
  return { accounts, announceSetupLink };
}

function accountTokenRecord(resolved: ResolvedSession, token: string): TokenRecord {
  return {
    appId: `account:${resolved.account.id}`,
    appName: resolved.account.name,
    // What the desktop's own credential carries: the UI reaches knowledge
    // and images through /v1 too.
    scopes: ['ui', 'openai', 'knowledge', 'images'],
    token,
    createdAt: Date.parse(resolved.account.createdAt),
    lastUsedAt: Date.now(),
    kind: 'account',
    account: resolved.principal,
    accountSessionId: resolved.sessionId,
  };
}
