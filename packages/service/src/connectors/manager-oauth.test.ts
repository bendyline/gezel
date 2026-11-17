import type { SecretStore } from '@bendyline/gezel-inference/internal/secrets/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Store } from '../fs/store.js';
import { ConnectorManager } from './manager.js';
import { exchangeLongLivedToken, parseLongLivedExchange } from './oauth.js';

/**
 * The OAuth link flow end-to-end (startOAuth → completeOAuth) against a
 * stubbed global fetch: the Meta-style long-lived exchange branch, the
 * LinkedIn-style `longLived` escape (no refresh token, no exchange — the
 * access token itself is long-lived), and regression pins proving the
 * default refresh-token contract is untouched.
 */

const EXCHANGE_URL = 'https://graph.instagram.example/access_token';
const REFRESH_URL = 'https://graph.instagram.example/refresh_access_token';

function manifest(secretShapeExtra: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1 as const,
    kind: 'connector-type' as const,
    id: 'oauth-conn',
    name: 'OAuth Conn',
    description: '',
    tags: [],
    maintainer: { name: 'x' },
    version: '1.0.0',
    releasedAt: '2026-01-01T00:00:00Z',
    driver: 'native' as const,
    source: { adapterId: 'fake-native' },
    normalize: { kind: 'native' as const },
    actions: [],
    secretShape: {
      kind: 'oauth2',
      authorizeUrl: 'https://auth.example/authorize',
      tokenUrl: 'https://tokens.example/token',
      scopes: 'basic',
      clientIdEnv: 'GEZEL_TEST_OAUTHCONN_CLIENT_ID',
      clientSecretEnv: 'GEZEL_TEST_OAUTHCONN_CLIENT_SECRET',
      ...secretShapeExtra,
    },
    availableVersions: ['1.0.0'],
  };
}

interface FakeProject {
  id: string;
  connectors?: { id: string; type: string }[];
}
type SecretKeyLike = { toolsetId: string; fieldId: string };

function harness(typeManifest: ReturnType<typeof manifest>) {
  let project: FakeProject = { id: 'p1' };
  const store = {
    getProject: async () => project,
    updateProject: async (_id: string, patch: Partial<FakeProject>) => {
      project = { ...project, ...patch };
      return project;
    },
    get historyManager() {
      return undefined;
    },
  } as unknown as Store;
  const secretMap = new Map<string, string>();
  const key = (k: SecretKeyLike) => `${k.toolsetId}:${k.fieldId}`;
  const secrets = {
    get: async (k: SecretKeyLike) => secretMap.get(key(k)) ?? null,
    set: async (k: SecretKeyLike, v: string) => {
      secretMap.set(key(k), v);
    },
    delete: async (k: SecretKeyLike) => {
      secretMap.delete(key(k));
    },
  } as unknown as SecretStore;
  const catalog = {
    get: async () => ({ manifest: typeManifest, sourceId: 'bundled' }),
  } as unknown as ConstructorParameters<typeof ConnectorManager>[0]['catalog'];
  const mgr = new ConnectorManager({ store, secrets, catalog });
  return { mgr, secretMap, getProject: () => project };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function stubFetch(
  route: (url: URL, init?: RequestInit) => Response | undefined,
): { url: string; init?: RequestInit }[] {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    calls.push({ url, ...(init ? { init } : {}) });
    const res = route(new URL(url), init);
    if (!res) throw new Error(`unexpected fetch: ${url}`);
    return res;
  });
  return calls;
}

beforeEach(() => {
  process.env.GEZEL_TEST_OAUTHCONN_CLIENT_ID = 'client-abc';
  process.env.GEZEL_TEST_OAUTHCONN_CLIENT_SECRET = 'shhh';
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.GEZEL_TEST_OAUTHCONN_CLIENT_ID;
  delete process.env.GEZEL_TEST_OAUTHCONN_CLIENT_SECRET;
});

