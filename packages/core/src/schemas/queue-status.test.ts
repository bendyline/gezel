import { describe, expect, it } from 'vitest';
import { ProviderQueue } from '../runtime/provider-queue.js';
import {
  ProviderQueueDescriptionSchema,
  ProviderQueueStateSchema,
  QueueStatusResponseSchema,
} from './queue-status.js';

async function busyQueue(): Promise<{ queue: ProviderQueue; releaseAll: () => Promise<void> }> {
  const queue = new ProviderQueue({ concurrency: 1 });
  const release = await queue.acquire({
    lane: 'interactive',
    sessionId: 's-1',
    gezelId: 'g-1',
    provider: 'llama-cpp',
    job: 'chat',
  });
  const waiting = queue.acquire({ lane: 'background', sessionId: 's-2', ambient: true });
  await Promise.resolve();
  return {
    queue,
    releaseAll: async () => {
      release();
      (await waiting)();
    },
  };
}

describe('queue status schemas', () => {
  it('describes a live provider queue with the shared schema', async () => {
    const { queue, releaseAll } = await busyQueue();
    const described = queue.describe();
    expect(ProviderQueueDescriptionSchema.parse(described)).toEqual(described);
    expect(ProviderQueueStateSchema.parse({ ...described, maxConcurrency: 1 })).toMatchObject({
      running: 1,
      queuedBackground: 1,
      maxConcurrency: 1,
    });
    await releaseAll();
  });

  it('accepts a queue state from a broker older than the lane split', () => {
    expect(
      ProviderQueueStateSchema.safeParse({
        running: 0,
        queuedInteractive: 0,
        queuedBackground: 0,
        concurrency: 2,
        active: [],
        pending: [],
      }).success,
    ).toBe(true);
  });

  it('parses a full daemon response', async () => {
    const { queue, releaseAll } = await busyQueue();
    const body = {
      providers: { 'llama-cpp': { ...queue.describe(), maxConcurrency: 1 } },
      taskRunner: {
        pendingCount: 1,
        pendingByGezel: { 'g-1': 1 },
        pendingByProject: { default: 1 },
        dispatchable: { count: 1, byGezel: { 'g-1': 1 } },
        scheduled: { count: 0, byGezel: {} },
        holdReason: 'provider-busy',
        nightShift: { active: false, opensAt: null },
      },
      sessions: [
        {
          sessionId: 's-1',
          providerName: 'llama-cpp',
          depth: 1,
          nextPreview: 'and then?',
          entries: [{ queueId: 'q-1', preview: 'and then?', enqueuedAt: '2026-09-29T00:00:00Z' }],
        },
      ],
      cache: [],
      deviceHealth: { state: 'ok' },
      at: '2026-09-29T00:00:00Z',
    };
    expect(QueueStatusResponseSchema.safeParse(body).success).toBe(true);
    await releaseAll();
  });

  it('parses the subset a phone serves', () => {
    const body = {
      providers: {
        'apple-foundation-models': {
          running: 1,
          runningInteractive: 1,
          runningBackground: 0,
          queuedInteractive: 1,
          queuedBackground: 0,
          ambientHeld: 0,
          concurrency: 1,
          interactiveConcurrency: 1,
          backgroundConcurrency: 1,
          maxConcurrency: 1,
          active: [{ sessionId: 's-1', provider: 'apple-foundation-models', runningForMs: 20 }],
          pending: [{ id: 2, lane: 'interactive', sessionId: 's-2', waitedMs: 5 }],
        },
      },
      taskRunner: { pendingCount: 0, pendingByGezel: {}, pendingByProject: {} },
      sessions: [],
      cache: [],
      at: '2026-09-29T00:00:00Z',
    };
    expect(QueueStatusResponseSchema.safeParse(body).success).toBe(true);
  });

  it('rejects a queue reported for a remote daemon', () => {
    const idle = {
      running: 0,
      queuedInteractive: 0,
      queuedBackground: 0,
      concurrency: 1,
      active: [],
      pending: [],
    };
    expect(ProviderQueueStateSchema.safeParse(idle).success).toBe(true);
    const result = QueueStatusResponseSchema.safeParse({
      providers: { remote: idle },
      taskRunner: { pendingCount: 0, pendingByGezel: {}, pendingByProject: {} },
      sessions: [],
      cache: [],
      at: '2026-09-29T00:00:00Z',
    });
    expect(result.success).toBe(false);
  });
});
