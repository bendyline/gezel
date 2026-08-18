import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bearerAuth, requireFirstParty, requireInternalApiAccess, requireScope } from './auth.js';
import { type TokenStore, createTokenStore } from './token-store.js';

let home: string;
let store: TokenStore;
let app: Hono;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-auth-mw-'));
  store = await createTokenStore({ home, rootToken: 'ROOT-TOKEN' });
  app = new Hono();
  app.use('/api/*', bearerAuth(store));
  app.get('/api/health', (c) => c.json({ ok: true }));
  app.get('/api/whoami', (c) => c.json({ auth: c.get('auth') }));
  app.use('/api/v1/openai/*', requireScope('openai'));
  app.get('/api/v1/openai/probe', (c) => c.json({ allowed: true }));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true }).catch(() => {});
});

describe('bearerAuth', () => {
  it('lets /api/health through without a token', async () => {
    const res = await app.request('/api/health');
    expect(res.status).toBe(200);
  });

  it('rejects requests with no Authorization header', async () => {
    const res = await app.request('/api/whoami');
    expect(res.status).toBe(401);
  });

  it('rejects requests with a bogus bearer token', async () => {
    const res = await app.request('/api/whoami', {
      headers: { Authorization: 'Bearer not-the-token' },
    });
    expect(res.status).toBe(401);
  });

  it('authorizes via Authorization: Bearer and attaches auth to c.var', async () => {
    const res = await app.request('/api/whoami', {
      headers: { Authorization: 'Bearer ROOT-TOKEN' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      auth: { appId: string; appName: string; scopes: string[] };
    };
    expect(body.auth.appId).toBe('root');
    expect(body.auth.appName).toBe('Gezel (root)');
    expect(body.auth.scopes).toEqual(['root']);
  });

  it('rejects query tokens unless the route opts in', async () => {
    const res = await app.request('/api/whoami?token=ROOT-TOKEN');
    expect(res.status).toBe(401);
  });

  it('allows query tokens only for an explicitly approved route', async () => {
    const events = new Hono();
    events.use(
      '/events/*',
      bearerAuth(store, {
        allowQueryToken: (method, path) => method === 'GET' && path === '/events/chat',
      }),
    );
    events.get('/events/chat', (c) => c.json({ auth: c.get('auth') }));
    const res = await events.request('/events/chat?token=ROOT-TOKEN');
    expect(res.status).toBe(200);
  });

  it('authorizes a per-app token and surfaces its appId + scopes', async () => {
    const issued = await store.issue({
      appId: 'docblocks',
      appName: 'DocBlocks',
      scopes: ['openai'],
    });
    const res = await app.request('/api/whoami', {
      headers: { Authorization: `Bearer ${issued.token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      auth: { appId: string; appName: string; scopes: string[] };
    };
    expect(body.auth.appId).toBe('docblocks');
    expect(body.auth.appName).toBe('DocBlocks');
    expect(body.auth.scopes).toEqual(['openai']);
  });

  it('treats a revoked token as unauthorized on the next request', async () => {
    const issued = await store.issue({
      appId: 'docblocks',
      appName: 'DocBlocks',
      scopes: ['openai'],
    });
    const before = await app.request('/api/whoami', {
      headers: { Authorization: `Bearer ${issued.token}` },
    });
    expect(before.status).toBe(200);
    await store.revoke('docblocks');
    const after = await app.request('/api/whoami', {
      headers: { Authorization: `Bearer ${issued.token}` },
    });
    expect(after.status).toBe(401);
  });

  it('stamps lastUsedAt on a successful lookup', async () => {
    const issued = await store.issue({
      appId: 'docblocks',
      appName: 'DocBlocks',
      scopes: ['openai'],
    });
    expect(store.lookup(issued.token)?.lastUsedAt).toBe(0);
    await app.request('/api/whoami', {
      headers: { Authorization: `Bearer ${issued.token}` },
    });
    expect(store.lookup(issued.token)?.lastUsedAt).toBeGreaterThan(0);
  });
});

describe('requireScope', () => {
  it('lets root through every scope check', async () => {
    const res = await app.request('/api/v1/openai/probe', {
      headers: { Authorization: 'Bearer ROOT-TOKEN' },
    });
    expect(res.status).toBe(200);
  });

  it('lets a token with the matching scope through', async () => {
    const issued = await store.issue({
      appId: 'docblocks',
      appName: 'DocBlocks',
      scopes: ['openai'],
    });
    const res = await app.request('/api/v1/openai/probe', {
      headers: { Authorization: `Bearer ${issued.token}` },
    });
    expect(res.status).toBe(200);
  });

  it('returns 403 missing_scope:<scope> when the token lacks the scope', async () => {
    const issued = await store.issue({
      appId: 'narrow-app',
      appName: 'Narrow',
      scopes: ['remote-inference'],
      kind: 'device',
      deviceId: 'narrow-app',
    });
    const res = await app.request('/api/v1/openai/probe', {
      headers: { Authorization: `Bearer ${issued.token}` },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('missing_scope:openai');
  });
});

describe('first-party and internal API scope boundaries', () => {
  it('lets root and ui administer first-party routes, but rejects product/cli/app/session scopes', async () => {
    store = await createTokenStore({
      home,
      rootToken: 'ROOT-TOKEN',
      ephemeralTokens: [
        {
          appId: 'desktop-client',
          appName: 'Gezel Desktop',
          scopes: ['ui'],
          token: 'UI-TOKEN',
        },
      ],
    });
    const openai = await store.issue({
      appId: 'docblocks',
      appName: 'DocBlocks',
      scopes: ['openai'],
    });
    const cli = await store.issue({
      appId: 'gezel-cli',
      appName: 'Gezel CLI',
      scopes: ['cli'],
    });
    const product = await store.issue({
      appId: 'vscode',
      appName: 'Visual Studio Code',
      scopes: ['product', 'openai'],
    });
    const session = store.issueSession({
      appId: 'session:s1',
      projectId: 'p1',
      gezelId: 'g1',
      team: false,
    });
    const guarded = new Hono();
    guarded.use('*', bearerAuth(store));
    guarded.use('*', requireFirstParty());
    guarded.get('*', (c) => c.json({ ok: true }));

    const status = async (token: string): Promise<number> =>
      (await guarded.request('/admin', { headers: { Authorization: `Bearer ${token}` } })).status;
    expect(await status('ROOT-TOKEN')).toBe(200);
    expect(await status('UI-TOKEN')).toBe(200);
    expect(await status(product.token)).toBe(403);
    expect(await status(cli.token)).toBe(403);
    expect(await status(openai.token)).toBe(403);
    expect(await status(session.token)).toBe(403);
  });

  it('confines approved app/device tokens to /v1 while admitting first-party and session tokens', async () => {
    store = await createTokenStore({
      home,
      rootToken: 'ROOT-TOKEN',
      ephemeralTokens: [
        {
          appId: 'desktop-client',
          appName: 'Gezel Desktop',
          scopes: ['ui', 'openai'],
          token: 'UI-TOKEN',
        },
      ],
    });
    const openai = await store.issue({
      appId: 'docblocks',
      appName: 'DocBlocks',
      scopes: ['openai'],
    });
    const cli = await store.issue({
      appId: 'gezel-cli',
      appName: 'Gezel CLI',
      scopes: ['cli'],
    });
    const product = await store.issue({
      appId: 'vscode',
      appName: 'Visual Studio Code',
      scopes: ['product', 'openai'],
    });
    const remote = await store.issue({
      appId: 'remote-device',
      appName: 'Remote',
      scopes: ['remote-inference'],
      kind: 'device',
      deviceId: 'remote-device',
    });
    const session = store.issueSession({
      appId: 'session:s1',
      projectId: 'p1',
      gezelId: 'g1',
      team: false,
    });
    const guarded = new Hono();
    guarded.use('/api/*', bearerAuth(store));
    guarded.use('/api/*', requireInternalApiAccess());
    guarded.get('/api/health', (c) => c.json({ ok: true }));
    guarded.get('/api/private', (c) => c.json({ ok: true }));

    const status = async (token: string): Promise<number> =>
      (
        await guarded.request('/api/private', {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).status;
    expect((await guarded.request('/api/health')).status).toBe(200);
    expect(await status('ROOT-TOKEN')).toBe(200);
    expect(await status('UI-TOKEN')).toBe(200);
    expect(await status(product.token)).toBe(200);
    expect(await status(cli.token)).toBe(200);
    expect(await status(session.token)).toBe(200);
    expect(await status(openai.token)).toBe(403);
    expect(await status(remote.token)).toBe(403);
  });
});
