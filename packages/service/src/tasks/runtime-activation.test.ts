import type { Task, TaskCraftbookStep } from '@bendyline/gezel';
import { describe, expect, it, vi } from 'vitest';
import {
  type RuntimeActivationDeps,
  runActivationGate,
  runSpawnFanout,
} from './runtime-activation.js';

function step(partial: Partial<TaskCraftbookStep> = {}): TaskCraftbookStep {
  return { id: 'review', name: 'Review', next: 'ship', ...partial } as TaskCraftbookStep;
}

function task(steps: TaskCraftbookStep[], partial: Partial<Task> = {}): Task {
  return {
    ref: 'p/1',
    num: 1,
    projectId: 'p',
    assignee: { kind: 'user' },
    craftbook: { id: 'book', entryStepId: 'build', steps },
    ...partial,
  } as unknown as Task;
}

function deps(files: Record<string, string> = {}) {
  const tasks = {
    gateWorkspaceReader: vi.fn(() => ({
      read: async (f: string) => files[f] ?? null,
      list: async () => Object.keys(files),
    })),
    completeStep: vi.fn(async () => undefined),
    appendNote: vi.fn(async () => undefined),
    setStatus: vi.fn(async () => undefined),
    listChildren: vi.fn(async () => []),
    spawnChild: vi.fn(async () => undefined),
  };
  const d = {
    store: {
      getProject: vi.fn(async () => null),
      readConfig: vi.fn(async () => ({})),
    },
    tasks,
    scriptRunner: { run: vi.fn() },
    history: { log: vi.fn(async () => undefined) },
  };
  return { d: d as unknown as RuntimeActivationDeps, tasks };
}

const minBytesGate = { checks: [{ kind: 'minBytes' as const, file: 'index.html', bytes: 10 }] };

describe('runActivationGate', () => {
  it('leaves a step with no gate, or a completion gate, to the caller', async () => {
    const { d, tasks } = deps();
    expect(await runActivationGate(d, { projectId: 'p', task: task([]), newStep: step() })).toBe(
      false,
    );
    const completion = step({ gate: { at: 'completion', ...minBytesGate } });
    expect(
      await runActivationGate(d, { projectId: 'p', task: task([completion]), newStep: completion }),
    ).toBe(false);
    expect(tasks.completeStep).not.toHaveBeenCalled();
  });

  it('advances past an approved gate without a model turn', async () => {
    const { d, tasks } = deps({ 'index.html': '<html>a real page</html>' });
    const gated = step({ gate: minBytesGate });
    expect(
      await runActivationGate(d, { projectId: 'p', task: task([gated]), newStep: gated }),
    ).toBe(true);
    expect(tasks.completeStep).toHaveBeenCalledWith('p', 1, 'review', 'ship', { cause: 'gate' });
  });

  it('hands an approved gate with a reviewer back to the caller for dispatch', async () => {
    const { d, tasks } = deps({ 'index.html': '<html>a real page</html>' });
    const gated = step({ gate: { ...minBytesGate, reviewer: 'reviewer' } });
    expect(
      await runActivationGate(d, { projectId: 'p', task: task([gated]), newStep: gated }),
    ).toBe(false);
    expect(tasks.completeStep).not.toHaveBeenCalled();
  });

  it('loops a rejection back to the entry step, then pauses at maxAttempts', async () => {
    const { d, tasks } = deps();
    const gated = step({ gate: { ...minBytesGate, maxAttempts: 2 } });
    expect(
      await runActivationGate(d, { projectId: 'p', task: task([gated]), newStep: gated }),
    ).toBe(true);
    expect(tasks.completeStep).toHaveBeenCalledWith('p', 1, 'review', 'build', { cause: 'gate' });
    expect(tasks.setStatus).not.toHaveBeenCalled();

    const last = step({ gate: { ...minBytesGate, maxAttempts: 2 }, attemptCount: 2 });
    expect(await runActivationGate(d, { projectId: 'p', task: task([last]), newStep: last })).toBe(
      true,
    );
    expect(tasks.setStatus).toHaveBeenCalledWith('p', 1, 'paused');
    expect(tasks.completeStep).toHaveBeenCalledTimes(1);
  });
});

describe('runSpawnFanout', () => {
  it('leaves a step that is not a fanout on a spawn host to the caller', async () => {
    const { d, tasks } = deps();
    const fanout = step({ spawnFanout: true });
    expect(await runSpawnFanout(d, { projectId: 'p', task: task([fanout]), newStep: fanout })).toBe(
      false,
    );
    expect(tasks.listChildren).not.toHaveBeenCalled();
  });
});
