import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CONTAINER_DENIED_PREFIXES,
  admittedOnContainerListener,
  containerHostPolicy,
  resolveContainerListener,
} from './http/container-listener.js';
import { type RunningService, startService } from './service.js';

// The container listener as a container runs it: GEZEL_CONTAINER on (forced,
// since the test is not in one), an ephemeral port instead of 6228, and the
// accounts it requires.
let svc: RunningService;
let home: string;
let port: number;

const env = {
  GEZEL_MOCK_PROVIDER: '1',
  GEZEL_INSECURE_TRANSPORT: '1',
  GEZEL_CONTAINER: '1',
  GEZEL_CONTAINER_FORCE: '1',
  GEZEL_CONTAINER_PORT: '0',
} as const;
const prior: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const [key, value] of Object.entries(env)) {
    prior[key] = process.env[key];
    process.env[key] = value;
  }
  home = await mkdtemp(join(tmpdir(), 'gezel-container-'));
  svc = await startService({ home });
  expect(svc.containerPort).toBeTypeOf('number');
  port = svc.containerPort!;
}, 60_000);

afterAll(async () => {
  await svc?.stop();
  await rm(home, { recursive: true, force: true }).catch(() => {});
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}, 30_000);

interface Reply {
  status: number;
  body: Record<string, unknown>;
}

function call(
  method: string,
  path: string,
  opts: { host?: string; token?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers: {
          Host: opts.host ?? `localhost:${port}`,
          ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
          ...(payload ? { 'content-type': 'application/json' } : {}),
          ...opts.headers,
        },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          text += chunk;
        });
        res.on('end', () => {
          let body: Record<string, unknown> = {};
          try {
            body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
          } catch {
            body = { text };
          }
          resolve({ status: res.statusCode ?? 0, body });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describe('the container listener', () => {
  it('answers liveness without the pid or host details', async () => {
    const health = await call('GET', '/api/health');
    expect(health.status).toBe(200);
    expect(health.body.ok).toBe(true);
    expect(health.body).not.toHaveProperty('pid');
    expect(health.body).not.toHaveProperty('hostedBy');
  });

  it('refuses a hostname it was not told about', async () => {
    expect((await call('GET', '/api/health', { host: `attacker.example:${port}` })).status).toBe(
      403,
    );
    // An IP literal means a LAN client over plain HTTP: off unless opted into.
    expect((await call('GET', '/api/health', { host: `192.168.1.20:${port}` })).status).toBe(403);
  });

  it('requires a signed-in account, and refuses the owner runtime credential', async () => {
    expect((await call('GET', '/api/projects')).status).toBe(401);
    expect((await call('GET', '/api/projects', { token: svc.clientToken })).status).toBe(401);
    expect((await call('GET', '/api/projects', { token: svc.context.token })).status).toBe(401);
  });

  it('leaves out the routes that trust a local caller', async () => {
    for (const prefix of ['/v1/apps/local-connect', '/v1/apps/harness-connect', '/v1/identity']) {
      expect((await call('POST', prefix, { body: {} })).status).toBe(404);
    }
    expect((await call('GET', '/api/codex-setup', { token: 'x' })).status).toBe(404);
  });

  it('sets up the first account with the setup code, then signs in', async () => {
    const state = await call('GET', '/v1/apps/signin/state');
    expect(state.body).toEqual({
      accountsRequired: true,
      setupRequired: true,
      setupCodeAvailable: true,
    });

    const crossSite = await call('POST', '/v1/apps/signin/setup', {
      body: { code: 'x', name: 'Mike', password: 'longenough' },
      headers: { 'sec-fetch-site': 'cross-site' },
    });
    expect(crossSite.status).toBe(403);

    const code = svc.context.announceSetupLink?.()?.code;
    expect(code).toBeTruthy();
    const setup = await call('POST', '/v1/apps/signin/setup', {
      body: { code, name: 'Mike', password: 'longenough' },
      headers: { 'sec-fetch-site': 'same-origin' },
    });
    expect(setup.status).toBe(200);
    const token = setup.body.token as string;
    expect(token.startsWith('gzs_')).toBe(true);

    expect((await call('GET', '/api/projects', { token })).status).toBe(200);
    const me = await call('GET', '/api/accounts/me', { token });
    expect((me.body.account as { name: string }).name).toBe('Mike');

    const wrong = await call('POST', '/v1/apps/signin', {
      body: { name: 'mike', password: 'not-it-at-all' },
    });
    expect(wrong.status).toBe(401);
    const again = await call('POST', '/v1/apps/signin', {
      body: { name: 'mike', password: 'longenough' },
    });
    expect(again.status).toBe(200);

    // Accounts a signed-in person creates are attributed to them.
    const added = await call('POST', '/api/accounts', {
      token,
      body: { name: 'Ana', password: 'longenough' },
    });
    expect(added.status).toBe(201);
    const log = await readFile(join(home, 'history.jsonl'), 'utf8');
    const created = log
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { kind: string; summary: string; by?: { name: string } })
      .find((event) => event.kind === 'account.created' && event.summary.startsWith('Ana'));
    expect(created?.by?.name).toBe('Mike');

    // Signing out ends the session.
    const out = await call('POST', '/v1/apps/signin/signout', { token });
    expect(out.body.signedOut).toBe(true);
    expect((await call('GET', '/api/projects', { token })).status).toBe(401);
  }, 30_000);

  it('serves OpenAI-style compute to an app key made from the shell', async () => {
    const minted = await fetch(`http://127.0.0.1:${svc.port}/api/app-tokens`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${svc.clientToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ appId: 'my-notebook', appName: 'My notebook' }),
    });
    expect(minted.status).toBe(201);
    const { token } = (await minted.json()) as { token: string };
    const models = await call('GET', '/v1/models', { token });
    expect(models.status).toBe(200);
    // The key is for compute, not the product API.
    expect((await call('GET', '/api/projects', { token })).status).toBe(403);
    // And it shows in Integrations like any other app.
    const roster = await fetch(`http://127.0.0.1:${svc.port}/v1/apps`, {
      headers: { authorization: `Bearer ${svc.clientToken}` },
    });
    const apps = ((await roster.json()) as { apps: Array<{ appId: string }> }).apps;
    expect(apps.some((a) => a.appId === 'my-notebook')).toBe(true);
  });

  it('still serves the owner credential on loopback', async () => {
    const res = await fetch(`http://127.0.0.1:${svc.port}/api/projects`, {
      headers: { authorization: `Bearer ${svc.clientToken}` },
    });
    expect(res.status).toBe(200);
  });
});

