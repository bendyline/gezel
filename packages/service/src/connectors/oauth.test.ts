import { afterEach, describe, expect, it } from 'vitest';
import {
  buildAuthorizeUrl,
  clientAuthFor,
  exchangeAuthCode,
  oauthClientSecretKey,
  refreshToken,
  resolveOAuthClient,
  resolveOAuthClientFromEnv,
  validateOAuthEndpoints,
} from './oauth.js';

afterEach(() => {
  delete process.env.GEZEL_TEST_OAUTH_CLIENT;
});

describe('OAuth endpoint provenance guards', () => {
  it('requires exact HTTPS credential destinations', () => {
    expect(() =>
      validateOAuthEndpoints({
        authEndpoint: 'http://accounts.example/authorize',
        tokenEndpoint: 'https://tokens.example/token',
        scopes: [],
      }),
    ).toThrow(/exact HTTPS/);
    expect(() =>
      validateOAuthEndpoints({
        authEndpoint: 'https://user:pass@accounts.example/authorize',
        tokenEndpoint: 'https://tokens.example/token',
        scopes: [],
      }),
    ).toThrow(/exact HTTPS/);
  });

  it('builds a PKCE URL only after endpoint validation', () => {
    const url = buildAuthorizeUrl({
      endpoints: {
        authEndpoint: 'https://accounts.example/authorize',
        tokenEndpoint: 'https://tokens.example/token',
        scopes: ['read'],
      },
      clientId: 'client',
      redirectUri: 'gezel://oauth/callback',
      state: 'state',
      challenge: 'challenge',
    });
    expect(url).toContain('code_challenge=challenge');
  });

  it('does not let manifests select arbitrary process environment variables', () => {
    process.env.GEZEL_TEST_OAUTH_CLIENT = 'client-id';
    expect(resolveOAuthClientFromEnv('GEZEL_TEST_OAUTH_CLIENT').clientId).toBe('client-id');
    expect(() => resolveOAuthClientFromEnv('PATH')).toThrow(/invalid client environment/);
  });
});

describe('resolveOAuthClient (bring-your-own app ladder)', () => {
  const key = 'GEZEL_LADDER_TEST_CLIENT';
  const secretKey = 'GEZEL_LADDER_TEST_SECRET';
  afterEach(() => {
    delete process.env[key];
    delete process.env[secretKey];
  });

  it('env vars win over a configured client and never read the config', async () => {
    process.env[key] = 'env-id';
    process.env[secretKey] = 'env-secret';
    let configReads = 0;
    const client = await resolveOAuthClient({
      clientIdEnv: key,
      clientSecretEnv: secretKey,
      getConfiguredClients: async () => {
        configReads += 1;
        return { [key]: { clientId: 'config-id' } };
      },
      getSecret: async () => 'store-secret',
    });
    expect(client).toEqual({ clientId: 'env-id', clientSecret: 'env-secret' });
    expect(configReads).toBe(0);
  });

  it('falls back to the configured client + SecretStore secret', async () => {
    const asked: unknown[] = [];
    const client = await resolveOAuthClient({
      clientIdEnv: key,
      clientSecretEnv: secretKey,
      getConfiguredClients: async () => ({ [key]: { clientId: 'config-id' } }),
      getSecret: async (k) => {
        asked.push(k);
        return 'store-secret';
      },
    });
    expect(client).toEqual({ clientId: 'config-id', clientSecret: 'store-secret' });
    expect(asked).toEqual([oauthClientSecretKey(key)]);
  });

  it('a configured public client works without any secret (PKCE)', async () => {
    const client = await resolveOAuthClient({
      clientIdEnv: key,
      getConfiguredClients: async () => ({ [key]: { clientId: 'config-id' } }),
      getSecret: async () => null,
    });
    expect(client).toEqual({ clientId: 'config-id' });
  });

  it('a broken config read degrades to the not-configured error, never a crash', async () => {
    await expect(
      resolveOAuthClient({
        clientIdEnv: key,
        getConfiguredClients: async () => {
          throw new Error('store offline');
        },
        getSecret: async () => null,
      }),
    ).rejects.toThrow(/OAuth is not configured/);
  });

  it('names both remedies when nothing is configured', async () => {
    await expect(
      resolveOAuthClient({
        clientIdEnv: key,
        clientSecretEnv: secretKey,
        getSecret: async () => null,
      }),
    ).rejects.toThrow(/Settings.*or set GEZEL_LADDER_TEST_CLIENT.*GEZEL_LADDER_TEST_SECRET/s);
  });

  it("uses Gezel's own app last, with its secret, when nothing else is set", async () => {
    const client = await resolveOAuthClient({
      clientIdEnv: key,
      getConfiguredClients: async () => undefined,
      getSecret: async () => null,
      builtin: { clientId: 'gezel-id', clientSecret: 'gezel-secret' },
    });
    expect(client).toEqual({ clientId: 'gezel-id', clientSecret: 'gezel-secret' });
  });

  it("a saved app and an env var both win over Gezel's own", async () => {
    const builtin = { clientId: 'gezel-id' };
    const saved = await resolveOAuthClient({
      clientIdEnv: key,
      getConfiguredClients: async () => ({ [key]: { clientId: 'config-id' } }),
      getSecret: async () => null,
      builtin,
    });
    expect(saved).toEqual({ clientId: 'config-id' });
    process.env[key] = 'env-id';
    const fromEnv = await resolveOAuthClient({
      clientIdEnv: key,
      getSecret: async () => null,
      builtin,
    });
    expect(fromEnv).toEqual({ clientId: 'env-id' });
  });

  it("says Gezel's own app can only read when it is too narrow for the connection", async () => {
    await expect(
      resolveOAuthClient({
        clientIdEnv: key,
        getSecret: async () => null,
        builtin: null,
        builtinTooNarrow: true,
      }),
    ).rejects.toThrow(
      /^OAuth is not configured for this connector — Gezel's own app can only read, and this connection asks for more\. Add your own app/,
    );
  });

  it('still refuses arbitrary env names', async () => {
    await expect(
      resolveOAuthClient({ clientIdEnv: 'PATH', getSecret: async () => null }),
    ).rejects.toThrow(/invalid client environment/);
  });
});

