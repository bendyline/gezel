import { describe, expect, it, vi } from 'vitest';
import type { ChatSession } from '../schemas/session.js';
import {
  taskActiveAssignee,
  taskSessionCanContinue,
  taskTranscriptCompatible,
} from '../task-execution.js';
import { portableToolSurface } from './product-tools.js';
import { PortableStore } from './store.js';
import { PortableTaskRunner } from './task-routes.js';
import { portableFixture } from './test-files.js';

async function fixture() {
  const value = portableFixture();
  await value.store.ensureLayout();
  const owner = await value.store.createGezel({ name: 'Noor', role: 'Generalist' });
  const specialist = await value.store.createGezel({ name: 'Eva', role: 'Reviewer' });
  const input = {
    title: 'Continuous report',
    description: 'Write a grounded report, review the evidence, and ask for human approval.',
    assignee: { kind: 'gezel' as const, gezelId: owner.id },
    steps: [
      { id: 'draft', name: 'Draft', suggestedRole: 'Writer', suggestedGezelId: specialist.id },
      { id: 'review', name: 'Review', suggestedRole: 'Reviewer' },
      { id: 'accept', name: 'Accept', assignee: { kind: 'user' as const } },
      {
        id: 'specialist',
        name: 'Specialist',
        assignee: { kind: 'gezel' as const, gezelId: specialist.id },
        terminal: true,
      },
    ],
  };
  return { ...value, owner, specialist, input };
}

describe('portable shared execution-mode resolution', () => {
  it('pins a forced generalist owner before role resolution, preserving human and explicit specialist steps', async () => {
    const { store, options, owner, specialist, input } = await fixture();
    const resolveStepRole = vi.fn(async () => specialist.id);
    const runner = new PortableTaskRunner({ store, runStep: async () => {}, resolveStepRole });
    const task = await runner.create('default', { ...input, executionMode: 'generalist' });
    expect(task.executionMode).toBe('generalist');
    expect(task.craftbook.steps.map((step) => step.assignee)).toEqual([
      input.assignee,
      input.assignee,
      { kind: 'user' },
      { kind: 'gezel', gezelId: specialist.id },
    ]);
    expect(task.craftbook.steps[0]?.suggestedGezelId).toBeUndefined();
    expect(task.craftbook.steps[0]?.suggestedRole).toBe('Writer');
    expect(resolveStepRole).not.toHaveBeenCalled();
    expect(taskActiveAssignee(task)).toEqual({ kind: 'gezel', gezelId: owner.id });
    expect((await new PortableStore(options).getTask(task.ref))?.executionMode).toBe('generalist');
    await store.writeConfig({ generalistMode: 'off' });
    await store.setTaskStatus(task.ref, 'paused');
    expect((await store.setTaskStatus(task.ref, 'active')).executionMode).toBe('generalist');
  });

  it('keeps local auto stepwise and resolves the on/off configuration once', async () => {
    const { store, input } = await fixture();
    const auto = await store.createTask('default', input);
    expect(auto.executionMode).toBe('stepwise');
    expect(auto.craftbook.steps[1]?.assignee).toBeUndefined();
    await store.writeConfig({ generalistMode: 'on' });
    expect((await store.createTask('default', input)).executionMode).toBe('generalist');
    const explicit = await store.createTask('default', { ...input, executionMode: 'stepwise' });
    expect(explicit.executionMode).toBe('stepwise');
    expect(explicit.craftbook.steps[1]?.assignee).toBeUndefined();
    expect((await store.getTask(auto.ref))?.executionMode).toBe('stepwise');
  });

  it('defers automatic draft resolution until activation and preserves explicit draft intent', async () => {
    const { store, input } = await fixture();
    const draft = await store.createTask('default', { ...input, status: 'draft' });
    expect(draft.executionMode).toBeUndefined();
    expect(draft.craftbook.steps[1]?.assignee).toBeUndefined();
    const explicit = await store.createTask('default', {
      ...input,
      status: 'draft',
      executionMode: 'stepwise',
    });
    await store.writeConfig({ generalistMode: 'on' });
    const activated = await store.setTaskStatus(draft.ref, 'active');
    expect(activated.executionMode).toBe('generalist');
    expect(activated.craftbook.steps[1]?.assignee).toEqual(input.assignee);
    expect((await store.activateTaskStep(explicit.ref, 'draft')).executionMode).toBe('stepwise');
  });

  it('keeps new unassigned steps on the persisted generalist owner', async () => {
    const { store, owner, input } = await fixture();
    const task = await store.createTask('default', { ...input, executionMode: 'generalist' });
    const updated = await store.addTaskStep(task.ref, {
      name: 'Extra review',
      suggestedRole: 'Reviewer',
      after: 'review',
    });
    expect(updated.craftbook.steps.find((step) => step.name === 'Extra review')?.assignee).toEqual({
      kind: 'gezel',
      gezelId: owner.id,
    });
  });

  it('tells automatic owner recruitment which execution mode was requested', async () => {
    const { store, owner, input } = await fixture();
    const resolveAssignee = vi.fn(async () => owner.id);
    const runner = new PortableTaskRunner({ store, runStep: async () => {}, resolveAssignee });
    const task = await runner.create('default', {
      ...input,
      assignee: undefined,
      executionMode: 'generalist',
      steps: [{ id: 'write', name: 'Write', suggestedRole: 'Writer', terminal: true }],
    });
    expect(resolveAssignee).toHaveBeenCalledWith('default', undefined, 'generalist');
    expect(task.craftbook.steps[0]?.assignee).toEqual({ kind: 'gezel', gezelId: owner.id });
  });

  it('retains exact active-step grants when the generalist carries other steps’ file kits', async () => {
    const { store, owner, input } = await fixture();
    const task = await store.createTask('default', {
      ...input,
      executionMode: 'generalist',
      steps: [
        {
          id: 'read',
          name: 'Read',
          toolPolicy: { allowTools: ['read_artifact'], outputMedium: 'none' },
        },
        {
          id: 'write',
          name: 'Write',
          advanceWhen: { file: 'report.md', artifact: true },
        },
        { id: 'finish', name: 'Finish', terminal: true },
      ],
    });
    const session = {
      gezelId: owner.id,
      projectId: task.projectId,
      taskRef: task.ref,
      stepId: 'read',
    };
    expect((await portableToolSurface(store, session, true)).map((tool) => tool.name)).toEqual([
      'read_artifact',
    ]);
    await store.completeTaskStep(task.ref, 'read');
    // A stale session retains its original ceiling until a host explicitly re-pins it.
    expect((await portableToolSurface(store, session, true)).map((tool) => tool.name)).toEqual([
      'read_artifact',
    ]);
  });
});

