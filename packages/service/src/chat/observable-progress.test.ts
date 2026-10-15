import {
  type ChatMessageToolCall,
  type ChatSession,
  type Task,
  writeTaskNoteText,
} from '@bendyline/gezel';
import { describe, expect, it, vi } from 'vitest';
import type { Store } from '../fs/store.js';
import {
  type DeliverableGateDeps,
  maybeAutoAdvanceOnObservableProgress,
} from './observable-progress.js';

function fixture() {
  const note = {
    id: 'note-1',
    at: '2026-10-09T21:06:04.076Z',
    author: { kind: 'gezel' as const, gezelId: 'worker', name: 'Worker' },
    stepId: 'finish',
    text: 'The requested work and verification are complete.',
  };
  const task = {
    projectId: 'example',
    num: 1,
    ref: 'example/1',
    status: 'active',
    activeStepId: 'finish',
    assignee: { kind: 'gezel', gezelId: 'worker' },
    craftbook: {
      steps: [
        {
          id: 'finish',
          name: 'Finish',
          terminal: true,
          toolPolicy: { outputMedium: 'task-note' },
          lastActivatedAt: '2026-10-09T21:05:00.000Z',
        },
      ],
    },
  } as Task;
  const record = {
    id: 'session',
    gezelId: 'worker',
    projectId: 'example',
    taskRef: task.ref,
    stepId: 'finish',
    stepActivationId: '2026-10-09T21:05:00.000Z',
  } as ChatSession;
  const calls: ChatMessageToolCall[] = [
    {
      name: 'write_task_note',
      success: true,
      at: '2026-10-09T21:06:04.071Z',
      durationMs: 5,
      resultText: writeTaskNoteText(task.ref, 'finish', note),
    },
  ];
  const listNotes = vi.fn().mockResolvedValue([note]);
  const advance = vi.fn().mockResolvedValue({ status: 'advanced' });
  const deps: DeliverableGateDeps = {
    store: { listTaskNotes: listNotes, listProjectTasks: async () => [task] } as unknown as Store,
    taskAdvancer: advance,
    readEffectiveTask: async () => task,
    liveRecord: () => record,
  };
  return {
    note,
    task,
    record,
    calls,
    deps,
    advance,
    listNotes,
    run: () => maybeAutoAdvanceOnObservableProgress(deps, { record }, calls, record.id),
  };
}

