import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pollDeviceFlow, startDeviceFlow } from './oauth.js';

/**
 * Stubs the global `fetch` so we can drive the device-flow code path
 * without contacting GitHub. Each test sets `nextResponse` to control
 * what the next call returns.
 */

let nextResponses: Array<{ ok: boolean; status: number; json: unknown }> = [];

beforeEach(() => {
  nextResponses = [];
  vi.stubGlobal('fetch', async () => {
    const next = nextResponses.shift();
    if (!next) throw new Error('fetch called with no scripted response');
    return {
      ok: next.ok,
      status: next.status,
      async json() {
        return next.json;
      },
      async text() {
        return JSON.stringify(next.json);
      },
    };
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('startDeviceFlow', () => {
  it('returns the device + user codes from a successful response', async () => {
    nextResponses.push({
      ok: true,
      status: 200,
      json: {
        device_code: 'dc-abc',
        user_code: 'WXYZ-1234',
        verification_uri: 'https://github.com/login/device',
        expires_in: 900,
        interval: 5,
      },
    });
    const start = await startDeviceFlow(['repo']);
    expect(start.deviceCode).toBe('dc-abc');
    expect(start.userCode).toBe('WXYZ-1234');
    expect(start.verificationUri).toBe('https://github.com/login/device');
    expect(start.interval).toBe(5);
    expect(start.expiresIn).toBe(900);
  });

  it('throws when GitHub reports an error in the body', async () => {
    nextResponses.push({
      ok: true,
      status: 200,
      json: { error: 'incorrect_client_credentials', error_description: 'oh no' },
    });
    await expect(startDeviceFlow()).rejects.toThrow(/incorrect_client_credentials/);
  });
});

describe('pollDeviceFlow', () => {
  it('maps authorization_pending to status: pending', async () => {
    nextResponses.push({
      ok: true,
      status: 200,
      json: { error: 'authorization_pending' },
    });
    const result = await pollDeviceFlow('dc-abc');
    expect(result.status).toBe('pending');
  });

  it('maps slow_down to status: slow_down', async () => {
    nextResponses.push({
      ok: true,
      status: 200,
      json: { error: 'slow_down' },
    });
    const result = await pollDeviceFlow('dc-abc');
    expect(result.status).toBe('slow_down');
  });

  it('maps expired_token to status: expired', async () => {
    nextResponses.push({
      ok: true,
      status: 200,
      json: { error: 'expired_token' },
    });
    const result = await pollDeviceFlow('dc-abc');
    expect(result.status).toBe('expired');
  });

  it('maps access_denied to status: denied', async () => {
    nextResponses.push({
      ok: true,
      status: 200,
      json: { error: 'access_denied', error_description: 'user said no' },
    });
    const result = await pollDeviceFlow('dc-abc');
    expect(result).toEqual({ status: 'denied', error: 'user said no' });
  });

  it('returns the access token on success and parses scopes', async () => {
    nextResponses.push({
      ok: true,
      status: 200,
      json: {
        access_token: 'gho_token123',
        token_type: 'bearer',
        scope: 'repo,read:user',
      },
    });
    const result = await pollDeviceFlow('dc-abc');
    expect(result).toEqual({
      status: 'success',
      accessToken: 'gho_token123',
      tokenType: 'bearer',
      scopes: ['repo', 'read:user'],
    });
  });

  it('throws on misconfiguration errors so the UI can surface them', async () => {
    nextResponses.push({
      ok: true,
      status: 200,
      json: { error: 'device_flow_disabled' },
    });
    await expect(pollDeviceFlow('dc-abc')).rejects.toThrow(/device_flow_disabled/);
  });
});
