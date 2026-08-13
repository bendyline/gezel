import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ScriptRun } from '@bendyline/gezel';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { applyProjectType } from '../../project-type/apply.js';
import { type RunningService, startService } from '../../service.js';

/**
 * The page-invoke bridge route, driven over real HTTP against a booted
 * service with the SHIPPED checkers type applied. `scriptRunner.run` is
 * stubbed — sandbox execution is darwin-gated; this suite proves the
 * route contract (allowlist, bind merge, `page` trigger, reaction) on
 * every platform.
 */

let svc: RunningService;
let baseUrl: string;
let token: string;
let home: string;
let httpFetch: typeof fetch;
let projectId: string;
let coachGezelId: string;
let runStub: ReturnType<typeof vi.fn>;

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

beforeAll(async () => {
  process.env.GEZEL_MOCK_PROVIDER = '1';
  home = await mkdtemp(join(tmpdir(), 'gezel-page-invoke-'));
  svc = await startService({ home });
  const scheme = svc.cert ? 'https' : 'http';
  baseUrl = `${scheme}://127.0.0.1:${svc.port}`;
  token = svc.context.token;
  httpFetch = svc.cert ? createTrustingFetch({ cert: svc.cert.certPem }) : fetch;

  const project = await svc.context.store.createProject({ name: 'Bridge Game' });
  projectId = project.id;
  const applied = await applyProjectType(
    { store: svc.context.store, catalog: svc.context.catalog, home },
    { projectId, typeId: 'checkers' },
  );
  coachGezelId = applied.gezelsCreated[0]!.id;

  runStub = vi.fn(async (opts?: { inputs?: Record<string, unknown> }) => {
    // Match the failure to the invocation itself. A one-shot mock is racy
    // here because this replaces the service-wide runner and background
    // service work can otherwise consume the next implementation first.
    if (
      opts?.inputs?.action === 'user_move' &&
      opts.inputs.from === 'c3' &&
      opts.inputs.to === 'c4'
    ) {
      return {
        ...okRun({}),
        status: 'error' as const,
        error: 'Illegal move c3-c4. Legal moves: c3-d4',
      };
    }
    return okRun({ lastMove: 'c3-d4', board: 'ascii', status: 'playing' });
  });
  svc.context.scriptRunner.run = runStub as unknown as typeof svc.context.scriptRunner.run;
}, 60_000);

afterAll(async () => {
  await svc.stop();
  await rm(home, { recursive: true, force: true }).catch(() => {});
  if (priorMockFlag === undefined) delete process.env.GEZEL_MOCK_PROVIDER;
  else process.env.GEZEL_MOCK_PROVIDER = priorMockFlag;
}, 30_000);

function invoke(body: unknown, opts: { auth?: boolean; project?: string } = {}) {
  return httpFetch(`${baseUrl}/api/projects/${opts.project ?? projectId}/page-invoke`, {
    method: 'POST',
    headers: {
      ...(opts.auth === false ? {} : { Authorization: `Bearer ${token}` }),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

describe('POST /api/projects/:id/page-invoke', () => {
  it('rejects unauthenticated callers', async () => {
    const res = await invoke({ tool: 'user_move' }, { auth: false });
    expect(res.status).toBe(401);
  });

  it('404s an unknown tool and an untyped project', async () => {
    expect((await invoke({ tool: 'ghost_tool' })).status).toBe(404);
    const plain = await svc.context.store.createProject({ name: 'Plain' });
    expect((await invoke({ tool: 'user_move' }, { project: plain.id })).status).toBe(404);
  });

  it('403s a declared tool that is not page-listed (the model surface)', async () => {
    const res = await invoke({ tool: 'get_board' });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toContain('not exposed to pages');
    expect(runStub).not.toHaveBeenCalled();
  });

  it('runs a page tool with bind merged over input and the page trigger', async () => {
    const res = await invoke({
      tool: 'user_move',
      input: { from: 'c3', to: 'd4', action: 'spoof' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; reaction?: { delivered: boolean } };
    expect(body.status).toBe('ok');

    expect(runStub).toHaveBeenCalledTimes(1);
    const args = runStub.mock.calls[0]?.[0] as {
      scriptName: string;
      inputs: Record<string, unknown>;
      trigger: { kind: string; tool: string };
      timeoutMs: number;
    };
    expect(args.scriptName).toBe('game-store');
    // bind wins over a page-supplied value for the same key.
    expect(args.inputs).toEqual({ from: 'c3', to: 'd4', action: 'user_move' });
    expect(args.trigger).toEqual({ kind: 'page', tool: 'user_move' });
    expect(args.timeoutMs).toBe(30_000);
  });

  it('fires the declared reaction into the Damspeler session on success', async () => {
    const res = await invoke({ tool: 'user_move', input: { from: 'c3', to: 'd4' } });
    const body = (await res.json()) as {
      reaction?: { delivered: boolean; gezelId?: string };
    };
    expect(body.reaction?.delivered).toBe(true);
    expect(body.reaction?.gezelId).toBe(coachGezelId);

    // The seed lands in the player's live project session (send is
    // backgrounded — poll briefly).
    const seedSeen = await vi.waitFor(
      async () => {
        const sessions = await svc.context.store.listSessions({
          gezelId: coachGezelId,
          projectId,
        });
        expect(sessions.length).toBeGreaterThan(0);
        const record = await svc.context.store.getSession(coachGezelId, sessions[0]!.id);
        const seed = record?.messages.find(
          (m) => m.role === 'user' && m.content.startsWith('[Checkers page]:'),
        );
        expect(seed).toBeDefined();
        return seed!.content;
      },
      { timeout: 15_000, interval: 50 },
    );
    expect(seedSeen).toContain('c3-d4');
  });

  it('does not fire a reaction for a tool without one', async () => {
    runStub.mockClear();
    const res = await invoke({ tool: 'new_game' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { reaction?: unknown };
    expect(body.reaction).toBeUndefined();
  });

  it('reports a failed script run as a 200 run-report with the error text intact', async () => {
    // A 5xx here would route through the opaque-error sanitizer and destroy
    // the instructive error the page (and, via the same contract on
    // /scripts/run, the model) depends on.
    const res = await invoke({ tool: 'user_move', input: { from: 'c3', to: 'c4' } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; error?: string; reaction?: unknown };
    expect(body.status).toBe('error');
    expect(body.error).toContain('Illegal move');
    expect(body.reaction).toBeUndefined();
  });

  it("400s input that violates the tool's declared schema, before any run", async () => {
    runStub.mockClear();
    // checkers user_move declares { from: string, to: string } — a number is
    // a type violation the route must reject without dispatching.
    const res = await invoke({ tool: 'user_move', input: { from: 5, to: 'd4' } });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('input does not match tool schema');
    expect(body.error).toContain('/from');
    expect(runStub).not.toHaveBeenCalled();
  });

  it('rate-limits runaway pages', async () => {
    let limited = false;
    for (let i = 0; i < 130 && !limited; i += 1) {
      const res = await invoke({ tool: 'new_game' });
      if (res.status === 429) limited = true;
    }
    expect(limited).toBe(true);
  });
});
