import { describe, expect, it } from 'vitest';
import type { Task } from '../schemas/task.js';
import { buildStepDispatchSeed } from './step-dispatch-seed.js';

const task = {
  projectId: 'repair-day',
  num: 3,
  ref: 'repair-day/3',
  title: 'Prepare repair handover',
  status: 'active',
  assignee: { kind: 'gezel', gezelId: 'wren' },
  activeStepId: 'write',
  craftbook: {
    name: 'Handover',
    description: 'Hand a job to the next volunteer.',
    steps: [
      { id: 'gather', name: 'Gather', description: 'Collect the facts' },
      {
        id: 'write',
        name: 'Write the note',
        prompt: 'Write `tasks/3/handover.md` naming the owner.',
        toolPolicy: { outputMedium: 'artifact' },
        advanceWhen: { file: 'tasks/3/handover.md', artifact: true },
      },
      {
        id: 'route',
        name: 'Route',
        prompt: 'Call `list_gezels` once.',
        toolPolicy: { outputMedium: 'none', allowTools: ['list_gezels'] },
      },
    ],
  },
} as unknown as Task;

const base = {
  task,
  taskRef: task.ref,
  stepId: 'write',
  selfHandoff: false,
  resumedExisting: false,
};

describe('buildStepDispatchSeed', () => {
  it('orients a fresh launch with the craftbook arc', () => {
    expect(buildStepDispatchSeed({ ...base, kind: 'entry' }).seed).toBe(
      'Task repair-day/3 ("Prepare repair handover") was just created from the **Handover** craftbook. Hand a job to the next volunteer.\n\nIts steps:\n1. Gather — Collect the facts\n2. Write the note ← your step\n3. Route\n\n' +
        "You've been assigned task repair-day/3 (step `write`). Follow the step instructions already in your prompt — start with the first tool call they name, then keep working through the procedure. Persist the primary result to the artifacts-drawer path named by the procedure. When the step is done, call `advance_task_step` to hand off to whoever's next.",
    );
  });

  it('names who handed the step over', () => {
    expect(buildStepDispatchSeed({ ...base, fromGezelDisplayName: 'Noor' }).seed).toBe(
      "Noor has handed step `write` of task repair-day/3 to you. Follow the step instructions already in your prompt — start with the first tool call they name, then keep working through the procedure. Persist the primary result to the artifacts-drawer path named by the procedure. When the step is done, call `advance_task_step` to hand off to whoever's next.",
    );
  });

  it('continues a self-handoff, with the outline note for a generalist task', () => {
    const generalist = { ...task, executionMode: 'generalist' } as Task;
    expect(buildStepDispatchSeed({ ...base, task: generalist, selfHandoff: true }).seed).toContain(
      "which is yours as well. The Task outline in your prompt shows where this step sits in the whole task; only the active step's procedure is in force now. Please continue:",
    );
  });

  it('marks an artifact checkpoint as an exact outcome only with a completion gate', () => {
    const result = buildStepDispatchSeed(base);
    expect(result.dispatchStep?.id).toBe('write');
    expect(result.artifactCheckpointOutcome).toBe(false);
    expect(result.requiresExactOutcome).toBe(false);
  });

  it('repeats a fixed-action entry procedure at the end and withholds advancing', () => {
    const seed = buildStepDispatchSeed({ ...base, stepId: 'route', kind: 'entry' }).seed;
    expect(seed).toContain('`advance_task_step` is intentionally unavailable.');
    expect(
      seed.endsWith(
        "FIXED-ACTION ENTRY — call the procedure's named tool now. The runtime will end this turn and evaluate its durable evidence after the first successful action; do not narrate, repeat the call, or call `advance_task_step`:\nCall `list_gezels` once.",
      ),
    ).toBe(true);
  });

  it('names artifacts already written when a restarted service resumes the step', () => {
    const seed = buildStepDispatchSeed({
      ...base,
      resumedExisting: true,
      persistedArtifacts: ['tasks/3/draft.md'],
    }).seed;
    expect(seed).toMatch(/^The service restarted while task repair-day\/3/);
    expect(seed).toContain(
      'You have already written these artifacts for this task: `tasks/3/draft.md`.',
    );
  });
});
