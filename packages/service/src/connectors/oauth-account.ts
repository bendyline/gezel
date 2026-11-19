/**
 * Which account an OAuth sign-in reached, for the providers that can say:
 * Google and Microsoft. A browser already signed in to another account will
 * hand that one over without asking, so the sign-in names the account the
 * person typed (or makes them pick one), and the link is refused when the
 * account that signed in is not that one. Before this, a connection made for
 * a test mailbox copied the person's own mailbox instead.
 *
 * The account comes from the OpenID Connect ID token, which the token
 * endpoint returns when `openid` is asked for. It arrives directly from that
 * endpoint over TLS, which OpenID Connect Core (3.1.3.7) accepts in place of
 * checking its signature; the audience is still checked.
 */

export type AccountProvider = 'google' | 'microsoft';

const PROVIDER_BY_HOST: Record<string, AccountProvider> = {
  'accounts.google.com': 'google',
  'login.microsoftonline.com': 'microsoft',
};

/** Scopes that make the token endpoint say which account signed in. */
const ACCOUNT_SCOPES: Record<AccountProvider, string[]> = {
  google: ['openid', 'email'],
  // `profile` carries `preferred_username`, the name a Microsoft account signs in with.
  microsoft: ['openid', 'profile', 'email'],
};

const PROVIDER_NAMES: Record<AccountProvider, string> = {
  google: 'Google',
  microsoft: 'Microsoft',
};

/** The account-aware provider behind an authorize URL, or null. */
export function accountProviderFor(authorizeUrl: string): AccountProvider | null {
  try {
    return PROVIDER_BY_HOST[new URL(authorizeUrl).hostname] ?? null;
  } catch {
    return null;
  }
}

/** The type's scopes plus the ones that identify the account, without repeats. */
export function withAccountScopes(scopes: string[], provider: AccountProvider): string[] {
  return [...new Set([...scopes, ...ACCOUNT_SCOPES[provider]])];
}

/**
 * The connection's own scopes that a sign-in did not grant. Google lets a
 * person untick a permission on its consent screen and still completes the
 * sign-in, so without this check the connection is saved and then fails its
 * first sync with "insufficient authentication scopes". Only Google is
 * checked: Microsoft's consent is all or nothing, and the scopes it reports
 * back do not always read the way they were asked for. When the token
 * response names no scopes there is nothing to compare, so nothing is missing.
 */
export function missingGrantedScopes(
  provider: AccountProvider,
  requested: string[],
  granted: string | undefined,
): string[] {
  if (provider !== 'google' || granted === undefined) return [];
  const have = new Set(granted.split(' ').filter(Boolean));
  const signIn = new Set(ACCOUNT_SCOPES.google);
  return requested.filter((scope) => !signIn.has(scope) && !have.has(scope));
}

/**
 * The authorize parameters that keep the browser from choosing an account on
 * its own: the expected account as `login_hint` when there is one, otherwise
 * the provider's account picker. Google takes several `prompt` values at once
 * (its types already ask for `consent`); Microsoft takes one, so a type's own
 * `prompt` is left alone there.
 */
export function accountAuthParams(
  provider: AccountProvider,
  authParams: Record<string, string> | undefined,
  expectedAccount: string | undefined,
): { authParams: Record<string, string>; loginHint?: string } {
  const params = { ...(authParams ?? {}) };
  if (expectedAccount) return { authParams: params, loginHint: expectedAccount };
  const prompt = params.prompt?.trim();
  if (provider === 'google') {
    const values = new Set((prompt ?? '').split(/\s+/).filter(Boolean));
    values.add('select_account');
    params.prompt = [...values].join(' ');
  } else if (!prompt) {
    params.prompt = 'select_account';
  }
  return { authParams: params };
}

/** The address a connection is for, when its settings name one. */
export function expectedAccountFrom(
  config: Record<string, unknown> | undefined,
): string | undefined {
  const address = config?.address;
  return typeof address === 'string' && address.includes('@') ? address.trim() : undefined;
}

function decodeSegment(segment: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * The addresses an ID token names for the signed-in account (`email`, then
 * `preferred_username`), lowercased. Null when there is no token, it does not
 * parse, or it was issued to another client.
 */
export function signedInAccounts(idToken: string | undefined, clientId: string): string[] | null {
  const payload = idToken?.split('.')[1];
  if (!payload) return null;
  const claims = decodeSegment(payload);
  if (!claims) return null;
  const aud = claims.aud;
  const audiences = Array.isArray(aud) ? aud : [aud];
  if (!audiences.includes(clientId)) return null;
  const names = [claims.email, claims.preferred_username]
    .filter((v): v is string => typeof v === 'string' && v.includes('@'))
    .map((v) => v.trim().toLowerCase());
  return names.length > 0 ? [...new Set(names)] : null;
}

/** Gmail ignores dots and anything after `+`, and googlemail.com is gmail.com. */
function canonicalAddress(address: string): string {
  const lower = address.trim().toLowerCase();
  const at = lower.lastIndexOf('@');
  if (at < 0) return lower;
  let local = lower.slice(0, at);
  let domain = lower.slice(at + 1);
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.split('+')[0]!.replaceAll('.', '');
  return `${local}@${domain}`;
}

/** Whether the account that signed in is the one the connection is for. */
export function isExpectedAccount(signedIn: string[], expected: string): boolean {
  const want = canonicalAddress(expected);
  return signedIn.some((a) => canonicalAddress(a) === want);
}

/** A sign-in that reached a different account than the connection is for. */
export class AccountMismatchError extends Error {
  constructor(
    readonly provider: AccountProvider,
    readonly signedIn: string,
    readonly expected: string,
    relink: boolean,
  ) {
    const name = PROVIDER_NAMES[provider];
    super(
      relink
        ? `You signed in to ${name} as ${signedIn}, but this connection is for ${expected}. Nothing was changed. Sign in again as ${expected}, or add a new connection for ${signedIn}.`
        : `You signed in to ${name} as ${signedIn}, but this connection is for ${expected}. Nothing was saved. Connect again and sign in as ${expected}, or enter ${signedIn} as the address.`,
    );
    this.name = 'AccountMismatchError';
  }
}
