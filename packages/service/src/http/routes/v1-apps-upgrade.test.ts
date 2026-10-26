import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningService, startService } from '../../service.js';

let svc: RunningService;
let baseUrl: string;
let rootToken: string;
let home: string;
let httpFetch: typeof fetch;

const priorMockFlag = process.env.GEZEL_MOCK_PROVIDER;

beforeAll(async () => {
  process.env.GEZEL_MOCK_PROVIDER = '1';
  home = await mkdtemp(join(tmpdir(), 'gezel-v1-apps-upgrade-'));
  svc = await startService({ home });
  const scheme = svc.cert ? 'https' : 'http';
  baseUrl = `${scheme}://127.0.0.1:${svc.port}`;
  rootToken = svc.context.token;
  httpFetch = svc.cert ? createTrustingFetch({ cert: svc.cert.certPem }) : fetch;
}, 30_000);

afterAll(async () => {
  await svc.stop();
  await rm(home, { recursive: true, force: true }).catch(() => {});
  if (priorMockFlag === undefined) delete process.env.GEZEL_MOCK_PROVIDER;
  else process.env.GEZEL_MOCK_PROVIDER = priorMockFlag;
}, 30_000);

function v1(
  method: string,
  path: string,
  opts: { body?: unknown; token?: string } = {},
): Promise<Response> {
  return httpFetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
}

describe('adding a scope to a connected app', () => {
  it('lets a connected app add the images scope, keeping its token until approval', async () => {
    const health = (await (await v1('GET', '/api/health')).json()) as {
      images?: { available: boolean };
    };
    expect(health.images).toEqual({ available: true });

    const first = await v1('POST', '/v1/apps/register', {
      body: { appId: 'upgrade-app', appName: 'Upgrade App', scopes: ['openai'] },
    });
    const { grantRequestId: firstGrant } = (await first.json()) as { grantRequestId: string };
    await v1('POST', `/v1/apps/grant/${firstGrant}/approve`, { token: rootToken });
    const { token: oldToken } = (await (
      await v1('GET', `/v1/apps/grant/${firstGrant}`)
    ).json()) as { token: string };
    expect((await v1('GET', '/v1/images/models', { token: oldToken })).status).toBe(403);

    const upgrade = { appId: 'upgrade-app', appName: 'Upgrade App', scopes: ['openai', 'images'] };
    // Only the holder of the current token may ask to widen it.
    expect((await v1('POST', '/v1/apps/register', { body: upgrade })).status).toBe(409);
    expect(
      (
        await v1('POST', '/v1/apps/register', {
          body: { ...upgrade, scopes: ['images'] },
          token: oldToken,
        })
      ).status,
    ).toBe(409);
    const asked = await v1('POST', '/v1/apps/register', { body: upgrade, token: oldToken });
    expect(asked.status).toBe(201);
    const { grantRequestId, verificationCode } = (await asked.json()) as {
      grantRequestId: string;
      verificationCode: string;
    };
    expect(verificationCode).toBeTruthy();
    const listed = (await (await v1('GET', '/v1/apps', { token: rootToken })).json()) as {
      grants: Array<{ id: string; upgradeFrom?: string[] }>;
    };
    expect(listed.grants.find((g) => g.id === grantRequestId)?.upgradeFrom).toEqual(['openai']);
    // The current grant keeps working while the person decides.
    expect((await v1('GET', '/v1/images/models', { token: oldToken })).status).toBe(403);

    const approve = await httpFetch(`${baseUrl}/v1/apps/grant/${grantRequestId}/approve`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${rootToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ verificationCode }),
    });
    expect(approve.status).toBe(200);
    const { token: newToken } = (await (
      await v1('GET', `/v1/apps/grant/${grantRequestId}`)
    ).json()) as { token: string };
    expect(newToken).not.toBe(oldToken);
    expect((await v1('GET', '/v1/images/models', { token: newToken })).status).toBe(200);
    expect((await v1('GET', '/v1/images/models', { token: oldToken })).status).toBe(401);
    const apps = svc.context.tokenStore.list().filter((r) => r.appId === 'upgrade-app');
    expect(apps.map((r) => r.scopes)).toEqual([['openai', 'images']]);
  });
});
