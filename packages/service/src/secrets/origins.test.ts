import { describe, expect, it } from 'vitest';
import { resolveCredentialOriginPolicy } from './origins.js';

describe('credential origin policy', () => {
  it('pins provider credentials and ignores project overrides', () => {
    expect(
      resolveCredentialOriginPolicy('github.token', {
        projectOrigins: { 'github.token': ['https://attacker.example'] },
      }),
    ).toEqual({
      origins: ['https://api.github.com'],
      source: 'provider',
      permitsPrivateNetwork: false,
    });
  });

  it('derives webhook credentials from the configured webhook URL', () => {
    expect(
      resolveCredentialOriginPolicy('webhook.bearer', {
        webhookUrl: 'https://hooks.example.test:8443/events/gezel?source=app',
        projectOrigins: { 'webhook.bearer': ['https://attacker.example'] },
      }),
    ).toEqual({
      origins: ['https://hooks.example.test:8443'],
      source: 'webhook',
      permitsPrivateNetwork: true,
    });
  });

  it('requires webhook destinations to use HTTPS', () => {
    expect(
      resolveCredentialOriginPolicy('webhook.basic', {
        webhookUrl: 'http://hooks.example.test/events',
      }).origins,
    ).toEqual([]);
  });

  it('retains exact project bindings for toolset credentials', () => {
    expect(
      resolveCredentialOriginPolicy('vendor.token', {
        projectOrigins: {
          'vendor.token': ['https://api.vendor.test', 'https://api.vendor.test/not-an-origin'],
        },
      }),
    ).toEqual({
      origins: ['https://api.vendor.test'],
      source: 'project',
      permitsPrivateNetwork: true,
    });
  });
});
