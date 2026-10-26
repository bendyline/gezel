import type { HistoryEvent, Task, TaskCraftbookStep } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { gateHistoryEvidence } from './gate-history.js';

const task = {
  ref: 'p/1',
  projectId: 'p',
  createdAt: '2026-10-22T10:00:00.000Z',
} as unknown as Task;

/** The step's current pass began after the research happened on an earlier step. */
const step = {
  id: 'write',
  lastActivatedAt: '2026-10-22T10:30:00.000Z',
} as unknown as TaskCraftbookStep;

const events: HistoryEvent[] = [
  {
    id: 'e1',
    at: '2026-10-22T10:10:00.000Z',
    kind: 'tool.called',
    details: {
      name: 'read_file',
      success: true,
      path: 'source/brief.md',
      taskRef: 'p/1',
      stepId: 'research',
    },
  } as unknown as HistoryEvent,
  {
    id: 'e2',
    at: '2026-10-22T10:20:00.000Z',
    kind: 'workspace.script.run',
    details: { name: 'test', args: [], exitCode: 0, taskRef: 'p/1', stepId: 'verify' },
  } as unknown as HistoryEvent,
  {
    id: 'e3',
    at: '2026-10-22T10:25:00.000Z',
    kind: 'tool.called',
    details: {
      name: 'read_file',
      success: true,
      path: 'source/brief.md',
      taskRef: 'p/2',
      stepId: 'write',
    },
  } as unknown as HistoryEvent,
];

const history = {
  listEvents: async (q: { kinds?: string[]; from?: string }) =>
    events.filter((e) => (!q.kinds || q.kinds.includes(e.kind)) && (!q.from || e.at >= q.from)),
} as unknown as Parameters<typeof gateHistoryEvidence>[0];

const ws = { read: async () => null, list: async () => [] } as unknown as Parameters<
  typeof gateHistoryEvidence
>[4];

describe('gateHistoryEvidence window', () => {
  it('counts only the current pass by default, so an earlier step’s read is invisible', async () => {
    const deps = gateHistoryEvidence(history, 'p', task, step, ws);
    const r = await deps.researchEvidence!({
      sourcePath: 'source/brief.md',
      tools: ['web_search'],
      minSuccessful: 1,
    });
    expect(r.matches).toEqual([]);
  });

  it('counts the whole task under window "task", and only this task', async () => {
    const deps = gateHistoryEvidence(history, 'p', task, step, ws);
    const r = await deps.researchEvidence!({
      sourcePath: 'source/brief.md',
      tools: ['web_search'],
      minSuccessful: 1,
      window: 'task',
    });
    expect(r.matches.map((m) => m.at)).toEqual(['2026-10-22T10:10:00.000Z']);
  });

  it('finds a command run from another step under window "task"', async () => {
    const deps = gateHistoryEvidence(history, 'p', task, step, ws);
    const stepOnly = await deps.commandEvidence!({
      scope: 'script',
      name: 'test',
      args: [],
      minRuns: 1,
    });
    expect(stepOnly.runs).toEqual([]);
    const taskWide = await deps.commandEvidence!({
      scope: 'script',
      name: 'test',
      args: [],
      minRuns: 1,
      window: 'task',
    });
    expect(taskWide.runs.map((r) => r.exitCode)).toEqual([0]);
  });

  it('keeps a run from an earlier pass of the same step after a self-loop rejection', async () => {
    const verify = {
      id: 'verify',
      lastActivatedAt: '2026-10-22T10:30:00.000Z',
      evidenceSince: '2026-10-22T10:15:00.000Z',
    } as unknown as TaskCraftbookStep;
    const deps = gateHistoryEvidence(history, 'p', task, verify, ws);
    const r = await deps.commandEvidence!({ scope: 'script', name: 'test', args: [], minRuns: 1 });
    expect(r.runs.map((run) => run.at)).toEqual(['2026-10-22T10:20:00.000Z']);
  });
});
