import { describe, expect, it } from 'vitest';
import { AccountsClient } from './accounts.js';

type ClientJsonRequest = ConstructorParameters<typeof AccountsClient>[0];

interface Call {
  method: string;
  path: string;
  body?: unknown;
}

function recordingClient(): { accounts: AccountsClient; calls: Call[] } {
  const calls: Call[] = [];
  const request: ClientJsonRequest = async <T>(method: string, path: string, body?: unknown) => {
    calls.push(body === undefined ? { method, path } : { method, path, body });
    return {} as T;
  };
  return { accounts: new AccountsClient(request), calls };
}

describe('AccountsClient', () => {
  it('signs in on the /v1 sign-in surface, not the owner API', async () => {
    const { accounts, calls } = recordingClient();
    await accounts.getSignInState();
    await accounts.signIn('ada', 'pw');
    await accounts.setUpFirstAccount('CODE-1', 'ada', 'pw');
    await accounts.signOut();
    expect(calls).toEqual([
      { method: 'GET', path: '/v1/apps/signin/state' },
      { method: 'POST', path: '/v1/apps/signin', body: { name: 'ada', password: 'pw' } },
      {
        method: 'POST',
        path: '/v1/apps/signin/setup',
        body: { code: 'CODE-1', name: 'ada', password: 'pw' },
      },
      { method: 'POST', path: '/v1/apps/signin/signout' },
    ]);
  });

  it('manages accounts by id with every id escaped into one path segment', async () => {
    const { accounts, calls } = recordingClient();
    const id = 'a/b c';
    await accounts.createSetupLink();
    await accounts.listAccounts();
    await accounts.createAccount('ada', 'pw');
    await accounts.updateAccount(id, { disabled: true });
    await accounts.removeAccount(id);
    await accounts.listAccountSessions(id);
    await accounts.revokeAccountSession('s/1');
    await accounts.signOutAccountEverywhere(id);
    expect(calls).toEqual([
      { method: 'POST', path: '/api/accounts/setup-link' },
      { method: 'GET', path: '/api/accounts' },
      { method: 'POST', path: '/api/accounts', body: { name: 'ada', password: 'pw' } },
      { method: 'PATCH', path: '/api/accounts/a%2Fb%20c', body: { disabled: true } },
      { method: 'DELETE', path: '/api/accounts/a%2Fb%20c' },
      { method: 'GET', path: '/api/accounts/a%2Fb%20c/sessions' },
      { method: 'DELETE', path: '/api/accounts/sessions/s%2F1' },
      { method: 'POST', path: '/api/accounts/a%2Fb%20c/sign-out-all' },
    ]);
  });

  it('sends currentPassword only when the caller has one', async () => {
    const { accounts, calls } = recordingClient();
    await accounts.setAccountPassword('acct-1', 'new');
    await accounts.setAccountPassword('acct-1', 'new', 'old');
    expect(calls.map((call) => call.body)).toEqual([
      { password: 'new' },
      { password: 'new', currentPassword: 'old' },
    ]);
  });

  it("reaches the signed-in account's own record under /me", async () => {
    const { accounts, calls } = recordingClient();
    await accounts.getMyAccount();
    await accounts.changeMyPassword('new', 'old');
    await accounts.listMySessions();
    await accounts.revokeMySession('s/1');
    expect(calls).toEqual([
      { method: 'GET', path: '/api/accounts/me' },
      {
        method: 'POST',
        path: '/api/accounts/me/password',
        body: { password: 'new', currentPassword: 'old' },
      },
      { method: 'GET', path: '/api/accounts/me/sessions' },
      { method: 'DELETE', path: '/api/accounts/me/sessions/s%2F1' },
    ]);
  });
});