describe('terminal task-note completion', () => {
  it('completes from the persisted note receipt without another model turn', async () => {
    const f = fixture();
    await expect(f.run()).resolves.toEqual({ autoAdvanced: true });
    expect(f.listNotes).toHaveBeenCalledWith('example', 1, 'finish');
    expect(f.advance).toHaveBeenCalledWith('example', 1, 'finish');
  });

  it.each([
    'failed-write',
    'read-only',
    'no-write',
    'missing-note',
    'wrong-task',
    'wrong-step',
    'wrong-author',
    'stale-session',
    'unscoped',
    'nonterminal',
    'undeclared-output',
    'multiple-outputs',
    'paused',
    'user-owned',
  ])('does not auto-complete on %s evidence', async (condition) => {
    const f = fixture();
    const step = f.task.craftbook.steps[0]!;
    if (condition === 'failed-write') f.calls[0]!.success = false;
    if (condition === 'read-only') f.calls[0]!.name = 'read_task_notes';
    if (condition === 'no-write') f.calls.length = 0;
    if (condition === 'missing-note') f.listNotes.mockResolvedValue([]);
    if (condition === 'wrong-task')
      f.calls[0]!.resultText = writeTaskNoteText('example/2', 'finish', f.note);
    if (condition === 'wrong-step') f.note.stepId = 'earlier';
    if (condition === 'wrong-author') f.note.author.gezelId = 'someone-else';
    if (condition === 'stale-session') f.record.stepActivationId = '2026-10-09T20:00:00.000Z';
    if (condition === 'unscoped') delete f.record.taskRef;
    if (condition === 'nonterminal') step.terminal = false;
    if (condition === 'undeclared-output') delete step.toolPolicy;
    if (condition === 'multiple-outputs') step.toolPolicy!.additionalOutputMedia = ['artifact'];
    if (condition === 'paused') f.task.status = 'paused';
    if (condition === 'user-owned') step.assignee = { kind: 'user' };
    // A turn that saved no note at all is reported for the save-it re-prompt.
    const unsaved = ['failed-write', 'read-only', 'no-write'].includes(condition);
    await expect(f.run()).resolves.toEqual(
      unsaved ? { unmetTaskNote: { taskRef: 'example/1', stepId: 'finish' } } : {},
    );
    expect(f.advance).not.toHaveBeenCalled();
  });

  it('reports a non-terminal note step that ended with its result only in the reply', async () => {
    const f = fixture();
    f.task.craftbook.steps[0]!.terminal = false;
    f.calls.length = 0;
    await expect(f.run()).resolves.toEqual({
      unmetTaskNote: { taskRef: 'example/1', stepId: 'finish' },
    });
    expect(f.advance).not.toHaveBeenCalled();
  });

  it('returns a completion-gate rejection for the ordinary repair path', async () => {
    const f = fixture();
    f.advance.mockResolvedValue({
      status: 'held',
      message: 'Missing evidence',
      messageFingerprint: 'held',
      attempt: 1,
    });
    await expect(f.run()).resolves.toMatchObject({
      gateRejected: { taskRef: 'example/1', stepId: 'finish', message: 'Missing evidence' },
    });
  });

  it('yields when the completion gate routes back to a repair step', async () => {
    const f = fixture();
    f.advance.mockResolvedValue({
      status: 'held',
      message: 'Repair required',
      messageFingerprint: 'held',
      attempt: 1,
      activeStepId: 'repair',
    });
    await expect(f.run()).resolves.toEqual({ autoAdvanced: true });
  });
});

// A typed project's kickoff finishes when its Output page's data file grows
// past the seed. A lead that ends its turn short of that is reported, so the
// manager can re-prompt it once instead of leaving the first project empty.
describe('growth gate', () => {
  function kickoff(content: string) {
    const task = {
      projectId: 'jobs',
      num: 2,
      ref: 'jobs/2',
      status: 'active',
      activeStepId: 'first-draft',
      assignee: { kind: 'gezel', gezelId: 'coach' },
      craftbook: {
        steps: [
          {
            id: 'first-draft',
            name: 'First draft',
            advanceWhen: { file: 'pipeline.json', minBytes: 200, requireChange: false },
            lastActivatedAt: '2026-10-14T23:00:00.000Z',
          },
        ],
      },
    } as Task;
    const record = {
      id: 'session',
      gezelId: 'coach',
      projectId: 'jobs',
      taskRef: task.ref,
      stepId: 'first-draft',
      stepActivationId: '2026-10-14T23:00:00.000Z',
    } as ChatSession;
    const advance = vi.fn().mockResolvedValue({ status: 'advanced' });
    const deps: DeliverableGateDeps = {
      store: {
        listProjectTasks: async () => [task],
        readProjectWorkspaceFile: async () => content,
      } as unknown as Store,
      taskAdvancer: advance,
      readEffectiveTask: async () => task,
      liveRecord: () => record,
    };
    return {
      advance,
      run: () => maybeAutoAdvanceOnObservableProgress(deps, { record }, [], 'session'),
    };
  }

  it('reports a file still short of its floor', async () => {
    const f = kickoff('{"applications":[]}');
    await expect(f.run()).resolves.toEqual({
      unmetGrowthGate: {
        taskRef: 'jobs/2',
        file: 'pipeline.json',
        reason: expect.stringContaining('below minBytes'),
      },
    });
    expect(f.advance).not.toHaveBeenCalled();
  });

  it('advances once the file has grown', async () => {
    const f = kickoff(`{"applications":[${'"x",'.repeat(60)}"x"]}`);
    await expect(f.run()).resolves.toEqual({ autoAdvanced: true });
  });
});
