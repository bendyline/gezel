import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppServeSiteStatus, AppServeStartResponse, ScriptRun } from '@bendyline/gezel';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { applyProjectType } from '../project-type/apply.js';
import { type RunningService, startService } from '../service.js';

/**
 * End-to-end app-serve coverage: a booted service, the SHIPPED checkers
 * type applied, a real second listener started through the control API, and
 * a visitor driving it with plain fetch — key exchange, cookie auth, the
 * shared page-io enforcement, chat with the mock provider, and teardown.
 * `scriptRunner.run` is stubbed (sandbox execution is platform-gated); the
 * enforcement path above it is fully real.
 */

let svc: RunningService;
let controlBase: string;
let token: string;
let home: string;
let controlFetch: typeof fetch;
let projectId: string;
let site: AppServeStartResponse;
let cookie: string;

const priorMockFlag = process.env.GEZEL_MOCK_PROVIDER;

function okRun(output: unknown): ScriptRun {
  return {
    id: `run-${Math.random().toString(36).slice(2, 8)}`,
    projectId,
    scriptName: 'game-store',
    startedAt: new Date().toISOString(),
    status: 'ok',
    trigger: { kind: 'page', tool: 'user_move' },
    inputs: {},
    output,
    calls: [],
    logs: '',
  };
}

function control(path: string, init?: RequestInit & { auth?: string | null }): Promise<Response> {
  const auth = init?.auth === undefined ? token : init.auth;
  return controlFetch(`${controlBase}${path}`, {
    ...init,
    headers: {
      ...(auth === null ? {} : { Authorization: `Bearer ${auth}` }),
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
}

function visitor(path: string, init?: RequestInit & { noCookie?: boolean }): Promise<Response> {
  return fetch(`${site.url.replace(/\/$/, '')}${path}`, {
    redirect: 'manual',
    ...init,
    headers: {
      ...(init?.noCookie ? {} : { cookie }),
      ...(init?.headers ?? {}),
    },
  });
}

beforeAll(async () => {
  process.env.GEZEL_MOCK_PROVIDER = '1';
  home = await mkdtemp(join(tmpdir(), 'gezel-app-serve-'));
  svc = await startService({ home });
  const scheme = svc.cert ? 'https' : 'http';
  controlBase = `${scheme}://127.0.0.1:${svc.port}`;
  token = svc.context.token;
  controlFetch = svc.cert ? createTrustingFetch({ cert: svc.cert.certPem }) : fetch;

  const project = await svc.context.store.createProject({ name: 'Served Game' });
  projectId = project.id;
  await applyProjectType(
    { store: svc.context.store, catalog: svc.context.catalog, home },
    { projectId, typeId: 'checkers' },
  );
  svc.context.scriptRunner.run = vi.fn(async () =>
    okRun({ board: 'ascii', status: 'playing' }),
  ) as unknown as typeof svc.context.scriptRunner.run;

  const started = await control('/api/app-serve', {
    method: 'POST',
    body: JSON.stringify({ projectId, chat: true }),
  });
  expect(started.status).toBe(201);
  site = (await started.json()) as AppServeStartResponse;
}, 60_000);

afterAll(async () => {
  await svc.stop();
  await rm(home, { recursive: true, force: true }).catch(() => {});
  if (priorMockFlag === undefined) delete process.env.GEZEL_MOCK_PROVIDER;
  else process.env.GEZEL_MOCK_PROVIDER = priorMockFlag;
}, 30_000);

async function findVisitorSession() {
  const summaries = await svc.context.store.listSessions({ projectId });
  for (const summary of summaries) {
    const full = await svc.context.store.findSessionById(summary.id);
    if (full?.visitorAccess === true) return full;
  }
  return undefined;
}

describe('control surface', () => {
  it('requires first-party/cli auth and denies session tokens', async () => {
    expect((await control('/api/app-serve', { auth: null })).status).toBe(401);
    const record = svc.context.tokenStore.issueSession({
      appId: 'session:serve-test',
      projectId,
      gezelId: 'someone',
      team: false,
    });
    expect((await control('/api/app-serve', { auth: record.token })).status).toBe(403);
  });

  it('refuses a second site for the same project and an untyped project', async () => {
    const dup = await control('/api/app-serve', {
      method: 'POST',
      body: JSON.stringify({ projectId }),
    });
    expect(dup.status).toBe(409);
    const plain = await svc.context.store.createProject({ name: 'Plain' });
    const untyped = await control('/api/app-serve', {
      method: 'POST',
      body: JSON.stringify({ projectId: plain.id }),
    });
    expect(untyped.status).toBe(409);
    expect(((await untyped.json()) as { error: string }).error).toContain('gezel app apply');
  });

  it('lists the running site without leaking the key', async () => {
    const res = await control('/api/app-serve');
    const { sites } = (await res.json()) as { sites: AppServeSiteStatus[] };
    expect(sites).toHaveLength(1);
    expect(sites[0]).toMatchObject({ siteId: site.siteId, projectId, chat: true });
    expect(JSON.stringify(sites)).not.toContain(site.siteKey);
  });
});

describe('visitor flow', () => {
  it('exchanges the share key for a cookie and strips the key from the URL', async () => {
    const res = await fetch(site.shareUrl, { redirect: 'manual' });
    expect(res.status).toBe(302);
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    const location = res.headers.get('location') ?? '';
    expect(location).toContain('/pages/');
    expect(location).not.toContain(site.siteKey);
    cookie = setCookie.split(';')[0] ?? '';
    expect(cookie.length).toBeGreaterThan(10);
  });

  it('refuses keyless strangers with a 401 page', async () => {
    const res = await visitor('/', { noCookie: true });
    expect(res.status).toBe(401);
  });

  it('serves the entry page with the serve bootstrap and no secrets', async () => {
    const res = await visitor('/pages/board/index.html');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('"serve":{"apiBase":"/app/api"');
    expect(html).toContain('window.gezel');
    expect(html).not.toContain(site.siteKey);
    expect(html).not.toContain(token);
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('sandbox');
    expect(res.headers.get('x-gezel-app-serve')).toBe('1');
  });

  it('enforces the page-tool allowlist exactly like the first-party route', async () => {
    const noCookie = await visitor('/app/api/invoke', {
      method: 'POST',
      noCookie: true,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tool: 'user_move' }),
    });
    expect(noCookie.status).toBe(401);

    const hidden = await visitor('/app/api/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tool: 'get_board' }),
    });
    expect(hidden.status).toBe(403);

    const ok = await visitor('/app/api/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tool: 'user_move', input: { from: 'c3', to: 'd4' } }),
    });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { status: string }).status).toBe('ok');
  });

  it('refuses cross-origin POSTs', async () => {
    const res = await visitor('/app/api/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
      body: JSON.stringify({ tool: 'user_move' }),
    });
    expect(res.status).toBe(403);
  });

  it('scopes reads and /data to the declared pages.reads', async () => {
    const undeclared = await visitor('/app/api/read', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'read', source: 'workspace', path: 'not/declared.json' }),
    });
    expect(undeclared.status).toBe(403);

    const data = await visitor('/data/workspace/not/declared.json');
    expect(data.status).toBe(403);
  });

  it('rejects unknown routes via the allowlist', async () => {
    expect((await visitor('/api/health')).status).toBe(404);
    expect((await visitor('/v1/models')).status).toBe(404);
  });
});

