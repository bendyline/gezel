import { describe, expect, it } from 'vitest';
import { isExpired, providerEndpoints } from './oauth.js';
import { defaultFoldersFor } from './registry.js';

describe('endpoint helpers', () => {
  it('parameterizes the Microsoft token endpoint by tenant', () => {
    expect(providerEndpoints('outlook', 'consumers').tokenEndpoint).toContain('/consumers/');
    expect(providerEndpoints('gmail').tokenEndpoint).toBe('https://oauth2.googleapis.com/token');
  });
  it('carries the Graph mail scopes for Microsoft providers', () => {
    expect(providerEndpoints('microsoft365', 'organizations').scopes).toContain(
      'https://graph.microsoft.com/Mail.Send',
    );
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
