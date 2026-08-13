import { describe, expect, it } from 'vitest';
import {
  fixedRedirectUri,
  isOAuthNotConfiguredError,
  parseOAuthAppRequirement,
} from './oauth-app-setup.js';

describe('parseOAuthAppRequirement', () => {
  const xShape = {
    kind: 'oauth2',
    authorizeUrl: 'https://x.com/i/oauth2/authorize',
    tokenUrl: 'https://api.x.com/2/oauth2/token',
    scopes: 'tweet.read users.read offline.access',
    clientIdEnv: 'GEZEL_X_CLIENT_ID',
    clientSecretEnv: 'GEZEL_X_CLIENT_SECRET',
    clientSetup: {
      providerLabel: 'X (Twitter)',
      docsUrl: 'https://developer.x.com/en/portal/dashboard',
      secretRequired: false,
      appTypeNote: 'Create a free developer app.',
      redirectPort: 6241,
      redirectNote: 'X matches callback URLs exactly.',
    },
  };

  it('reads a full clientSetup block', () => {
    const req = parseOAuthAppRequirement('X Posts', xShape);
    expect(req).toEqual({
      clientKey: 'GEZEL_X_CLIENT_ID',
      hasSecretField: true,
      secretRequired: false,
      providerLabel: 'X (Twitter)',
      docsUrl: 'https://developer.x.com/en/portal/dashboard',
      appTypeNote: 'Create a free developer app.',
      redirectPort: 6241,
      redirectNote: 'X matches callback URLs exactly.',
    });
  });

  it('falls back to the type name and generic guidance without clientSetup', () => {
    const req = parseOAuthAppRequirement('Gmail', {
      kind: 'oauth2',
      clientIdEnv: 'GEZEL_GOOGLE_CLIENT_ID',
      clientSecretEnv: 'GEZEL_GOOGLE_CLIENT_SECRET',
    });
    expect(req).toEqual({
      clientKey: 'GEZEL_GOOGLE_CLIENT_ID',
      hasSecretField: true,
      secretRequired: false,
      providerLabel: 'Gmail',
    });
  });

  it('treats secretRequired as meaningful only when a secret env is declared', () => {
    const req = parseOAuthAppRequirement('Thing', {
      kind: 'oauth2',
      clientIdEnv: 'GEZEL_THING_CLIENT_ID',
      clientSetup: { secretRequired: true },
    });
    expect(req?.hasSecretField).toBe(false);
    expect(req?.secretRequired).toBe(false);
  });

  it('marks the secret required when declared and demanded', () => {
    const req = parseOAuthAppRequirement('Instagram', {
      kind: 'oauth2',
      clientIdEnv: 'GEZEL_INSTAGRAM_CLIENT_ID',
      clientSecretEnv: 'GEZEL_INSTAGRAM_CLIENT_SECRET',
      clientSetup: { secretRequired: true },
    });
    expect(req?.hasSecretField).toBe(true);
    expect(req?.secretRequired).toBe(true);
  });

  it('drops out-of-range, fractional, and non-numeric redirect ports', () => {
    for (const redirectPort of [80, 70_000, 6241.5, '6241']) {
      const req = parseOAuthAppRequirement('T', {
        kind: 'oauth2',
        clientIdEnv: 'GEZEL_T_CLIENT_ID',
        clientSetup: { redirectPort },
      });
      expect(req?.redirectPort).toBeUndefined();
    }
  });

  it('reads setup steps, trimming and dropping junk entries, capped at 8', () => {
    const req = parseOAuthAppRequirement('X Posts', {
      ...xShape,
      clientSetup: {
        ...xShape.clientSetup,
        steps: [
          '  Create the app.  ',
          '',
          42,
          'Register the callback URI.',
          ...Array.from({ length: 10 }, (_, i) => `Filler step ${i + 1}.`),
        ],
      },
    });
    expect(req?.steps).toHaveLength(8);
    expect(req?.steps?.[0]).toBe('Create the app.');
    expect(req?.steps?.[1]).toBe('Register the callback URI.');
  });

  it('omits steps entirely when the manifest declares none', () => {
    expect(parseOAuthAppRequirement('X Posts', xShape)?.steps).toBeUndefined();
  });

  it('drops non-https docs URLs', () => {
    const req = parseOAuthAppRequirement('T', {
      kind: 'oauth2',
      clientIdEnv: 'GEZEL_T_CLIENT_ID',
      clientSetup: { docsUrl: 'http://example.com' },
    });
    expect(req?.docsUrl).toBeUndefined();
  });

  it('returns null for non-oauth2 shapes and keys the route would reject', () => {
    expect(parseOAuthAppRequirement('T', { kind: 'api-key' })).toBeNull();
    expect(parseOAuthAppRequirement('T', undefined)).toBeNull();
    expect(parseOAuthAppRequirement('T', { kind: 'oauth2' })).toBeNull();
    expect(
      parseOAuthAppRequirement('T', { kind: 'oauth2', clientIdEnv: 'X_CLIENT_ID' }),
    ).toBeNull();
    expect(
      parseOAuthAppRequirement('T', { kind: 'oauth2', clientIdEnv: 'GEZEL_lowercase' }),
    ).toBeNull();
  });
});

describe('fixedRedirectUri', () => {
  it('matches the shell listener character-for-character', () => {
    expect(fixedRedirectUri(6241)).toBe('http://127.0.0.1:6241/callback');
  });
});

describe('isOAuthNotConfiguredError', () => {
  it('recognizes the service rejection in Error and string form', () => {
    const message =
      'OAuth is not configured for this connector — add your own app’s client ID under Settings (Connections), or set GEZEL_X_CLIENT_ID.';
    expect(isOAuthNotConfiguredError(new Error(message))).toBe(true);
    expect(isOAuthNotConfiguredError(message)).toBe(true);
  });

  it('ignores unrelated errors', () => {
    expect(isOAuthNotConfiguredError(new Error('network timeout'))).toBe(false);
    expect(isOAuthNotConfiguredError(undefined)).toBe(false);
  });
});