describe('container listener settings', () => {
  it('stays off without a container, even when asked', () => {
    const off = resolveContainerListener({ GEZEL_CONTAINER: '1' }, () => false);
    expect(off.enabled).toBe(false);
    expect(off.refusedBecause).toContain('GEZEL_CONTAINER_FORCE');
    expect(resolveContainerListener({ GEZEL_CONTAINER: '1' }, () => true)).toEqual({
      enabled: true,
      port: 6228,
    });
    expect(resolveContainerListener({}, () => true).enabled).toBe(false);
  });

  it('admits hostnames only when named, and LAN addresses only on request', () => {
    const policy = containerHostPolicy({
      GEZEL_ALLOWED_HOSTS: 'gezel.home, 10.0.0.5',
      GEZEL_LAN: 'plain-http',
    });
    expect(policy.allowedHostnames()).toEqual(['gezel.home']);
    expect(policy.allowLanIpHosts()).toBe(true);
    expect(containerHostPolicy({}).allowLanIpHosts()).toBe(false);
  });

  it('refuses every local credential kind', () => {
    const base = { appName: 'x', token: 't', createdAt: 0, lastUsedAt: 0 };
    expect(admittedOnContainerListener({ ...base, appId: 'desktop-client', scopes: ['ui'] })).toBe(
      false,
    );
    expect(admittedOnContainerListener({ ...base, appId: 's', scopes: ['session'] })).toBe(false);
    expect(
      admittedOnContainerListener({ ...base, appId: 'h', scopes: ['harness'], kind: 'harness' }),
    ).toBe(false);
    expect(admittedOnContainerListener({ ...base, appId: 'app', scopes: ['openai'] })).toBe(true);
    expect(admittedOnContainerListener({ ...base, appId: 'cli', scopes: ['cli'] })).toBe(true);
    expect(CONTAINER_DENIED_PREFIXES).toContain('/v1/apps/local-connect');
  });
});
