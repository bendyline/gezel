import type {
  Account,
  AccountListResponse,
  AccountSessionListResponse,
  SignInResponse,
  SignInState,
} from '@bendyline/gezel';
import type { ClientJsonRequest } from './office-integrations.js';

/**
 * Accounts that sign people in on network-facing surfaces, and their
 * sessions. Reached as `client.accounts`. See docs/accounts.md and ADR 0029.
 */
export class AccountsClient {
  constructor(private readonly request: ClientJsonRequest) {}

  /** Whether this daemon asks for a sign-in, and whether setup is still open. */
  getSignInState(): Promise<SignInState> {
    return this.request('GET', '/v1/apps/signin/state');
  }

  signIn(name: string, password: string): Promise<SignInResponse> {
    return this.request('POST', '/v1/apps/signin', { name, password });
  }

  /** Create the first account with the setup code from the logs. */
  setUpFirstAccount(code: string, name: string, password: string): Promise<SignInResponse> {
    return this.request('POST', '/v1/apps/signin/setup', { code, name, password });
  }

  /** End the account session this client signed in with. */
  signOut(): Promise<{ signedOut: boolean }> {
    return this.request('POST', '/v1/apps/signin/signout');
  }

  /** A fresh setup link, while no account exists. Owner credential only. */
  createSetupLink(): Promise<{ code: string | null; url?: string }> {
    return this.request('POST', '/api/accounts/setup-link');
  }

  listAccounts(): Promise<AccountListResponse> {
    return this.request('GET', '/api/accounts');
  }

  createAccount(name: string, password: string): Promise<{ account: Account }> {
    return this.request('POST', '/api/accounts', { name, password });
  }

  updateAccount(
    id: string,
    change: { name?: string; disabled?: boolean },
  ): Promise<{ account: Account }> {
    return this.request('PATCH', `/api/accounts/${encodeURIComponent(id)}`, change);
  }

  /** Set someone's password; your own needs `currentPassword` from a browser. */
  setAccountPassword(
    id: string,
    password: string,
    currentPassword?: string,
  ): Promise<{ account: Account }> {
    return this.request('POST', `/api/accounts/${encodeURIComponent(id)}/password`, {
      password,
      ...(currentPassword !== undefined ? { currentPassword } : {}),
    });
  }

  removeAccount(id: string): Promise<{ removed: boolean }> {
    return this.request('DELETE', `/api/accounts/${encodeURIComponent(id)}`);
  }

  listAccountSessions(id: string): Promise<AccountSessionListResponse> {
    return this.request('GET', `/api/accounts/${encodeURIComponent(id)}/sessions`);
  }

  revokeAccountSession(sessionId: string): Promise<{ revoked: boolean }> {
    return this.request('DELETE', `/api/accounts/sessions/${encodeURIComponent(sessionId)}`);
  }

  signOutAccountEverywhere(id: string): Promise<{ signedOut: number }> {
    return this.request('POST', `/api/accounts/${encodeURIComponent(id)}/sign-out-all`);
  }

  /** The signed-in account behind this client; 404 for the owner's own credential. */
  getMyAccount(): Promise<{ account: Account }> {
    return this.request('GET', '/api/accounts/me');
  }

  changeMyPassword(password: string, currentPassword: string): Promise<{ account: Account }> {
    return this.request('POST', '/api/accounts/me/password', { password, currentPassword });
  }

  listMySessions(): Promise<AccountSessionListResponse> {
    return this.request('GET', '/api/accounts/me/sessions');
  }

  revokeMySession(sessionId: string): Promise<{ revoked: boolean }> {
    return this.request('DELETE', `/api/accounts/me/sessions/${encodeURIComponent(sessionId)}`);
  }
}
