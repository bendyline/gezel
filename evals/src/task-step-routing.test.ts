import { describe, expect, it, vi } from 'vitest';
import {
  decideTaskStepDelivery,
  resolveTaskStepDelivery,
  taskStepRouteFor,
} from './task-step-routing.ts';

describe('taskStepRouteFor', () => {
  const task = { ref: 'p/1', projectId: 'p', status: 'active', activeStepId: 'apply' };

  it('routes an active task to its active step', () => {
    expect(taskStepRouteFor(task, 'p')).toEqual({
      projectId: 'p',
      taskRef: 'p/1',
      stepId: 'apply',
    });
  });

  it('keeps routing a paused task into its step session', () => {
    expect(taskStepRouteFor({ ...task, status: 'paused' }, 'p')?.stepId).toBe('apply');
  });

  it('has no route for finished, canceled, draft, or step-less tasks', () => {
    expect(taskStepRouteFor({ ...task, status: 'complete' }, 'p')).toBeUndefined();
    expect(taskStepRouteFor({ ...task, status: 'canceled' }, 'p')).toBeUndefined();
    expect(taskStepRouteFor({ ...task, status: 'draft' }, 'p')).toBeUndefined();
    expect(taskStepRouteFor({ ...task, activeStepId: undefined }, 'p')).toBeUndefined();
  });

  it('marks the route held while the runner has the task on its queue', () => {
    expect(
      taskStepRouteFor(task, 'p', [
        { ref: 'default/1', reason: 'night-shift' },
        { ref: 'p/1', reason: 'provider-busy', stepId: 'apply' },
      ]),
    ).toMatchObject({ runnerHold: 'provider-busy' });
  });
});

describe('decideTaskStepDelivery', () => {
  const route = { projectId: 'p', taskRef: 'p/1', stepId: 'apply' };

  it('picks the most recent non-archived session bound to exactly this step', () => {
    expect(
      decideTaskStepDelivery(route, [
        { id: 'unbound', gezelId: 'runner', projectId: 'p', lastActivityAt: '2026-09-23T21:30Z' },
        {
          id: 'old-step',
          gezelId: 'kwame',
          projectId: 'p',
          taskRef: 'p/1',
          stepId: 'enumerate',
          lastActivityAt: '2026-09-23T21:29Z',
        },
        {
          id: 'apply-archived',
          gezelId: 'eugenio',
          projectId: 'p',
          taskRef: 'p/1',
          stepId: 'apply',
          archived: true,
          lastActivityAt: '2026-09-23T21:28Z',
        },
        {
          id: 'apply-a',
          gezelId: 'eugenio',
          projectId: 'p',
          taskRef: 'p/1',
          stepId: 'apply',
          lastActivityAt: '2026-09-23T21:20Z',
        },
        {
          id: 'apply-b',
          gezelId: 'eugenio',
          projectId: 'p',
          taskRef: 'p/1',
          stepId: 'apply',
          lastActivityAt: '2026-09-23T21:25Z',
        },
      ]),
    ).toEqual({ kind: 'deliver', gezelId: 'eugenio', sessionId: 'apply-b', projectId: 'p' });
  });

  it('falls back to a task session with no step pinned yet, never to another step', () => {
    expect(
      decideTaskStepDelivery(route, [
        {
          id: 'other-step',
          gezelId: 'kwame',
          projectId: 'p',
          taskRef: 'p/1',
          stepId: 'enumerate',
          lastActivityAt: '2026-09-23T21:30Z',
        },
        {
          id: 'unpinned',
          gezelId: 'generalist',
          projectId: 'p',
          taskRef: 'p/1',
          lastActivityAt: '2026-09-23T21:00Z',
        },
      ]),
    ).toMatchObject({ kind: 'deliver', sessionId: 'unpinned' });
  });

  it('holds when only unbound or other-step sessions exist', () => {
    const decision = decideTaskStepDelivery(route, [
      { id: 'unbound', gezelId: 'runner', projectId: 'p' },
      { id: 'other', gezelId: 'kwame', projectId: 'p', taskRef: 'p/1', stepId: 'enumerate' },
      { id: 'other-task', gezelId: 'x', projectId: 'p', taskRef: 'p/2', stepId: 'apply' },
    ]);
    expect(decision).toMatchObject({ kind: 'hold' });
    expect(decision.kind === 'hold' && decision.reason).toContain('no session has started');
  });

  it('holds while the runner holds the handoff even if a step session exists', () => {
    const decision = decideTaskStepDelivery({ ...route, runnerHold: 'dispatching' }, [
      { id: 'apply', gezelId: 'eugenio', projectId: 'p', taskRef: 'p/1', stepId: 'apply' },
    ]);
    expect(decision).toMatchObject({ kind: 'hold' });
    expect(decision.kind === 'hold' && decision.reason).toContain('dispatching');
  });
});

describe('resolveTaskStepDelivery', () => {
  it('lists only the route project and holds when the lookup fails', async () => {
    const listChatSessions = vi.fn().mockRejectedValue(new Error('daemon restarting'));
    const decision = await resolveTaskStepDelivery(
      { listChatSessions },
      { projectId: 'p', taskRef: 'p/1', stepId: 'apply' },
    );
    expect(listChatSessions).toHaveBeenCalledWith({ projectId: 'p' });
    expect(decision).toMatchObject({ kind: 'hold' });
  });

  it('does not list sessions for a runner-held route', async () => {
    const listChatSessions = vi.fn();
    const decision = await resolveTaskStepDelivery(
      { listChatSessions },
      { projectId: 'p', taskRef: 'p/1', stepId: 'apply', runnerHold: 'queued' },
    );
    expect(listChatSessions).not.toHaveBeenCalled();
    expect(decision).toMatchObject({ kind: 'hold' });
  });
});
