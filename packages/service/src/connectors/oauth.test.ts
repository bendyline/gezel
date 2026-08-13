import { afterEach, describe, expect, it } from 'vitest';
import {
  buildAuthorizeUrl,
  oauthClientSecretKey,
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

  it('still refuses arbitrary env names', async () => {
    await expect(
      resolveOAuthClient({ clientIdEnv: 'PATH', getSecret: async () => null }),
    ).rejects.toThrow(/invalid client environment/);
  });
});