describe('completeOAuth long-lived exchange (Meta-style, no refresh token)', () => {
  it('trades the short-lived token and persists refreshMode + refreshUrl instead of failing', async () => {
    const h = harness(
      manifest({ longLivedExchange: { exchangeUrl: EXCHANGE_URL, refreshUrl: REFRESH_URL } }),
    );
    const calls = stubFetch((url) => {
      if (url.origin + url.pathname === 'https://tokens.example/token') {
        // Meta's code exchange: an access token, NO refresh_token.
        return jsonResponse(200, { access_token: 'short-tok', expires_in: 3600 });
      }
      if (url.origin + url.pathname === EXCHANGE_URL) {
        return jsonResponse(200, { access_token: 'long-tok', expires_in: 5_184_000 });
      }
      return undefined;
    });

    const { state } = await h.mgr.startOAuth(h.getProject() as never, {
      type: 'oauth-conn',
      redirectUri: 'gezel://oauth/callback',
    });
    const bindingResult = await h.mgr.completeOAuth(h.getProject() as never, {
      state,
      code: 'code-1',
    });

    const exchange = calls.find((c) => c.url.startsWith(EXCHANGE_URL));
    expect(exchange).toBeTruthy();
    const exchangeUrl = new URL(exchange!.url);
    expect(exchangeUrl.searchParams.get('grant_type')).toBe('ig_exchange_token');
    expect(exchangeUrl.searchParams.get('client_secret')).toBe('shhh');
    expect(exchangeUrl.searchParams.get('access_token')).toBe('short-tok');

    const blob = h.secretMap.get(`connector-oauth-conn:${bindingResult.id}`);
    expect(blob).toBeTruthy();
    const cred = JSON.parse(blob!) as Record<string, unknown>;
    expect(cred.accessToken).toBe('long-tok');
    expect(cred.refreshMode).toBe('long-lived-exchange');
    expect(cred.refreshUrl).toBe(REFRESH_URL);
    expect(cred.refreshToken).toBeUndefined();
    expect(Date.parse(String(cred.expiresAt))).toBeGreaterThan(Date.now());
  });

  it('default path unchanged: no longLivedExchange still requires a refresh token', async () => {
    const h = harness(manifest());
    stubFetch((url) => {
      if (url.origin + url.pathname === 'https://tokens.example/token') {
        return jsonResponse(200, { access_token: 'short-tok', expires_in: 3600 });
      }
      return undefined;
    });

    const { state } = await h.mgr.startOAuth(h.getProject() as never, {
      type: 'oauth-conn',
      redirectUri: 'gezel://oauth/callback',
    });
    await expect(
      h.mgr.completeOAuth(h.getProject() as never, { state, code: 'code-1' }),
    ).rejects.toThrow(/no refresh token was returned/);
  });

  it('default path unchanged: with a refresh token the standard credential shape persists', async () => {
    const h = harness(manifest());
    stubFetch((url) => {
      if (url.origin + url.pathname === 'https://tokens.example/token') {
        return jsonResponse(200, {
          access_token: 'acc-tok',
          refresh_token: 'ref-tok',
          expires_in: 3600,
        });
      }
      return undefined;
    });

    const { state } = await h.mgr.startOAuth(h.getProject() as never, {
      type: 'oauth-conn',
      redirectUri: 'gezel://oauth/callback',
    });
    const bindingResult = await h.mgr.completeOAuth(h.getProject() as never, {
      state,
      code: 'code-1',
    });

    const cred = JSON.parse(h.secretMap.get(`connector-oauth-conn:${bindingResult.id}`)!) as Record<
      string,
      unknown
    >;
    expect(cred).toMatchObject({
      accessToken: 'acc-tok',
      refreshToken: 'ref-tok',
      clientId: 'client-abc',
      clientSecret: 'shhh',
    });
    expect(cred.refreshMode).toBeUndefined();
    expect(cred.refreshUrl).toBeUndefined();
  });

  it('rejects a malformed longLivedExchange shape at link START, before browser consent', async () => {
    const h = harness(
      manifest({ longLivedExchange: { exchangeUrl: 'http://insecure.example/x' } }),
    );
    await expect(
      h.mgr.startOAuth(h.getProject() as never, {
        type: 'oauth-conn',
        redirectUri: 'gezel://oauth/callback',
      }),
    ).rejects.toThrow(/exact HTTPS/);
  });
});

