import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type RunningService, startService } from '../service.js';

/**
 * End-to-end check of the per-session token scope guard (#10): a session
 * token scoped to project A may reach `/api/projects/A/*` but is refused
 * `/api/projects/B/*`, while a `team` session and the root token reach any
 * project. Asserts on the guard's 403 vs pass-through, not the downstream
 * route's body, so it's independent of whether the project exists.
 */

let svc: RunningService;
let home: string;
let httpFetch: typeof fetch;
let baseUrl: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-scope-guard-'));
  process.env.GEZEL_MOCK_PROVIDER = '1';
  // These assertions exercise HTTP authorization boundaries, not semantic
  // ranking. Loading the transformer embedding model on the first allowed
  // craftbook suggestion can take 20s+ on CPU and makes the 5s test body
  // timeout nondeterministic under concurrent eval/build load.
  process.env.GEZEL_DISABLE_EMBEDDINGS = '1';
  // Exercise all three guards in enforce mode (the production default).
  process.env.GEZEL_TEAM_SCOPE = 'enforce';
  process.env.GEZEL_IDENTITY_SCOPE = 'enforce';
  svc = await startService({ home });
  const scheme = svc.cert ? 'https' : 'http';
  baseUrl = `${scheme}://127.0.0.1:${svc.port}`;
  httpFetch = svc.cert ? createTrustingFetch({ cert: svc.cert.certPem }) : fetch;
}, 30_000);

afterEach(async () => {
  await svc.stop();
  await rm(home, { recursive: true, force: true }).catch(() => {});
  delete process.env.GEZEL_MOCK_PROVIDER;
  delete process.env.GEZEL_DISABLE_EMBEDDINGS;
  delete process.env.GEZEL_TEAM_SCOPE;
  delete process.env.GEZEL_IDENTITY_SCOPE;
}, 30_000);

function post(path: string, token: string): Promise<Response> {
  return httpFetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: '{}',
  });
}

