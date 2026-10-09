import { describe, expect, it } from 'vitest';
import type { TaskCraftbookStep } from '../schemas/task.js';
import {
  earlierStepProducts,
  inferredStepInputs,
  withInferredConsumes,
} from './inferred-step-inputs.js';

const now = '2026-10-07T00:00:00.000Z';
const step = (s: Partial<TaskCraftbookStep> & { id: string }): TaskCraftbookStep =>
  ({ name: s.id, createdAt: now, ...s }) as TaskCraftbookStep;

// invoice-run's shape: scope writes scope.md, collect consumes only billables.json
// yet is asked about the clients scope.md excluded.
const scope = step({
  id: 'scope',
  name: 'Scope the run',
  completedAt: now,
  advanceWhen: { file: 'tasks/3/scope.md', artifact: true },
});
const billables = step({
  id: 'billables',
  name: 'List billables',
  completedAt: now,
  advanceWhen: { file: 'tasks/3/billables.json', artifact: true },
});
const collect = step({
  id: 'collect',
  name: 'Collect',
  prompt:
    'Read `tasks/3/billables.json`. Name any client skipped this month, as recorded in scope.md.',
  consumes: [{ file: 'tasks/3/billables.json', artifact: true }],
  advanceWhen: { file: 'tasks/3/collect.md', artifact: true },
});

describe('inferredStepInputs', () => {
  it('adds an earlier step file the procedure names but does not consume', () => {
    expect(inferredStepInputs([scope, billables, collect], collect)).toEqual([
      { file: 'tasks/3/scope.md', artifact: true, producedBy: 'Scope the run' },
    ]);
  });

  it('ignores unfinished steps, declared inputs, and files the procedure never names', () => {
    const unfinished = { ...scope, completedAt: undefined } as TaskCraftbookStep;
    expect(inferredStepInputs([unfinished, billables, collect], collect)).toEqual([]);
    const silent = { ...collect, prompt: 'Read `tasks/3/billables.json`.' } as TaskCraftbookStep;
    expect(inferredStepInputs([scope, billables, silent], silent)).toEqual([]);
  });

  it('does not match a basename inside a longer name', () => {
    const notes = step({ id: 'notes', completedAt: now, advanceWhen: { file: 'notes.md' } });
    const later = step({ id: 'later', prompt: 'Update release-notes.md with the summary.' });
    expect(inferredStepInputs([notes, later], later)).toEqual([]);
  });
});

describe('earlierStepProducts', () => {
  it('lists finished steps and their files in order, without the active step', () => {
    expect(earlierStepProducts([scope, billables, collect], collect)).toEqual([
      { stepName: 'Scope the run', file: 'tasks/3/scope.md', artifact: true },
      { stepName: 'List billables', file: 'tasks/3/billables.json', artifact: true },
    ]);
  });
});

describe('withInferredConsumes', () => {
  const task = (executionMode?: 'generalist' | 'stepwise') => ({
    ...(executionMode ? { executionMode } : {}),
    craftbook: { steps: [scope, billables, collect] },
  });

  it('extends consumes for a stepwise task', () => {
    expect(withInferredConsumes(task('stepwise'), collect).consumes).toEqual([
      { file: 'tasks/3/billables.json', artifact: true },
      { file: 'tasks/3/scope.md', artifact: true },
    ]);
  });

  it('leaves a generalist step alone', () => {
    expect(withInferredConsumes(task('generalist'), collect)).toBe(collect);
  });
});