describe('completeOAuth longLived (LinkedIn-style: no refresh token, no exchange)', () => {
  it('persists {accessToken, expiresAt, refreshMode: none} instead of failing', async () => {
    const h = harness(manifest({ longLived: true }));
    stubFetch((url) => {
      if (url.origin + url.pathname === 'https://tokens.example/token') {
        // LinkedIn's code exchange for ordinary apps: a long-lived access
        // token, NO refresh_token, and no exchange endpoint either.
        return jsonResponse(200, { access_token: 'sixty-day-tok', expires_in: 5_184_000 });
      }
      return undefined;
    });

    const { state } = await h.mgr.startOAuth(h.getProject() as never, {
      type: 'oauth-conn',
      redirectUri: 'gezel://oauth/callback',
    });
    const bindingResult = await h.mgr.completeOAuth(h.getProject() as never, {
      state,
      code: 'code-1',
    });

    const blob = h.secretMap.get(`connector-oauth-conn:${bindingResult.id}`);
    expect(blob).toBeTruthy();
    const cred = JSON.parse(blob!) as Record<string, unknown>;
    expect(cred.accessToken).toBe('sixty-day-tok');
    expect(cred.refreshMode).toBe('none');
    expect(Date.parse(String(cred.expiresAt))).toBeGreaterThan(Date.now());
    // The none-shape carries nothing it cannot use: no refresh token, no
    // refresh URL, and no client identity to refresh with.
    expect(cred.refreshToken).toBeUndefined();
    expect(cred.refreshUrl).toBeUndefined();
    expect(cred.clientId).toBeUndefined();
    expect(cred.clientSecret).toBeUndefined();
  });

  it('a longLived provider that DOES return a refresh token keeps the standard shape', async () => {
    const h = harness(manifest({ longLived: true }));
    stubFetch((url) => {
      if (url.origin + url.pathname === 'https://tokens.example/token') {
        // Approved-partner apps do get a refresh token — the escape only
        // covers the missing-refresh-token failure, never replaces refresh.
        return jsonResponse(200, {
          access_token: 'acc-tok',
          refresh_token: 'ref-tok',
          expires_in: 3600,
        });
      }
      return undefined;
    });

    const { state } = await h.mgr.startOAuth(h.getProject() as never, {
      type: 'oauth-conn',
      redirectUri: 'gezel://oauth/callback',
    });
    const bindingResult = await h.mgr.completeOAuth(h.getProject() as never, {
      state,
      code: 'code-1',
    });

    const cred = JSON.parse(h.secretMap.get(`connector-oauth-conn:${bindingResult.id}`)!) as Record<
      string,
      unknown
    >;
    expect(cred).toMatchObject({
      accessToken: 'acc-tok',
      refreshToken: 'ref-tok',
      clientId: 'client-abc',
      clientSecret: 'shhh',
    });
    expect(cred.refreshMode).toBeUndefined();
  });
});

