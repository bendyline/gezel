import { afterEach, describe, expect, it } from 'vitest';
import { buildAuthorizeUrl, resolveOAuthClientFromEnv, validateOAuthEndpoints } from './oauth.js';

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
