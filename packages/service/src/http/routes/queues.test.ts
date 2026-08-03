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

/**
 * The cancel/move routes delegate to ChatManager's pool-aware resolvers
 * (singleton map + engine pool). These tests pin the wiring: the route
 * forwards the parsed (provider, id) and echoes the boolean, so a
 * pool-routed on-device turn — whose queue the old singleton-only path
 * couldn't see — is actually cancelable.
 */
function ctxWithChat(chat: Record<string, unknown>): ServiceContext {
  return { chat } as unknown as ServiceContext;
}

describe('DELETE /api/queues/:provider/:id', () => {
  it('forwards (provider, id) to cancelProviderQueueItem and echoes the result', async () => {
    const calls: Array<[string, number]> = [];
    const ctx = ctxWithChat({
      cancelProviderQueueItem: (name: string, id: number) => {
        calls.push([name, id]);
        return true;
      },
    });

    const response = await queueRoutes(ctx).request('/llama-cpp/7', { method: 'DELETE' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ cancelled: true });
    expect(calls).toEqual([['llama-cpp', 7]]);
  });

  it('returns {cancelled:false} for an unknown id without erroring', async () => {
    const ctx = ctxWithChat({ cancelProviderQueueItem: () => false });
    const response = await queueRoutes(ctx).request('/llama-cpp/999', { method: 'DELETE' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ cancelled: false });
  });

  it('404s an unknown provider and 400s a non-numeric id', async () => {
    const ctx = ctxWithChat({
      cancelProviderQueueItem: () => {
        throw new Error('should not be called');
      },
    });
    expect((await queueRoutes(ctx).request('/nope/1', { method: 'DELETE' })).status).toBe(404);
    expect((await queueRoutes(ctx).request('/llama-cpp/x', { method: 'DELETE' })).status).toBe(400);
  });
});

describe('POST /api/queues/:provider/:id/move', () => {
  it('forwards the direction to moveProviderQueueItem and echoes the result', async () => {
    const calls: Array<[string, number, string]> = [];
    const ctx = ctxWithChat({
      moveProviderQueueItem: (name: string, id: number, direction: string) => {
        calls.push([name, id, direction]);
        return true;
      },
    });

    const response = await queueRoutes(ctx).request('/llama-cpp/7/move', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ direction: 'up' }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ moved: true });
    expect(calls).toEqual([['llama-cpp', 7, 'up']]);
  });

  it('400s a bad direction', async () => {
    const ctx = ctxWithChat({
      moveProviderQueueItem: () => {
        throw new Error('should not be called');
      },
    });
    const response = await queueRoutes(ctx).request('/llama-cpp/7/move', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ direction: 'sideways' }),
    });
    expect(response.status).toBe(400);
  });
});