describe('long-lived exchange primitives', () => {
  it('parseLongLivedExchange: absent for missing, strict for partial or non-HTTPS shapes', () => {
    expect(parseLongLivedExchange(undefined)).toBeUndefined();
    expect(parseLongLivedExchange({})).toBeUndefined();
    expect(parseLongLivedExchange({ exchangeUrl: EXCHANGE_URL, refreshUrl: REFRESH_URL })).toEqual({
      exchangeUrl: EXCHANGE_URL,
      refreshUrl: REFRESH_URL,
    });
    expect(() => parseLongLivedExchange({ exchangeUrl: EXCHANGE_URL })).toThrow(/not a valid URL/);
    expect(() =>
      parseLongLivedExchange({ exchangeUrl: EXCHANGE_URL, refreshUrl: 'http://x.example/r' }),
    ).toThrow(/exact HTTPS/);
  });

  it('exchangeLongLivedToken: builds the GET, parses the token, surfaces Meta error bodies', async () => {
    const seen: string[] = [];
    const ok = await exchangeLongLivedToken({
      exchangeUrl: EXCHANGE_URL,
      accessToken: 'short-tok',
      clientSecret: 'shhh',
      fetchImpl: (async (input: string | URL) => {
        seen.push(String(input));
        return jsonResponse(200, { access_token: 'long-tok', expires_in: 5_184_000 });
      }) as typeof fetch,
    });
    expect(ok.accessToken).toBe('long-tok');
    expect(ok.refreshToken).toBeUndefined();
    const url = new URL(seen[0]!);
    expect(url.searchParams.get('grant_type')).toBe('ig_exchange_token');
    expect(url.searchParams.get('client_secret')).toBe('shhh');
    expect(url.searchParams.get('access_token')).toBe('short-tok');

    await expect(
      exchangeLongLivedToken({
        exchangeUrl: EXCHANGE_URL,
        accessToken: 'short-tok',
        fetchImpl: (async () =>
          jsonResponse(400, {
            error: { message: 'Invalid platform app', type: 'IGApiException', code: 190 },
          })) as typeof fetch,
      }),
    ).rejects.toThrow(/Invalid platform app/);

    await expect(
      exchangeLongLivedToken({
        exchangeUrl: EXCHANGE_URL,
        accessToken: 'short-tok',
        fetchImpl: (async () => jsonResponse(200, { expires_in: 60 })) as typeof fetch,
      }),
    ).rejects.toThrow(/no access token/);
  });
});

