import { describe, expect, it } from 'vitest';
import type { ServiceContext } from '../context.js';
import { queueRoutes } from './queues.js';

/**
 * Context with no initialized providers — the shape that matters here is
 * the `taskRunner` block, which the header QueueMeter reads on every poll.
 */
function ctxWith(taskRunner: unknown, nightShift: unknown): ServiceContext {
  return {
    chat: {
      getProviderIfReady: () => null,
      localEngineQueueSummaries: () => [],
      listQueued: () => [],
      getCacheStats: () => [],
      getAnthropicCliPoolSnapshot: async () => null,
    },
    gpuArbiter: { getDeviceHealthStatus: async () => null },
    taskRunner,
    nightShift,
  } as unknown as ServiceContext;
}

describe('GET /api/queues', () => {
  // The QueueMeter splits the runner's queue on these fields: work waiting
  // on the engine is a backlog and gets a header count, work parked for the
  // night window is neither. Both, plus when the window opens, have to
  // survive the trip over the wire.
  it('carries the pending split and the night-shift window', async () => {
    const ctx = ctxWith(
      {
        snapshot: () => ({
          pendingCount: 5,
          pendingByGezel: { wren: 1, koray: 4 },
          pendingByProject: { default: 5 },
          dispatchable: { count: 1, byGezel: { koray: 1 } },
          scheduled: { count: 4, byGezel: { wren: 1, koray: 3 } },
          holdReason: 'provider-busy',
        }),
      },
      { isActive: () => false, nextStartIso: () => '2026-08-02T22:00:00.000Z' },
    );

    const response = await queueRoutes(ctx).request('/');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { taskRunner: Record<string, unknown> };
    expect(body.taskRunner).toMatchObject({
      pendingCount: 5,
      dispatchable: { count: 1, byGezel: { koray: 1 } },
      scheduled: { count: 4, byGezel: { wren: 1, koray: 3 } },
      holdReason: 'provider-busy',
      nightShift: { active: false, opensAt: '2026-08-02T22:00:00.000Z' },
    });
  });

  it('reports a null window when Night Shift is switched off', async () => {
    const ctx = ctxWith(
      {
        snapshot: () => ({
          pendingCount: 0,
          pendingByGezel: {},
          pendingByProject: {},
          dispatchable: { count: 0, byGezel: {} },
          scheduled: { count: 0, byGezel: {} },
        }),
      },
      { isActive: () => false, nextStartIso: () => null },
    );

    const response = await queueRoutes(ctx).request('/');
    const body = (await response.json()) as { taskRunner: { nightShift: unknown } };
    expect(body.taskRunner.nightShift).toEqual({ active: false, opensAt: null });
  });
});
