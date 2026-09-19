import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type RunningService, startService } from '../service.js';

// Deterministic, dependency-free embeddings so the memory manager doesn't
// pull a real model (mirrors fanout.integration.test.ts).
vi.mock('../memory/embeddings.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../memory/embeddings.js')>();
  const vectorFor = (text: string): number[] => {
    const vector = new Array<number>(16).fill(0);
    for (let i = 0; i < text.length; i++) vector[i % vector.length]! += text.charCodeAt(i) / 255;
    const magnitude = Math.hypot(...vector) || 1;
    return vector.map((v) => v / magnitude);
  };
  class EmbeddingsDisabledError extends Error {
    readonly code = 'EMBEDDINGS_DISABLED';
  }
  return {
    ...original,
    EmbeddingsDisabledError,
    embeddingsDisabledReason: () => null,
    embed: async (t: string) => vectorFor(t),
    embedQuery: async (t: string) => vectorFor(t),
    embedBatch: async (ts: string[]) => ts.map(vectorFor),
    warmEmbeddings: async () => {},
  };
});

let svc: RunningService;

beforeAll(async () => {
  process.env.GEZEL_MOCK_PROVIDER = '1';
  const home = await mkdtemp(join(tmpdir(), 'gezel-generalist-fanout-'));
  svc = await startService({ home });
  await svc.context.store.writeConfig({ generalistMode: 'on' });
}, 30_000);

afterAll(async () => {
  await svc.context.chat.drainBackground().catch(() => {});
  await svc.stop();
  await rm(svc.context.home, { recursive: true, force: true }).catch(() => {});
  delete process.env.GEZEL_MOCK_PROVIDER;
}, 30_000);

const BILLABLES = [
  {
    client: 'Harbor & Pine Architects',
    number: '2026-042',
    rate: '1840.00',
    work: 'Signage',
    due: '2026-08-15',
  },
  {
    client: 'Kestrel Coffee Roasters',
    number: '2026-043',
    rate: '2600.00',
    work: 'Packaging',
    due: '2026-07-25',
  },
  {
    client: 'Bluestem Community Fund',
    number: '2026-044',
    rate: '975.00',
    work: 'Annual report',
    due: '2026-08-17',
  },
];

describe('declarative fanout under generalist mode', () => {
  it('one owner on every step, children inherit the mode, and the host keeps its session across the barrier', async () => {
    const { store, tasks, chat, taskRunner } = svc.context;
    const project = await store.createProject({ name: 'Fieldnote Office' });

    // Created the way the HTTP route / invoke_craftbook / eval harness do:
    // by craftbookId, no assignee pinned — so generalist mode mints the
    // Generalist and pins it on every step of the main book AND the spawn
    // template.
    const task = await tasks.create(project.id, {
      title: 'Monthly Invoice Run',
      description: 'Run the month invoicing for the seeded client roster and ledger.',
      craftbookId: 'invoice-run',
      createdBy: { kind: 'user' },
    });
    expect(task.executionMode).toBe('generalist');
    expect(task.assignee.kind).toBe('gezel');
    const owner = task.assignee.kind === 'gezel' ? task.assignee.gezelId : '';
    const ownerGezel = await store.getGezel(owner);
    expect(ownerGezel?.role).toBe('Generalist');
    for (const step of task.craftbook.steps) {
      expect(step.assignee, `main step ${step.id}`).toEqual({ kind: 'gezel', gezelId: owner });
      expect(step.suggestedGezelId).toBeUndefined();
    }
    for (const step of task.spawnsCraftbook!.steps) {
      expect(step.assignee, `spawn step ${step.id}`).toEqual({ kind: 'gezel', gezelId: owner });
    }
    // Nobody else was recruited for the role-annotated steps.
    const roster = await store.listGezels();
    expect(
      roster.filter((g) => g.role && /designer|copywriter|reviewer|kantoormeester/i.test(g.role)),
    ).toEqual([]);

    // The owner's task session from the scope step: the one transcript the
    // whole run must keep.
    const hostSession = await chat.createSession({
      gezelId: owner,
      projectId: project.id,
      taskRef: task.ref,
      stepId: 'scope',
    });
    hostSession.messages.push({
      role: 'assistant',
      content: 'Scoped the billables.',
      at: new Date().toISOString(),
    });
    await store.writeSession(hostSession);

    const resolvedSpawn = task.craftbook.spawn;
    if (!resolvedSpawn) throw new Error('spawn host snapshot has no spawn block');
    const billables = JSON.stringify(BILLABLES, null, 2);
    if (resolvedSpawn.overArtifact) {
      await store.writeProjectArtifact(project.id, resolvedSpawn.overFile, billables);
    } else {
      await store.writeProjectWorkspaceFile(project.id, resolvedSpawn.overFile, billables);
    }

    // scope -> draft: activating the spawnFanout step fans out.
    await tasks.completeStep(project.id, task.num, 'scope', 'draft', { force: true });
    const children = await tasks.listChildren(task.ref);
    expect(children.length).toBe(BILLABLES.length);
    for (const child of children) {
      expect(child.executionMode, `child ${child.ref}`).toBe('generalist');
      expect(child.parentTaskRef).toBe(task.ref);
      const entry = child.craftbook.steps.find((s) => s.id === child.activeStepId)!;
      expect(entry.assignee).toEqual({ kind: 'gezel', gezelId: owner });
    }
    // Each child is its own task, hence its own session when dispatched —
    // that is the parallelism generalist mode keeps.
    expect(new Set(children.map((c) => c.ref)).size).toBe(BILLABLES.length);

    // Barrier: the host advanced to `collect` but is held while children are
    // active — its session is untouched (still pinned to scope).
    const held = await tasks.get(project.id, task.num);
    expect(held?.activeStepId).toBe('collect');
    await taskRunner.tick();
    expect((await store.getSession(owner, hostSession.id))?.stepId).toBe('scope');

    // Settle every child; the last one releases the barrier and re-dispatches
    // the host's active step to the SAME owner. Settled by status rather
    // than by completing the step: invoice-run's child step carries no
    // `terminal` flag (the other two spawn books do), so completing it
    // re-activates itself instead of finishing the child.
    for (const child of children) {
      const settled = await tasks.setStatus(project.id, child.num, 'complete');
      expect(settled.status, `child ${child.ref}`).toBe('complete');
    }
    await taskRunner.tick();
    await chat.drainBackground();

    await vi.waitFor(
      async () => {
        const carried = await store.getSession(owner, hostSession.id);
        expect(carried?.stepId).toBe('collect');
      },
      { timeout: 20_000, interval: 250 },
    );
    const hostSessions = (await store.listSessions({ projectId: project.id })).filter(
      (s) => s.taskRef === task.ref,
    );
    expect(hostSessions.map((s) => s.id)).toEqual([hostSession.id]);
  }, 60_000);
});