describe('the account a Google or Microsoft sign-in reaches', () => {
  const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
  const MS_TOKEN = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token';
  const google = () =>
    manifest({
      authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: GOOGLE_TOKEN,
      scopes: 'https://mail.google.com/',
      authParams: { access_type: 'offline', prompt: 'consent' },
    });
  const microsoft = () =>
    manifest({
      authorizeUrl: 'https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize',
      tokenUrl: MS_TOKEN,
      scopes: 'offline_access https://graph.microsoft.com/Mail.Read',
    });
  const idToken = (claims: Record<string, unknown>) => {
    const part = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
    return `${part({ alg: 'RS256' })}.${part({ aud: 'client-abc', ...claims })}.c2ln`;
  };
  const tokens = (tokenUrl: string, claims?: Record<string, unknown>) =>
    stubFetch((url) =>
      url.origin + url.pathname === tokenUrl
        ? jsonResponse(200, {
            access_token: 'acc-tok',
            refresh_token: 'ref-tok',
            expires_in: 3600,
            ...(claims ? { id_token: idToken(claims) } : {}),
          })
        : undefined,
    );

  it('asks for the typed address and for the token that names the account', async () => {
    const h = harness(google());
    const { authUrl } = await h.mgr.startOAuth(h.getProject() as never, {
      type: 'oauth-conn',
      redirectUri: 'http://127.0.0.1:5000/callback',
      config: { address: 'test@gmail.com' },
    });
    const q = new URL(authUrl).searchParams;
    expect(q.get('login_hint')).toBe('test@gmail.com');
    expect(q.get('prompt')).toBe('consent');
    expect(q.get('scope')).toBe('https://mail.google.com/ openid email');
  });

  it('with no address to go on, makes the person pick an account', async () => {
    const g = harness(google());
    const gq = new URL(
      (
        await g.mgr.startOAuth(g.getProject() as never, {
          type: 'oauth-conn',
          redirectUri: 'http://127.0.0.1:5000/callback',
        })
      ).authUrl,
    ).searchParams;
    expect(gq.get('prompt')).toBe('consent select_account');
    expect(gq.get('login_hint')).toBeNull();

    const m = harness(microsoft());
    const mq = new URL(
      (
        await m.mgr.startOAuth(m.getProject() as never, {
          type: 'oauth-conn',
          redirectUri: 'http://127.0.0.1:5000/callback',
        })
      ).authUrl,
    ).searchParams;
    expect(mq.get('prompt')).toBe('select_account');
    expect(mq.get('scope')).toBe(
      'offline_access https://graph.microsoft.com/Mail.Read openid profile email',
    );
  });

  it('refuses another account and keeps nothing', async () => {
    const h = harness(microsoft());
    tokens(MS_TOKEN, { preferred_username: 'me@live.com', email: 'me@live.com' });
    const { state } = await h.mgr.startOAuth(h.getProject() as never, {
      type: 'oauth-conn',
      redirectUri: 'http://127.0.0.1:5000/callback',
      config: { address: 'test@outlook.com' },
    });
    await expect(
      h.mgr.completeOAuth(h.getProject() as never, { state, code: 'code-1' }),
    ).rejects.toThrow(
      'You signed in to Microsoft as me@live.com, but this connection is for test@outlook.com.',
    );
    expect(h.secretMap.size).toBe(0);
    expect(h.getProject().connectors ?? []).toEqual([]);
    // The link is spent: retrying the same code cannot slip past the check.
    await expect(
      h.mgr.completeOAuth(h.getProject() as never, { state, code: 'code-1' }),
    ).rejects.toThrow(/state not found/);
  });

  it('binds the expected account and records it', async () => {
    const h = harness(google());
    tokens(GOOGLE_TOKEN, { email: 'test.account@gmail.com' });
    const { state } = await h.mgr.startOAuth(h.getProject() as never, {
      type: 'oauth-conn',
      redirectUri: 'http://127.0.0.1:5000/callback',
      config: { address: 'testaccount@gmail.com' },
    });
    const binding = await h.mgr.completeOAuth(h.getProject() as never, { state, code: 'code-1' });
    expect(binding.account).toBe('test.account@gmail.com');
    expect(h.secretMap.size).toBe(1);
  });

  it('a re-link must reach the account the connection already has', async () => {
    const h = harness(google());
    tokens(GOOGLE_TOKEN, { email: 'first@gmail.com' });
    const first = await h.mgr.startOAuth(h.getProject() as never, {
      type: 'oauth-conn',
      redirectUri: 'http://127.0.0.1:5000/callback',
    });
    const bound = await h.mgr.completeOAuth(h.getProject() as never, {
      state: first.state,
      code: 'code-1',
    });
    expect(bound.account).toBe('first@gmail.com');

    vi.unstubAllGlobals();
    tokens(GOOGLE_TOKEN, { email: 'second@gmail.com' });
    const relink = await h.mgr.startOAuth(h.getProject() as never, {
      type: 'oauth-conn',
      redirectUri: 'http://127.0.0.1:5000/callback',
      relinkBindingId: bound.id,
    });
    expect(new URL(relink.authUrl).searchParams.get('login_hint')).toBe('first@gmail.com');
    await expect(
      h.mgr.completeOAuth(h.getProject() as never, { state: relink.state, code: 'code-2' }),
    ).rejects.toThrow(/Nothing was changed/);
    const kept = JSON.parse(h.secretMap.get(`connector-oauth-conn:${bound.id}`)!) as {
      refreshToken: string;
    };
    expect(kept.refreshToken).toBe('ref-tok');
  });

  it('proceeds on the hint alone when the provider names no account', async () => {
    const h = harness(google());
    tokens(GOOGLE_TOKEN);
    const { state } = await h.mgr.startOAuth(h.getProject() as never, {
      type: 'oauth-conn',
      redirectUri: 'http://127.0.0.1:5000/callback',
      config: { address: 'test@gmail.com' },
    });
    const binding = await h.mgr.completeOAuth(h.getProject() as never, { state, code: 'code-1' });
    expect(binding.account).toBeUndefined();
  });

  it('leaves other providers exactly as they were', async () => {
    const h = harness(manifest());
    const { authUrl } = await h.mgr.startOAuth(h.getProject() as never, {
      type: 'oauth-conn',
      redirectUri: 'http://127.0.0.1:5000/callback',
      config: { address: 'test@example.com' },
    });
    const q = new URL(authUrl).searchParams;
    expect(q.get('scope')).toBe('basic');
    expect(q.get('login_hint')).toBeNull();
    expect(q.get('prompt')).toBeNull();
  });
});
