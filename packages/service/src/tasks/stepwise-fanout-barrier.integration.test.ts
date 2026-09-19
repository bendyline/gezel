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
  const home = await mkdtemp(join(tmpdir(), 'gezel-stepwise-fanout-'));
  svc = await startService({ home });
  await svc.context.store.writeConfig({ generalistMode: 'off' });
}, 30_000);

afterAll(async () => {
  await svc.context.chat.drainBackground().catch(() => {});
  await svc.stop();
  await rm(svc.context.home, { recursive: true, force: true }).catch(() => {});
  delete process.env.GEZEL_MOCK_PROVIDER;
}, 30_000);

/**
 * A create-time fanout host the way the eval harness and an ad-hoc
 * `create_task` build one: a task-level assignee, plain steps with no
 * binding of their own. In stepwise mode nothing pins the steps, so the
 * barrier release used to resolve no owner and drop the host's turn on the
 * floor; the host then sat idle until the stall sweep messaged it eight
 * minutes later (every stepwise fanout cell of the 2026-09 campaign).
 */
describe('create-time fanout under stepwise mode', () => {
  it('re-dispatches the host to its task-level assignee when the last child settles', async () => {
    const { store, tasks, chat, taskRunner } = svc.context;
    const project = await store.createProject({ name: 'Tally Office' });
    const worker = await store.createGezel({ name: 'Tally Clerk', role: 'Researcher' });

    const task = await tasks.create(project.id, {
      title: 'Sum the shards',
      description: 'Fan out one child per shard, then merge the results.',
      assignee: { kind: 'gezel', gezelId: worker.id },
      createdBy: { kind: 'user' },
      steps: [
        {
          id: 'merge',
          name: 'Merge the tally',
          prompt: 'Read every results file and write tally.json, then call advance_task_step.',
          terminal: true,
        },
      ],
      entryStepId: 'merge',
      spawnsSteps: [
        {
          id: 'sum',
          name: 'Sum shard {{shard}}',
          prompt: 'Compute the shard total and write results/{{shard}}.json.',
          terminal: true,
        },
      ],
      fanout: {
        count: 2,
        variations: [
          { title: 'Sum shard 1', context: { shard: '1' } },
          { title: 'Sum shard 2', context: { shard: '2' } },
        ],
      },
    } as never);
    expect(task.executionMode).toBe('stepwise');
    const merge = task.craftbook.steps.find((s) => s.id === 'merge')!;
    // The condition under test: the step itself names nobody.
    expect(merge.assignee).toBeUndefined();
    expect(merge.suggestedGezelId).toBeUndefined();

    const children = await tasks.listChildren(task.ref);
    expect(children).toHaveLength(2);
    for (const child of children) {
      const settled = await tasks.setStatus(project.id, child.num, 'complete');
      expect(settled.status, `child ${child.ref}`).toBe('complete');
    }
    // The last settle released the barrier: the host's own step is queued
    // for its assignee instead of waiting for the stall sweep.
    expect(taskRunner.hasHandoffFor(task.ref, 'merge')).toBe(true);

    await taskRunner.tick();
    await chat.drainBackground();
    await vi.waitFor(
      async () => {
        const hostSessions = (await store.listSessions({ projectId: project.id })).filter(
          (s) => s.taskRef === task.ref,
        );
        expect(hostSessions.length).toBeGreaterThan(0);
        expect(hostSessions[0]!.gezelId).toBe(worker.id);
        const record = await store.getSession(worker.id, hostSessions[0]!.id);
        expect(record?.messages.some((m) => m.role === 'user')).toBe(true);
      },
      { timeout: 20_000, interval: 250 },
    );
  }, 60_000);
});
