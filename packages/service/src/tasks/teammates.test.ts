import type { ChatSession, Task } from '@bendyline/gezel';
import { describe, expect, it, vi } from 'vitest';
import { askTaskTeammate } from './teammates.js';

vi.mock('../gezels/ensure.js', () => ({
  ensureGezel: vi.fn(async ({ opts }: { opts: { jobTitle: string } }) => ({
    gezelId: opts.jobTitle === 'Researcher' ? 'owner' : `${opts.jobTitle.toLowerCase()}-1`,
  })),
}));

const outcomeTask = {
  ref: 'p/4',
  projectId: 'p',
  num: 4,
  craftbook: { renderedAs: 'outcome', steps: [] },
} as unknown as Task;

function deps(task: Task, owner: Partial<ChatSession> | null) {
  const askGezelAndWait = vi.fn(async () => ({
    outcome: 'reply' as const,
    text: 'Wrote tasks/4/sources.md',
    toGezelId: 'reviewer-1',
    toGezelName: 'Rae',
    sessionId: 'helper',
  }));
  return {
    askGezelAndWait,
    deps: {
      store: {
        readTask: async () => task,
        addGezelToProject: async () => undefined,
      },
      catalog: {},
      chat: {
        getSessionRecord: async () => owner,
        askGezelAndWait,
      },
    } as unknown as Parameters<typeof askTaskTeammate>[0],
  };
}

const request = {
  projectId: 'p',
  num: 4,
  fromGezelId: 'owner',
  fromSessionId: 's1',
  role: 'reviewer' as const,
  question: 'Check out/report.md against source/brief.md',
};

describe('askTaskTeammate', () => {
  it('runs the teammate for the task, without making it a task session', async () => {
    const { deps: d, askGezelAndWait } = deps(outcomeTask, {
      id: 's1',
      gezelId: 'owner',
      taskRef: 'p/4',
    });
    const res = await askTaskTeammate(d, request);
    expect(res).toMatchObject({ outcome: 'reply', toGezelName: 'Rae' });
    expect(askGezelAndWait).toHaveBeenCalledWith(
      expect.objectContaining({
        toGezelIdOrName: 'reviewer-1',
        subagentFor: { taskRef: 'p/4', ownerSessionId: 's1' },
      }),
    );
  });

  it('refuses a task that is not an outcome task, or has teammates off', async () => {
    const owner = { id: 's1', gezelId: 'owner', taskRef: 'p/4' };
    const stepwise = { ...outcomeTask, craftbook: { steps: [] } } as unknown as Task;
    expect(await askTaskTeammate(deps(stepwise, owner).deps, request)).toMatchObject({
      outcome: 'error',
      message: expect.stringMatching(/does not hand work to teammates/),
    });
    const solo = { ...outcomeTask, strategyOptions: { subagents: false } } as Task;
    expect((await askTaskTeammate(deps(solo, owner).deps, request)).outcome).toBe('error');
  });

  it('refuses a session that does not work the task, and a teammate asking onward', async () => {
    const other = await askTaskTeammate(
      deps(outcomeTask, { id: 's1', gezelId: 'owner', taskRef: 'p/9' }).deps,
      request,
    );
    expect(other).toMatchObject({
      outcome: 'error',
      message: expect.stringMatching(/Only the session/),
    });
    const helper = await askTaskTeammate(
      deps(outcomeTask, {
        id: 's1',
        gezelId: 'owner',
        subagentFor: { taskRef: 'p/4', ownerSessionId: 's0' },
      }).deps,
      request,
    );
    expect(helper.outcome).toBe('error');
  });

  it('tells an owner who holds the role to do the part itself', async () => {
    const res = await askTaskTeammate(
      deps(outcomeTask, { id: 's1', gezelId: 'owner', taskRef: 'p/4' }).deps,
      { ...request, role: 'researcher' },
    );
    expect(res).toMatchObject({ outcome: 'error', reason: 'self' });
  });
});
