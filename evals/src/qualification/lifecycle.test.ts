import type { GezelClient } from '@bendyline/gezel-client/node';
import { describe, expect, it, vi } from 'vitest';
import type { EvalContext, EvalScenario } from '../types.ts';
import { checkFinalArtifact } from './final-artifact.ts';
import { observeLifecycle, readLifecycle } from './lifecycle.ts';

function client(overrides: Record<string, unknown> = {}): GezelClient {
  return {
    listTasks: async () => ({ tasks: [{ ref: '1', status: 'complete' }] }),
    listInflightTurns: async () => ({ inflight: [] }),
    listQuestions: async () => ({ questions: [{ id: 'info', intent: { kind: 'task-finished' } }] }),
    listChatSessions: async () => ({ sessions: [{ id: 'worker' }] }),
    getChatSession: async () => ({
      messages: [
        { role: 'user', content: 'Work' },
        { role: 'assistant', content: 'Done.' },
      ],
    }),
    ...overrides,
  } as unknown as GezelClient;
}

describe('natural completion', () => {
  it('records pre-existing service jobs without waiting for them to finish', async () => {
    const observed = client({
      listTasks: async () => ({
        tasks: [
          { ref: 'bootstrap/1', status: 'active' },
          { ref: 'scenario/1', status: 'complete' },
        ],
      }),
    });
    const result = await readLifecycle(observed, ['bootstrap/1']);
    expect(result.status).toBe('complete');
    expect(result.tasks).toEqual([{ ref: 'scenario/1', status: 'complete' }]);
    expect(result.ignoredTasks).toEqual([{ ref: 'bootstrap/1', status: 'active' }]);
    expect((await readLifecycle(observed)).status).toBe('incomplete');
  });

  it('still waits for newly created work and all in-flight turns with a baseline', async () => {
    const result = await readLifecycle(
      client({
        listTasks: async () => ({
          tasks: [
            { ref: 'bootstrap/1', status: 'active' },
            { ref: 'scenario/1', status: 'active' },
          ],
        }),
      }),
      ['bootstrap/1'],
    );
    expect(result.status).toBe('incomplete');
    const inflight = await readLifecycle(
      client({
        listInflightTurns: async () => ({ inflight: [{ sessionId: 'background' }] }),
      }),
      ['bootstrap/1'],
    );
    expect(inflight.status).toBe('incomplete');
  });
  it('requires settled completion, while ignoring informational finished cards', async () => {
    const listTasks = vi.fn(async () => ({ tasks: [{ ref: '1', status: 'complete' }] }));
    const result = await observeLifecycle({
      client: client({ listTasks }),
      timeoutMs: 100,
      intervalMs: 1,
    });
    expect(result.status).toBe('complete');
    expect(result.completionClaim).toBe('supported');
    expect(listTasks).toHaveBeenCalledTimes(2);
  });
  it.each([
    { listTasks: async () => ({ tasks: [{ ref: '1', status: 'running' }] }) },
    { listInflightTurns: async () => ({ inflight: [{ sessionId: 'worker' }] }) },
    {
      listQuestions: async () => ({
        questions: [{ id: 'approval', intent: { kind: 'command-approval' } }],
      }),
    },
    {
      getChatSession: async () => ({
        messages: [
          { role: 'user', content: 'Work' },
          { role: 'assistant', content: 'May I proceed?' },
        ],
      }),
    },
  ])('does not call an unfinished lifecycle complete', async (overrides) => {
    expect((await readLifecycle(client(overrides))).status).toBe('incomplete');
  });
  it('observes settled task completion even when artifact checks failed', async () => {
    const result = await observeLifecycle({
      client: client(),
      artifactSuccess: false,
      timeoutMs: 100,
      intervalMs: 1,
    });
    expect(result).toMatchObject({
      status: 'complete',
      tasks: [{ ref: '1', status: 'complete' }],
      completionClaim: 'unverified',
    });
  });
  it('bounds failed-trial observation without another full execution window', async () => {
    vi.useFakeTimers();
    try {
      const pending = observeLifecycle({
        client: client({ listTasks: () => new Promise(() => {}) }),
        artifactSuccess: false,
        timeoutMs: 120_000,
      });
      await vi.advanceTimersByTimeAsync(5100);
      expect(await pending).toMatchObject({ status: 'unobservable' });
    } finally {
      vi.useRealTimers();
    }
  });
  it('bounds a hung observer and honors interruption during a hung read', async () => {
    const hung = client({ listTasks: () => new Promise(() => {}) });
    expect((await observeLifecycle({ client: hung, timeoutMs: 10 })).status).toBe('unobservable');
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 5);
    const result = await observeLifecycle({ client: hung, timeoutMs: 1000, signal: ac.signal });
    expect(result.status).toBe('interrupted');
    expect(result.waitedMs).toBeLessThan(500);
  });
  it('preserves final artifact regressions and fails closed on a hung grader', async () => {
    const ctx = {} as EvalContext;
    const scenario = {
      id: 'test',
      description: 'test',
      prompt: 'test',
      successCheck: async () => ({ done: true, success: false, reason: 'changed output' }),
    } as EvalScenario;
    expect(await checkFinalArtifact(scenario, ctx)).toMatchObject({ done: true, success: false });
    scenario.successCheck = () => new Promise(() => {});
    expect(await checkFinalArtifact(scenario, ctx, 5)).toMatchObject({
      reason: expect.stringContaining('grader unavailable'),
    });
  });
});
