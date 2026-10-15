import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningService, startService } from '../service.js';

/**
 * Two real daemons: one shares its models over a LAN listener on loopback,
 * the other connects to it with the code the first one shows.
 */

let server: RunningService;
let client: RunningService;
let homes: string[] = [];
let remoteBase: string;

const priorMockFlag = process.env.GEZEL_MOCK_PROVIDER;

function loopbackApi(svc: RunningService) {
  const fetchImpl = svc.cert ? createTrustingFetch({ cert: svc.cert.certPem }) : fetch;
  const base = `${svc.cert ? 'https' : 'http'}://127.0.0.1:${svc.port}`;
  return async (method: string, path: string, body?: unknown) => {
    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${svc.clientToken}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
}

beforeAll(async () => {
  process.env.GEZEL_MOCK_PROVIDER = '1';
  homes = await Promise.all([
    mkdtemp(join(tmpdir(), 'gezel-pair-server-')),
    mkdtemp(join(tmpdir(), 'gezel-pair-client-')),
  ]);
  server = await startService({ home: homes[0]! });
  client = await startService({ home: homes[1]! });
  const status = await server.context.remoteServing.reconfigure({
    enabled: true,
    bindAddress: '127.0.0.1',
    port: 0,
  });
  remoteBase = `https://127.0.0.1:${status.port}`;
}, 60_000);

afterAll(async () => {
  await server?.context.remoteServing.reconfigure({ enabled: false }).catch(() => undefined);
  await server?.stop();
  await client?.stop();
  await Promise.all(homes.map((h) => rm(h, { recursive: true, force: true }).catch(() => {})));
  if (priorMockFlag === undefined) delete process.env.GEZEL_MOCK_PROVIDER;
  else process.env.GEZEL_MOCK_PROVIDER = priorMockFlag;
}, 60_000);

describe('pairing with a connect code', () => {
  it('tells a connecting device that this server takes codes', async () => {
    const res = await loopbackApi(client)('POST', '/api/remotes/inspect', { baseUrl: remoteBase });
    expect(res.status).toBe(200);
    expect(res.json.pairingMethods).toEqual(['code', 'approval']);
  });

  it('says plainly when the server is not showing a code', async () => {
    await loopbackApi(server)('DELETE', '/api/remote-serving/pairing-code');
    const res = await loopbackApi(client)('POST', '/api/remotes/pair-with-code', {
      baseUrl: remoteBase,
      code: '12345678',
    });
    expect(res.status).toBe(409);
    expect(res.json.error).toBe('pairing_closed');
    expect(String(res.json.message)).toMatch(/Add a device/);
  });

  it('refuses a wrong code and leaves the shown code usable', async () => {
    const opened = await loopbackApi(server)('POST', '/api/remote-serving/pairing-code');
    const code = String(opened.json.code);
    const wrong = code === '00000000' ? '00000001' : '00000000';
    const res = await loopbackApi(client)('POST', '/api/remotes/pair-with-code', {
      baseUrl: remoteBase,
      code: wrong,
    });
    expect(res.status).toBe(403);
    expect(res.json.error).toBe('pairing_code_rejected');
    const after = await loopbackApi(server)('GET', '/api/remote-serving/pairing-code');
    expect(after.json).toMatchObject({ code, attemptsLeft: 4 });
    expect(client.context.remotes.list()).toEqual([]);
  });

  it('connects with the right code, with no approval step, and the token works', async () => {
    const opened = await loopbackApi(server)('POST', '/api/remote-serving/pairing-code');
    const code = String(opened.json.code);
    const res = await loopbackApi(client)('POST', '/api/remotes/pair-with-code', {
      baseUrl: remoteBase,
      code: `${code.slice(0, 4)} ${code.slice(4)}`,
    });
    expect(res.status).toBe(201);

    const remote = client.context.remotes.list()[0]!;
    expect(remote.pinnedIdentityFingerprint).toBe(server.context.deviceIdentity!.fingerprint);
    expect(remote.displayName.length).toBeGreaterThan(0);

    const record = server.context.tokenStore
      .list()
      .find((r) => r.appId === client.context.deviceIdentity!.deviceId);
    expect(record).toMatchObject({ kind: 'device', scopes: ['remote-inference'] });
    expect(server.context.grants.list().filter((g) => g.status === 'pending')).toEqual([]);

    // One code, one device: it is gone, and the server can say who used it.
    const after = await loopbackApi(server)('GET', '/api/remote-serving/pairing-code');
    expect(after.json.code).toBeNull();
    expect(after.json.lastPaired).toMatchObject({ appName: expect.any(String) });

    const lanFetch = createTrustingFetch({ cert: server.cert!.certPem });
    const models = await lanFetch(`${remoteBase}/v1/remote/models`, {
      headers: { Authorization: `Bearer ${remote.token}` },
    });
    expect(models.status).toBe(200);
  });

  it('keeps the pairing routes off browsers', async () => {
    const lanFetch = createTrustingFetch({ cert: server.cert!.certPem });
    const res = await lanFetch(`${remoteBase}/v1/apps/pair/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
      body: '{}',
    });
    expect(res.status).toBe(403);
  });

  it('will not show a code while sharing is off', async () => {
    await server.context.remoteServing.reconfigure({ enabled: false });
    try {
      const res = await loopbackApi(server)('POST', '/api/remote-serving/pairing-code');
      expect(res.status).toBe(409);
      expect(res.json.error).toBe('not_serving');
    } finally {
      const status = await server.context.remoteServing.reconfigure({
        enabled: true,
        bindAddress: '127.0.0.1',
        port: 0,
      });
      remoteBase = `https://127.0.0.1:${status.port}`;
    }
  });
});