function postJson(path: string, token: string, body: unknown): Promise<Response> {
  return httpFetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function get(path: string, token: string): Promise<Response> {
  return httpFetch(`${baseUrl}${path}`, { headers: { Authorization: `Bearer ${token}` } });
}

describe('token scope guard (integration)', () => {
  it('confines a worker session to its project; team + root reach any project', async () => {
    const worker = svc.context.tokenStore.issueSession({
      appId: 'session:worker',
      projectId: 'proj-a',
      gezelId: 'gz-1',
      team: false,
    });
    const coord = svc.context.tokenStore.issueSession({
      appId: 'session:coord',
      projectId: 'proj-a',
      gezelId: 'gz-2',
      team: true,
    });

    // Worker → own project: guard passes (route may 200/404, never 403).
    expect((await get('/api/projects/proj-a/tasks', worker.token)).status).not.toBe(403);
    // Worker → other project: guard denies with a scope error.
    const denied = await get('/api/projects/proj-b/tasks', worker.token);
    expect(denied.status).toBe(403);
    const json = (await denied.json()) as { error: string; hint?: string };
    expect(json.error).toBe('forbidden');
    expect(json.hint).toContain('proj-b');

    // Coordinator (team) → any project: allowed.
    expect((await get('/api/projects/proj-b/tasks', coord.token)).status).not.toBe(403);
    // Root token → any project: allowed (unchanged behavior).
    expect((await get('/api/projects/proj-b/tasks', svc.context.token)).status).not.toBe(403);
  });

  it('gates team/orchestration routes for a worker, not for team/root', async () => {
    const worker = svc.context.tokenStore.issueSession({
      appId: 'session:worker2',
      projectId: 'proj-a',
      gezelId: 'gz-1',
      team: false,
    });
    const coord = svc.context.tokenStore.issueSession({
      appId: 'session:coord2',
      projectId: 'proj-a',
      gezelId: 'gz-2',
      team: true,
    });

    // Worker → create gezel (team route): 403.
    expect((await post('/api/gezels', worker.token)).status).toBe(403);
    // Worker → its own non-team read (not a team route → guard passes; the
    // route may 404 for a nonexistent gezel, but never 403).
    expect((await get('/api/gezels/gz-1', worker.token)).status).not.toBe(403);
    // Coordinator + root → team route allowed (not 403; body may be 400/422).
    expect((await post('/api/gezels', coord.token)).status).not.toBe(403);
    expect((await post('/api/gezels', svc.context.token)).status).not.toBe(403);
  });

  it('confines a worker session to its own gezel identity; team + root reach any', async () => {
    const worker = svc.context.tokenStore.issueSession({
      appId: 'session:worker3',
      projectId: 'proj-a',
      gezelId: 'gz-self',
      team: false,
    });
    const coord = svc.context.tokenStore.issueSession({
      appId: 'session:coord3',
      projectId: 'proj-a',
      gezelId: 'gz-self',
      team: true,
    });

    // Worker → its own gezel: guard passes (route may 404, never 403).
    expect((await get('/api/gezels/gz-self/growth', worker.token)).status).not.toBe(403);
    // Worker → another gezel's identity: denied.
    const denied = await get('/api/gezels/gz-other/growth', worker.token);
    expect(denied.status).toBe(403);
    const json = (await denied.json()) as { error: string; hint?: string };
    expect(json.error).toBe('forbidden');
    expect(json.hint).toContain('gz-other');
    // Coordinator + root → any gezel: allowed.
    expect((await get('/api/gezels/gz-other/growth', coord.token)).status).not.toBe(403);
    expect((await get('/api/gezels/gz-other/growth', svc.context.token)).status).not.toBe(403);
  });

  it('keeps app tokens on /v1 and session tokens off admin/session/event/terminal surfaces', async () => {
    const appToken = await svc.context.tokenStore.issue({
      appId: 'openai-only-app',
      appName: 'OpenAI-only app',
      scopes: ['openai'],
    });
    const productToken = await svc.context.tokenStore.issue({
      appId: 'product-app',
      appName: 'Product app',
      scopes: ['product', 'openai'],
    });
    expect((await get('/api/config', appToken.token)).status).toBe(403);
    expect((await get('/api/config', productToken.token)).status).toBe(200);
    expect((await get('/v1/apps', productToken.token)).status).toBe(403);
    expect((await get('/api/config', svc.clientToken)).status).toBe(200);

    const worker = svc.context.tokenStore.issueSession({
      appId: 'session:locked-worker',
      projectId: 'proj-a',
      gezelId: 'gz-self',
      team: false,
    });
    const coordinator = svc.context.tokenStore.issueSession({
      appId: 'session:locked-coordinator',
      projectId: 'proj-a',
      gezelId: 'gz-coord',
      team: true,
    });
    for (const token of [worker.token, coordinator.token]) {
      expect((await get('/api/config', token)).status).toBe(403);
      expect((await get('/api/sessions', token)).status).toBe(403);
      expect((await get('/events/chat/all', token)).status).toBe(403);
      expect(
        (
          await httpFetch(`${baseUrl}/api/projects/proj-a/terminals/run`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: JSON.stringify({ workingDir: '', input: 'echo should-not-run' }),
          })
        ).status,
      ).toBe(403);
      expect(
        (await get('/api/documents/read?path=projects%2Fproj-b%2Fartifacts%2Fsecret.md', token))
          .status,
      ).toBe(403);
    }

    // The worker's normal project MCP routes remain reachable.
    expect((await get('/api/projects/proj-a/tasks', worker.token)).status).not.toBe(403);
  });

  it('blocks selector and literal-route side doors around project scope', async () => {
    const worker = svc.context.tokenStore.issueSession({
      appId: 'session:selector-worker',
      projectId: 'proj-a',
      gezelId: 'gz-worker',
      team: false,
    });
    const coordinator = svc.context.tokenStore.issueSession({
      appId: 'session:selector-coordinator',
      projectId: 'proj-a',
      gezelId: 'gz-coordinator',
      team: true,
    });

    expect(
      (await get('/api/craftbooks?source=project&projectId=proj-b', worker.token)).status,
    ).toBe(403);
    expect(
      (
        await postJson('/api/craftbooks/suggest', worker.token, {
          query: 'review',
          projectId: 'proj-b',
        })
      ).status,
    ).toBe(403);
    // Reading the body in the guard must not consume it before the real route.
    expect(
      (
        await postJson('/api/craftbooks/suggest', worker.token, {
          query: 'review',
          projectId: 'proj-a',
        })
      ).status,
    ).toBe(200);
    expect(
      (await postJson('/api/projects/preview-folder', coordinator.token, { path: home })).status,
    ).toBe(403);
    expect(
      (await get('/api/gezels/mention-candidates?project=proj-b', coordinator.token)).status,
    ).toBe(403);
    // Generous timeout: the 200-path craftbook suggest cold-loads the REAL
    // transformers.js embedder inside this test (~5-6s on a cold cache),
    // which sits right at vitest's 5s default — same rationale as the
    // embedder tests in content-enrich.test.ts.
  }, 30_000);
});
