import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildAuthUrl,
  createPkce,
  defaultFoldersFor,
  isExpired,
  microsoftTenant,
  providerEndpoints,
  resolveOAuthClient,
} from './oauth.js';

describe('PKCE', () => {
  it('produces a verifier and its S256 challenge', () => {
    const { verifier, challenge } = createPkce();
    expect(verifier.length).toBeGreaterThanOrEqual(40);
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
  });
});

describe('buildAuthUrl', () => {
  it('builds a Google auth URL with offline access + PKCE', () => {
    const url = new URL(
      buildAuthUrl({
        provider: 'gmail',
        clientId: 'cid',
        redirectUri: 'http://127.0.0.1:7777/cb',
        state: 'st',
        challenge: 'ch',
      }),
    );
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe('cid');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('scope')).toContain('mail.google.com');
  });

  it('builds a Microsoft auth URL with the tenant + Graph scopes', () => {
    const url = new URL(
      buildAuthUrl({
        provider: 'microsoft365',
        clientId: 'cid',
        redirectUri: 'http://127.0.0.1:7777/cb',
        state: 'st',
        challenge: 'ch',
        tenant: 'organizations',
      }),
    );
    expect(url.pathname).toContain('/organizations/oauth2/v2.0/authorize');
    expect(url.searchParams.get('scope')).toContain('Mail.Send');
    expect(url.searchParams.get('access_type')).toBeNull(); // Google-only
  });
});

describe('endpoint + tenant helpers', () => {
  it('maps default tenants', () => {
    expect(microsoftTenant('microsoft365')).toBe('organizations');
    expect(microsoftTenant('outlook')).toBe('consumers');
  });
  it('parameterizes the Microsoft token endpoint by tenant', () => {
    expect(providerEndpoints('outlook', 'consumers').tokenEndpoint).toContain('/consumers/');
    expect(providerEndpoints('gmail').tokenEndpoint).toBe('https://oauth2.googleapis.com/token');
  });
  it('picks provider-appropriate default folders', () => {
    expect(defaultFoldersFor('microsoft365')).toEqual(['inbox']);
    expect(defaultFoldersFor('gmail')).toEqual(['INBOX']);
    expect(defaultFoldersFor('imap')).toEqual(['INBOX']);
  });
});

describe('isExpired', () => {
  it('treats past / empty as expired and future as live', () => {
    expect(isExpired({ expiresAt: new Date(Date.now() - 1000).toISOString() })).toBe(true);
    expect(isExpired({ expiresAt: '' })).toBe(true);
    expect(isExpired({ expiresAt: new Date(Date.now() + 60_000).toISOString() })).toBe(false);
  });
});

describe('resolveOAuthClient', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env.GEZEL_GOOGLE_CLIENT_ID = saved.GEZEL_GOOGLE_CLIENT_ID;
    process.env.GEZEL_GOOGLE_CLIENT_SECRET = saved.GEZEL_GOOGLE_CLIENT_SECRET;
    process.env.GEZEL_MICROSOFT_CLIENT_ID = saved.GEZEL_MICROSOFT_CLIENT_ID;
  });

  it('throws a configuration error when the client id is unset', () => {
    process.env.GEZEL_GOOGLE_CLIENT_ID = undefined;
    delete process.env.GEZEL_GOOGLE_CLIENT_ID;
    expect(() => resolveOAuthClient('gmail')).toThrow(/not configured/);
  });

  it('resolves google id + secret from the env', () => {
    process.env.GEZEL_GOOGLE_CLIENT_ID = 'gid';
    process.env.GEZEL_GOOGLE_CLIENT_SECRET = 'gsecret';
    expect(resolveOAuthClient('gmail')).toEqual({ clientId: 'gid', clientSecret: 'gsecret' });
  });

  it('resolves a microsoft public client (no secret)', () => {
    process.env.GEZEL_MICROSOFT_CLIENT_ID = 'mid';
    expect(resolveOAuthClient('outlook')).toEqual({ clientId: 'mid' });
  });
});
