/**
 * Headless LAN serving on the machine-engine broker: the broker binds the
 * paired-device listener from its OWN config (no user daemon involved),
 * pairing approval flows through the loopback manage surface, and serving
 * policy (rate limits) constrains LAN device tenants while exempting the
 * first-party bridge credential. Companion to machine-engine-boundary.test.ts,
 * which proves what the broker does NOT serve.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningService, startService } from '../service.js';

let service: RunningService;
let home: string;
let lanPort: number;
let baseUrl: string;
let lanBaseUrl: string;
let httpFetch: typeof fetch;

const priorMock = process.env.GEZEL_MOCK_PROVIDER;
const priorSecrets = process.env.GEZEL_SECRETS_BACKEND;

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

beforeAll(async () => {
  process.env.GEZEL_MOCK_PROVIDER = '1';
  process.env.GEZEL_SECRETS_BACKEND = 'file';
  home = await mkdtemp(join(tmpdir(), 'gezel-engine-serving-'));
  lanPort = await freePort();
  await writeFile(
    join(home, 'config.json'),
    JSON.stringify({
      remoteServing: {
        enabled: true,
        bindAddress: '127.0.0.1',
        port: lanPort,
        limits: { requestsPerMinute: 1 },
      },
    }),
  );
  service = await startService({ home, role: 'machine-engine' });
  baseUrl = `${service.cert ? 'https' : 'http'}://127.0.0.1:${service.port}`;
  lanBaseUrl = `https://127.0.0.1:${lanPort}`;
  httpFetch = service.cert ? createTrustingFetch({ cert: service.cert.certPem }) : fetch;
}, 60_000);

afterAll(async () => {
  await service?.stop();
  await rm(home, { recursive: true, force: true }).catch(() => undefined);
  if (priorMock === undefined) delete process.env.GEZEL_MOCK_PROVIDER;
  else process.env.GEZEL_MOCK_PROVIDER = priorMock;
  if (priorSecrets === undefined) delete process.env.GEZEL_SECRETS_BACKEND;
  else process.env.GEZEL_SECRETS_BACKEND = priorSecrets;
}, 30_000);

function manageFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${service.clientToken}`);
  if (init.body) headers.set('content-type', 'application/json');
  return httpFetch(`${baseUrl}/v1/remote/manage/serving${path}`, { ...init, headers });
}

describe('machine-engine headless LAN serving', () => {
  it('binds the LAN listener at boot from its own config, with no user daemon', async () => {
    expect(service.context.remoteServing.status()).toMatchObject({
      listening: true,
      port: lanPort,
    });
    const state = await manageFetch('');
    expect(state.status).toBe(200);
    const body = (await state.json()) as {
      config: { enabled: boolean };
      status: { listening: boolean; port?: number };
      identity: { deviceId: string; fingerprint: string };
    };
    expect(body.config.enabled).toBe(true);
    expect(body.status).toMatchObject({ listening: true, port: lanPort });
    expect(body.identity.fingerprint).toMatch(/^[0-9a-f]{64}$/);

    const identity = await httpFetch(`${lanBaseUrl}/v1/identity`);
    expect(identity.status).toBe(200);
    await expect(identity.json()).resolves.toMatchObject({ serviceRole: 'machine-engine' });
  });

  it('pairs a LAN device end-to-end with loopback approval, then revokes it', async () => {
    const reg = await httpFetch(`${lanBaseUrl}/v1/apps/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        appId: 'headless-peer',
        appName: 'Headless Peer',
        scopes: ['remote-inference'],
        kind: 'device',
        deviceIdentityPubKey: 'TEST-PUBKEY-PEM',
      }),
    });
    expect(reg.status).toBe(201);
    const { grantRequestId } = (await reg.json()) as { grantRequestId: string };

    const pending = await manageFetch('/grants');
    expect(pending.status).toBe(200);
    await expect(pending.json()).resolves.toMatchObject({
      grants: [{ id: grantRequestId, appId: 'headless-peer', status: 'pending' }],
    });

    const approve = await manageFetch(`/grants/${grantRequestId}/approve`, { method: 'POST' });
    expect(approve.status).toBe(200);

    const poll = await httpFetch(`${lanBaseUrl}/v1/apps/grant/${grantRequestId}`);
    const { token } = (await poll.json()) as { token?: string };
    expect(typeof token).toBe('string');

    const models = await httpFetch(`${lanBaseUrl}/v1/remote/models`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(models.status).toBe(200);

    // A paired device cannot reach its own admission policy or the roster.
    const manageAsDevice = await httpFetch(`${baseUrl}/v1/remote/manage/serving`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(manageAsDevice.status).toBe(403);

    const devices = await manageFetch('/devices');
    await expect(devices.json()).resolves.toMatchObject({
      devices: [{ appId: 'headless-peer' }],
    });

    const revoke = await manageFetch('/devices/headless-peer', { method: 'DELETE' });
    expect(revoke.status).toBe(200);
    const afterRevoke = await httpFetch(`${lanBaseUrl}/v1/remote/models`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(afterRevoke.status).toBe(401);
  });

  it('rate-limits LAN device tenants but never the first-party bridge credential', async () => {
    const reg = await httpFetch(`${lanBaseUrl}/v1/apps/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        appId: 'ratelimited-peer',
        appName: 'Rate Limited Peer',
        scopes: ['remote-inference'],
        kind: 'device',
      }),
    });
    const { grantRequestId } = (await reg.json()) as { grantRequestId: string };
    await manageFetch(`/grants/${grantRequestId}/approve`, { method: 'POST' });
    const poll = await httpFetch(`${lanBaseUrl}/v1/apps/grant/${grantRequestId}`);
    const { token } = (await poll.json()) as { token?: string };

    const admit = (bearer: string) =>
      httpFetch(`${lanBaseUrl}/v1/remote/admit`, {
        method: 'POST',
        headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          protocolVersion: 1,
          model: 'llama-cpp:not-installed-model',
          sessionId: 'rl-session',
        }),
      });

    // requestsPerMinute=1: the first admission is consumed even though the
    // model is missing (404 after admission); the second is rate-limited.
    const first = await admit(token!);
    expect(first.status).toBe(404);
    const second = await admit(token!);
    expect(second.status).toBe(429);
    await expect(second.json()).resolves.toMatchObject({ error: 'tenant_rate_limited' });
    expect(second.headers.get('retry-after')).toMatch(/^\d+$/);

    // The bridge credential (machine-models scope) bypasses tenant policy —
    // otherwise a LAN admission policy would throttle every local user.
    for (let i = 0; i < 3; i++) {
      const res = await httpFetch(`${baseUrl}/v1/remote/admit`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${service.clientToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          protocolVersion: 1,
          model: 'llama-cpp:not-installed-model',
          sessionId: 'rl-session-bridge',
        }),
      });
      expect(res.status).toBe(404);
    }
  });

  it('keeps the manage surface off the LAN app', async () => {
    const res = await httpFetch(`${lanBaseUrl}/v1/remote/manage/serving`, {
      headers: { authorization: `Bearer ${service.clientToken}` },
    });
    expect(res.status).toBe(404);
    const health = await httpFetch(`${lanBaseUrl}/api/health`);
    expect(health.status).toBe(404);
  });

  it('rolls back an invalid serving update without disturbing the listener', async () => {
    const bad = await manageFetch('', {
      method: 'PUT',
      body: JSON.stringify({ enabled: true, bindAddress: 'nonsense.local', port: lanPort }),
    });
    expect(bad.status).toBe(409);
    await expect(bad.json()).resolves.toMatchObject({ error: 'remote-serving-failed' });
    expect(service.context.remoteServing.status()).toMatchObject({
      listening: true,
      port: lanPort,
    });
  });

  it('refuses to revoke the bridge credential through the devices surface', async () => {
    const res = await manageFetch('/devices/machine-engine-client', { method: 'DELETE' });
    expect(res.status).toBe(404);
    // The runtime credential still authenticates.
    expect((await manageFetch('')).status).toBe(200);
  });

  it('disables and re-enables the listener through the manage surface', async () => {
    const off = await manageFetch('', {
      method: 'PUT',
      body: JSON.stringify({ enabled: false }),
    });
    expect(off.status).toBe(200);
    await expect(off.json()).resolves.toMatchObject({ status: { listening: false } });
    await expect(httpFetch(`${lanBaseUrl}/v1/identity`)).rejects.toThrow();

    const on = await manageFetch('', {
      method: 'PUT',
      body: JSON.stringify({ enabled: true, bindAddress: '127.0.0.1', port: lanPort }),
    });
    expect(on.status).toBe(200);
    await expect(on.json()).resolves.toMatchObject({
      status: { listening: true, port: lanPort },
    });
  });
});
