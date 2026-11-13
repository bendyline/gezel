import { describe, expect, it } from 'vitest';
import type { TaskCraftbook } from '../schemas/task.js';
import { taskReadsArtifactAt } from './artifact-deliverables.js';

const contract = {
  goal: 'Answer the question with cited evidence.',
  inputs: [],
  deliverables: [
    {
      id: 'report',
      path: 'tasks/eval/report.md',
      artifact: true,
      kind: 'markdown-report',
      role: 'primary',
      description: 'The report',
    },
    {
      id: 'invoices',
      path: 'invoices/',
      artifact: true,
      kind: 'html-page',
      role: 'supporting',
      description: 'One file per client',
    },
    { id: 'readme', path: 'README.md', kind: 'markdown', role: 'supporting', description: 'x' },
  ],
  criteria: [],
} as unknown as NonNullable<TaskCraftbook['contract']>;

function task(opts: { contract?: typeof contract; gateFile?: string } = {}) {
  const steps = [
    {
      id: 'outcome',
      title: 'Outcome',
      prompt: 'Do the work.',
      ...(opts.gateFile
        ? {
            gate: {
              checks: [{ kind: 'minBytes', file: opts.gateFile, artifact: true, bytes: 100 }],
            },
          }
        : {}),
    },
  ] as unknown as TaskCraftbook['steps'];
  return {
    activeStepId: 'outcome',
    craftbook: { steps, ...(opts.contract ? { contract: opts.contract } : {}) },
  };
}

describe('taskReadsArtifactAt', () => {
  it('reads a contract deliverable placed in the artifacts drawer', () => {
    expect(taskReadsArtifactAt(task({ contract }), 'tasks/eval/report.md')).toBe(true);
    expect(taskReadsArtifactAt(task({ contract }), 'artifacts/tasks/eval/report.md')).toBe(true);
  });

  it('covers the files inside a folder deliverable', () => {
    expect(taskReadsArtifactAt(task({ contract }), 'invoices/harbor.html')).toBe(true);
    expect(taskReadsArtifactAt(task({ contract }), 'invoices-old/harbor.html')).toBe(false);
  });

  it('reads a file the active step checks in the drawer', () => {
    expect(
      taskReadsArtifactAt(task({ gateFile: 'tasks/3/sources.md' }), 'tasks/3/sources.md'),
    ).toBe(true);
  });

  it('does not claim workspace deliverables or paths the task never names', () => {
    expect(taskReadsArtifactAt(task({ contract }), 'README.md')).toBe(false);
    expect(taskReadsArtifactAt(task({ contract }), 'tasks/eval/notes.md')).toBe(false);
    expect(taskReadsArtifactAt(task(), 'tasks/eval/report.md')).toBe(false);
    expect(taskReadsArtifactAt(task({ contract }), '')).toBe(false);
  });
});
