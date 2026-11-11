import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Task } from '@bendyline/gezel';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type RunningService, startService } from '../service.js';
import { retryPausedTask } from './retry.js';

// Deterministic, dependency-free embeddings so the memory manager doesn't
// pull a real model (mirrors fanout.integration.test.ts).
vi.mock('@bendyline/gezel-inference/internal/memory/embeddings', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('@bendyline/gezel-inference/internal/memory/embeddings')>();
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
  const home = await mkdtemp(join(tmpdir(), 'gezel-fanout-paused-crew-'));
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
 * A host waiting on three invoice shards. The shards' steps belong to the
 * person, so nothing dispatches them and each test moves them by hand.
 */
async function invoiceRun(name: string): Promise<{ host: Task; shards: Task[] }> {
  const { store, tasks } = svc.context;
  const project = await store.createProject({ name });
  const lead = await store.createGezel({ name: `${name} Lead`, role: 'Researcher' });
  const numbers = ['2026-042', '2026-043', '2026-044'];
  const host = await tasks.create(project.id, {
    title: 'Monthly Invoice Run',
    description: 'Fan out one shard per invoice, then collect the invoices.',
    assignee: { kind: 'gezel', gezelId: lead.id },
    createdBy: { kind: 'user' },
    steps: [
      {
        id: 'collect',
        name: 'Collect the invoices',
        prompt: 'Read every invoice and write the run summary, then call advance_task_step.',
        terminal: true,
      },
    ],
    entryStepId: 'collect',
    spawnsSteps: [
      {
        id: 'draft',
        name: 'Draft invoice {{number}}',
        prompt: 'Write invoices/{{number}}.html.',
        terminal: true,
        assignee: { kind: 'user' },
      },
    ],
    fanout: {
      count: numbers.length,
      variations: numbers.map((number) => ({ title: `Invoice ${number}`, context: { number } })),
    },
  } as never);
  const shards = (await tasks.listChildren(host.ref)).sort((a, b) => a.num - b.num);
  expect(shards).toHaveLength(numbers.length);
  return { host, shards };
}

async function pausedCards(projectId: string, taskRef: string) {
  return (await svc.context.store.listProjectQuestions(projectId)).filter(
    (q) => q.intent?.kind === 'task-paused' && q.intent.taskRef === taskRef && !q.answer,
  );
}

describe('a fanout host whose crew stopped', () => {
  it('pauses for help naming the shard that paused once no sibling is still working', async () => {
    const { tasks, taskRunner } = svc.context;
    const { host, shards } = await invoiceRun('Paused last');
    const [first, second, stuck] = shards as [Task, Task, Task];

    await tasks.setStatus(host.projectId, first.num, 'complete');
    await tasks.setStatus(host.projectId, second.num, 'complete');
    expect((await tasks.get(host.projectId, host.num))?.status).toBe('active');

    await tasks.setStatus(host.projectId, stuck.num, 'paused');

    expect((await tasks.get(host.projectId, host.num))?.status).toBe('paused');
    expect(taskRunner.hasHandoffFor(host.ref, 'collect')).toBe(false);
    const notes = await tasks.listNotes(host.projectId, host.num);
    expect(notes.at(-1)?.text).toContain(`\`${stuck.ref}\` "Invoice 2026-044"`);
    expect(notes.at(-1)?.text).not.toContain(first.ref);
    expect(await pausedCards(host.projectId, host.ref)).toHaveLength(1);
  }, 60_000);

  it('pauses when the last working sibling settles after a shard already paused', async () => {
    const { tasks, taskRunner } = svc.context;
    const { host, shards } = await invoiceRun('Paused first');
    const [stuck, second, third] = shards as [Task, Task, Task];

    // Siblings are still working: the barrier just keeps waiting.
    await tasks.setStatus(host.projectId, stuck.num, 'paused');
    expect((await tasks.get(host.projectId, host.num))?.status).toBe('active');

    await tasks.setStatus(host.projectId, second.num, 'complete');
    await tasks.setStatus(host.projectId, third.num, 'complete');

    expect((await tasks.get(host.projectId, host.num))?.status).toBe('paused');
    expect(taskRunner.hasHandoffFor(host.ref, 'collect')).toBe(false);
    expect(await pausedCards(host.projectId, host.ref)).toHaveLength(1);
  }, 60_000);

  it('Try again restarts the paused shard and keeps the host at the barrier until it settles', async () => {
    const { tasks, taskRunner } = svc.context;
    const { host, shards } = await invoiceRun('Try again');
    const [first, second, stuck] = shards as [Task, Task, Task];
    await tasks.setStatus(host.projectId, first.num, 'complete');
    await tasks.setStatus(host.projectId, second.num, 'complete');
    await tasks.setStatus(host.projectId, stuck.num, 'paused');
    expect((await tasks.get(host.projectId, host.num))?.status).toBe('paused');

    await retryPausedTask(svc.context, host.projectId, host.num);

    expect((await tasks.get(host.projectId, stuck.num))?.status).toBe('active');
    expect((await tasks.get(host.projectId, host.num))?.status).toBe('active');
    expect(taskRunner.hasHandoffFor(host.ref, 'collect')).toBe(false);
    expect(await pausedCards(host.projectId, host.ref)).toHaveLength(0);

    await tasks.setStatus(host.projectId, stuck.num, 'complete');
    expect(taskRunner.hasHandoffFor(host.ref, 'collect')).toBe(true);
  }, 60_000);

  it('Try again on the shard itself resumes the host that was waiting on it', async () => {
    const { tasks, taskRunner } = svc.context;
    const { host, shards } = await invoiceRun('Shard retry');
    const [first, second, stuck] = shards as [Task, Task, Task];
    await tasks.setStatus(host.projectId, first.num, 'complete');
    await tasks.setStatus(host.projectId, second.num, 'complete');
    await tasks.setStatus(host.projectId, stuck.num, 'paused');
    expect((await tasks.get(host.projectId, host.num))?.status).toBe('paused');

    await retryPausedTask(svc.context, host.projectId, stuck.num);

    const shard = await tasks.get(host.projectId, stuck.num);
    expect(shard?.status).toBe('active');
    expect(shard?.effectiveStatus).toBe('active');
    expect((await tasks.get(host.projectId, host.num))?.status).toBe('active');
    expect(taskRunner.hasHandoffFor(host.ref, 'collect')).toBe(false);
  }, 60_000);
});
