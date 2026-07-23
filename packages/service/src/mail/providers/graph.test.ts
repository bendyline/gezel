import { describe, expect, it } from 'vitest';
import { validateGraphUrl } from './graph.js';

describe('validateGraphUrl', () => {
  it('accepts only the HTTPS Graph me API origin', () => {
    expect(validateGraphUrl('/mailFolders?$top=10')).toBe(
      'https://graph.microsoft.com/v1.0/me/mailFolders?$top=10',
    );
    expect(
      validateGraphUrl('https://graph.microsoft.com/v1.0/me/messages/delta?$skiptoken=x'),
    ).toContain('/v1.0/me/messages/delta');
  });

  it.each([
    'https://evil.example/steal',
    'http://graph.microsoft.com/v1.0/me/messages',
    'https://graph.microsoft.com.evil.example/v1.0/me/messages',
    'https://graph.microsoft.com/v1.0/users/another-user/messages',
    'https://user:pass@graph.microsoft.com/v1.0/me/messages',
  ])('rejects an untrusted pagination cursor: %s', (url) => {
    expect(() => validateGraphUrl(url)).toThrow(/untrusted/);
  });
});