describe('token endpoint client authentication', () => {
  function capture(): {
    fetchImpl: typeof fetch;
    seen: { headers: Headers; form: URLSearchParams }[];
  } {
    const seen: { headers: Headers; form: URLSearchParams }[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      seen.push({
        headers: new Headers(init?.headers),
        form: new URLSearchParams(String(init?.body ?? '')),
      });
      return new Response(JSON.stringify({ access_token: 'a', expires_in: 60 }), {
        headers: { 'content-type': 'application/json' },
      });
    };
    return { fetchImpl, seen };
  }
  const base = { authEndpoint: 'https://auth.example/a', scopes: [] };

  it('sends a confidential client in the form by default', async () => {
    const { fetchImpl, seen } = capture();
    await refreshToken({
      endpoints: { ...base, tokenEndpoint: 'https://tokens.example/t' },
      clientId: 'id',
      clientSecret: 'secret',
      refreshToken: 'r',
      fetchImpl,
    });
    expect(seen[0]!.headers.has('authorization')).toBe(false);
    expect(seen[0]!.form.get('client_secret')).toBe('secret');
  });

  it('uses HTTP Basic, form-encoding the pair, when the type or host asks for it', async () => {
    const { fetchImpl, seen } = capture();
    await exchangeAuthCode({
      endpoints: { ...base, tokenEndpoint: 'https://tokens.example/t', clientAuth: 'basic' },
      clientId: 'my id',
      clientSecret: 's:cret',
      code: 'c',
      codeVerifier: 'v',
      redirectUri: 'http://127.0.0.1/cb',
      fetchImpl,
    });
    expect(seen[0]!.headers.get('authorization')).toBe(
      `Basic ${Buffer.from('my%20id:s%3Acret').toString('base64')}`,
    );
    expect(seen[0]!.form.has('client_secret')).toBe(false);
    expect(seen[0]!.form.has('client_id')).toBe(false);
    expect(clientAuthFor({ tokenEndpoint: 'https://api.x.com/2/oauth2/token' })).toBe('basic');
    expect(clientAuthFor({ tokenEndpoint: 'https://oauth2.googleapis.com/token' })).toBe('post');
  });

  it('a public client keeps its id in the form even where Basic is the rule', async () => {
    const { fetchImpl, seen } = capture();
    await refreshToken({
      endpoints: { ...base, tokenEndpoint: 'https://api.x.com/2/oauth2/token' },
      clientId: 'public-id',
      refreshToken: 'r',
      fetchImpl,
    });
    expect(seen[0]!.headers.has('authorization')).toBe(false);
    expect(seen[0]!.form.get('client_id')).toBe('public-id');
  });
});
