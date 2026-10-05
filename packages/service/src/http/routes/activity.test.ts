import type { ActivityStatusResponse } from '@bendyline/gezel';
import { describe, expect, it, vi } from 'vitest';
import type { ServiceContext } from '../context.js';
import { activityRoutes } from './activity.js';

function context(): ServiceContext {
  return {
    tasks: { list: async () => [] },
    store: {
      listAllPendingQuestions: async () => [
        {
          id: 'q1',
          projectId: 'shop',
          gezelId: 'maya',
          sessionId: 's1',
          prompt: 'Which offer?',
          createdAt: '2026-10-02T12:00:00Z',
        },
      ],
      listProjects: async () => [],
    },
    chat: {
      getProviderIfReady: () => null,
      localEngineQueueSummaries: () => [],
      listQueued: () => [],
      getCacheStats: () => [],
      getAnthropicCliPoolSnapshot: async () => null,
      listInflight: () => [],
    },
    gpuArbiter: { getDeviceHealthStatus: async () => null },
    taskRunner: {
      snapshot: () => ({ pendingCount: 0, pendingByGezel: {}, pendingByProject: {} }),
      waitingStates: () => [],
    },
    nightShift: { isActive: () => false, nextStartIso: () => null, quotaHoldStatus: () => null },
  } as unknown as ServiceContext;
}

describe('GET /api/activity', () => {
  it('joins product questions and runtime queues in the user daemon', async () => {
    const response = await activityRoutes(context()).request('/');
    expect(response.status).toBe(200);
    const body = (await response.json()) as ActivityStatusResponse;
    expect(body.items).toMatchObject([
      { id: 'session:s1', section: 'needs-you', questionIds: ['q1'] },
    ]);
    expect(body.questions).toHaveLength(1);
    expect(body.queues.providers).toEqual({});
    expect(body.at).toBe(body.queues.at);
  });
  it('does not report a false all-quiet snapshot when one source fails', async () => {
    const ctx = context();
    ctx.store.listAllPendingQuestions = vi.fn().mockRejectedValue(new Error('read failed'));
    const app = activityRoutes(ctx);
    app.onError((_error, c) => c.json({ error: 'unavailable' }, 503));
    expect((await app.request('/')).status).toBe(503);
  });
  it('fails the overview when a required engine broker is unavailable', async () => {
    const ctx = context();
    ctx.machineEngine = {
      isConnected: () => true,
      isRequired: () => true,
      proxy: vi.fn().mockResolvedValue(new Response('offline', { status: 503 })),
    } as unknown as ServiceContext['machineEngine'];
    const app = activityRoutes(ctx);
    app.onError((_error, c) => c.json({ error: 'unavailable' }, 503));
    expect((await app.request('/')).status).toBe(503);
    const [request, prefix, target] = vi.mocked(ctx.machineEngine!.proxy).mock.calls[0]!;
    expect(new URL(request.url).pathname).toBe('/api/queues');
    expect(prefix).toBe('/api/queues');
    expect(target).toBe('/v1/remote/manage/queues');
    expect(await request.text()).toBe('');
  });
});
