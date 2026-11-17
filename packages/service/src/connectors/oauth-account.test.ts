import { describe, expect, it } from 'vitest';
import {
  AccountMismatchError,
  accountAuthParams,
  accountProviderFor,
  expectedAccountFrom,
  isExpectedAccount,
  signedInAccounts,
  withAccountScopes,
} from './oauth-account.js';

function idToken(claims: Record<string, unknown>): string {
  const part = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  return `${part({ alg: 'RS256', typ: 'JWT' })}.${part(claims)}.c2lnbmF0dXJl`;
}

describe('which providers say which account signed in', () => {
  it('knows Google and Microsoft by their sign-in host, and nothing else', () => {
    expect(accountProviderFor('https://accounts.google.com/o/oauth2/v2/auth')).toBe('google');
    expect(
      accountProviderFor('https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize'),
    ).toBe('microsoft');
    expect(accountProviderFor('https://x.com/i/oauth2/authorize')).toBeNull();
    expect(accountProviderFor('not a url')).toBeNull();
  });

  it('adds the ID-token scopes once', () => {
    expect(withAccountScopes(['https://mail.google.com/', 'openid'], 'google')).toEqual([
      'https://mail.google.com/',
      'openid',
      'email',
    ]);
    expect(withAccountScopes(['offline_access'], 'microsoft')).toEqual([
      'offline_access',
      'openid',
      'profile',
      'email',
    ]);
  });
});

describe('keeping the browser from choosing the account', () => {
  it('names the expected account and leaves the type its prompt', () => {
    expect(
      accountAuthParams('google', { access_type: 'offline', prompt: 'consent' }, 'a@gmail.com'),
    ).toEqual({
      authParams: { access_type: 'offline', prompt: 'consent' },
      loginHint: 'a@gmail.com',
    });
  });

  it('without one, makes the person pick: Google adds to its prompt, Microsoft sets one', () => {
    expect(
      accountAuthParams('google', { access_type: 'offline', prompt: 'consent' }, undefined),
    ).toEqual({ authParams: { access_type: 'offline', prompt: 'consent select_account' } });
    expect(accountAuthParams('microsoft', undefined, undefined)).toEqual({
      authParams: { prompt: 'select_account' },
    });
    expect(accountAuthParams('microsoft', { prompt: 'consent' }, undefined)).toEqual({
      authParams: { prompt: 'consent' },
    });
  });

  it('reads the expected account from an address setting only', () => {
    expect(expectedAccountFrom({ address: ' test@outlook.com ' })).toBe('test@outlook.com');
    expect(expectedAccountFrom({ address: 'not-an-address' })).toBeUndefined();
    expect(expectedAccountFrom({ calendars: ['primary'] })).toBeUndefined();
    expect(expectedAccountFrom(undefined)).toBeUndefined();
  });
});

describe('the account that signed in', () => {
  it('reads email and preferred_username from a token issued to this client', () => {
    expect(
      signedInAccounts(
        idToken({ aud: 'client-1', email: 'A@Live.com', preferred_username: 'a@live.com' }),
        'client-1',
      ),
    ).toEqual(['a@live.com']);
    expect(
      signedInAccounts(idToken({ aud: ['other', 'client-1'], email: 'b@x.test' }), 'client-1'),
    ).toEqual(['b@x.test']);
  });

  it('trusts nothing issued to another client, unparseable, or without an address', () => {
    expect(signedInAccounts(idToken({ aud: 'other', email: 'a@x.test' }), 'client-1')).toBeNull();
    expect(signedInAccounts('garbage', 'client-1')).toBeNull();
    expect(signedInAccounts(undefined, 'client-1')).toBeNull();
    expect(signedInAccounts(idToken({ aud: 'client-1', sub: '123' }), 'client-1')).toBeNull();
  });

  it('matches Gmail the way Gmail delivers, and every other address exactly', () => {
    expect(isExpectedAccount(['bendy.line.test@gmail.com'], 'BendyLineTest@googlemail.com')).toBe(
      true,
    );
    expect(isExpectedAccount(['bendylinetest@gmail.com'], 'bendylinetest+ci@gmail.com')).toBe(true);
    expect(isExpectedAccount(['ammerlaan@live.com'], 'bendylinetest@outlook.com')).toBe(false);
    expect(isExpectedAccount(['first.last@example.com'], 'firstlast@example.com')).toBe(false);
    expect(isExpectedAccount(['x@other.test', 'Test@Outlook.com'], 'test@outlook.com')).toBe(true);
  });

  it('says plainly what happened and what to do', () => {
    const fresh = new AccountMismatchError('microsoft', 'me@live.com', 'test@outlook.com', false);
    expect(fresh.message).toBe(
      'You signed in to Microsoft as me@live.com, but this connection is for test@outlook.com. Nothing was saved. Connect again and sign in as test@outlook.com, or enter me@live.com as the address.',
    );
    expect(new AccountMismatchError('google', 'b@gmail.com', 'a@gmail.com', true).message).toMatch(
      /Nothing was changed\. Sign in again as a@gmail\.com/,
    );
  });
});