describe('shared task transcript continuity', () => {
  async function prior() {
    const { store, owner, input } = await fixture();
    const task = await store.createTask('default', { ...input, executionMode: 'generalist' });
    const session = await store.createSession({
      gezelId: owner.id,
      projectId: 'default',
      taskRef: task.ref,
      stepId: 'draft',
      providerName: 'llama-cpp',
      model: 'pinned-model',
    });
    const next = { task, gezelId: owner.id, providerName: 'llama-cpp', model: 'pinned-model' };
    return { store, task, session, next };
  }
  it('continues generalist retries and same-owner adjacent steps, while stepwise retries stay fresh', async () => {
    const { task, session, next } = await prior();
    expect(taskSessionCanContinue(session, next)).toBe(true);
    task.executionMode = 'stepwise';
    expect(taskSessionCanContinue(session, next)).toBe(false);
    task.activeStepId = 'review';
    expect(taskSessionCanContinue(session, next)).toBe(true);
    task.activeStepId = 'accept';
    expect(taskSessionCanContinue(session, next)).toBe(false);
  });
  it.each([
    { archived: true },
    { turnStartedAt: '2026-09-20T12:00:00Z' },
    { model: 'different-model' },
    { providerName: 'apple-foundation-models' },
    { roleBasedNameOnlyMode: true },
    { nightShift: true },
    { taskRef: 'default/999' },
    { projectId: 'another' },
    { gezelId: 'another' },
    { lastTurnError: 'The request exceeds the available context size.' },
    {
      lastTurnError:
        'Prompt plus requested output exceeds the context; shorten the transcript or output',
    },
    {
      messages: [
        {
          id: 'halt',
          role: 'assistant',
          content: 'Context loop halted',
          at: '2026-09-20T12:00:00Z',
          synthetic: 'context-loop-halt',
        },
      ],
    },
  ])('refuses incompatible, active, or poisoned prior transcripts: %j', async (patch) => {
    const { session, next } = await prior();
    expect(taskSessionCanContinue({ ...session, ...patch } as ChatSession, next)).toBe(false);
  });
  it('preserves desktop’s unspecified-model compatibility convention', async () => {
    const { session, next } = await prior();
    expect(taskTranscriptCompatible(session, { ...next, model: undefined })).toBe(true);
    expect(taskTranscriptCompatible(session, { ...next, model: 'changed' })).toBe(false);
  });
});