describe('visitor chat', () => {
  it('holds an isolated, toolless conversation with the project lead', async () => {
    const send = await visitor('/app/api/chat/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Reply exactly with: hello-visitor' }),
    });
    expect(send.status).toBe(202);

    await vi.waitFor(
      async () => {
        const res = await visitor('/app/api/chat/history');
        const { messages } = (await res.json()) as {
          messages: Array<{ role: string; content: string }>;
        };
        expect(
          messages.some((m) => m.role === 'assistant' && m.content.includes('Mock reply')),
        ).toBe(true);
      },
      { timeout: 15_000, interval: 250 },
    );

    const visitorSession = await findVisitorSession();
    expect(visitorSession).toBeDefined();
    expect(visitorSession?.projectId).toBe(projectId);
  });
});

describe('teardown', () => {
  it('stop closes the listener and archives the visitor session', async () => {
    const stopped = await control(`/api/app-serve/${site.siteId}`, { method: 'DELETE' });
    expect(stopped.status).toBe(200);

    await expect(visitor('/pages/board/index.html')).rejects.toThrow();

    const list = await control('/api/app-serve');
    expect(((await list.json()) as { sites: unknown[] }).sites).toEqual([]);

    const visitorSession = await findVisitorSession();
    expect(visitorSession?.archived).toBe(true);
  });
});
