import { describe, expect, it } from 'vitest';
import type { Task, TaskCraftbookStep } from './schemas/task.js';
import {
  deliverableFormatLabel,
  deliverableScore,
  outputsWithDeliverableFirst,
  taskDeliverableCandidates,
} from './task-deliverable.js';

const step = (id: string, over: Partial<TaskCraftbookStep> = {}): TaskCraftbookStep =>
  ({ id, name: id, ...over }) as TaskCraftbookStep;

const task = (steps: TaskCraftbookStep[], over: Partial<Task> = {}): Task =>
  ({
    projectId: 'default',
    num: 13,
    ref: 'default/13',
    artifactDir: 'tasks/13',
    craftbook: { steps },
    ...over,
  }) as unknown as Task;

/** The shape of gilde's powerpoint-deck, as persisted after interpolation. */
const powerpointSteps = [
  step('research', { advanceWhen: { file: 'tasks/13/sources.md', artifact: true } }),
  step('outline', { advanceWhen: { file: 'tasks/13/outline.md', artifact: true } }),
  step('write', { advanceWhen: { file: 'powerpoint/task-13/deck.md' } }),
  step('review', {
    gate: {
      checks: [{ kind: 'minBytes', file: 'tasks/13/review.md', bytes: 400, artifact: true }],
    },
  } as Partial<TaskCraftbookStep>),
  step('publish', { advanceWhen: { file: 'powerpoint/task-13/deck.pptx', minBytes: 1 } }),
  step('evaluate'),
  step('finish', { terminal: true }),
];

describe('taskDeliverableCandidates', () => {
  it('picks the published deck over every working file the book gates', () => {
    const candidates = taskDeliverableCandidates(task(powerpointSteps), [
      { kind: 'artifact', path: 'tasks/13/review.md' },
      { kind: 'artifact', path: 'tasks/13/deck.pptx' },
      { kind: 'workspace', path: 'powerpoint/task-13/deck.md' },
    ]);
    expect(candidates[0]).toEqual({ kind: 'workspace', path: 'powerpoint/task-13/deck.pptx' });
    // The drawer copy is the runner-up, so a drafting run whose workspace
    // copy never landed still hands over the deck.
    expect(candidates[1]).toEqual({ kind: 'artifact', path: 'tasks/13/deck.pptx' });
    expect(candidates.map((c) => c.path)).not.toContain('tasks/13/review.md');
    expect(candidates.map((c) => c.path)).not.toContain('tasks/13/sources.md');
  });

  it('keeps a report ahead of the review that follows it', () => {
    const candidates = taskDeliverableCandidates(
      task([
        step('write', { advanceWhen: { file: 'reports/q3.md' } }),
        step('review', { advanceWhen: { file: 'reports/review.md' } }),
      ]),
    );
    expect(candidates).toEqual([{ kind: 'workspace', path: 'reports/q3.md' }]);
  });

  it('resolves step paths a pre-fix task still carries as templates', () => {
    const candidates = taskDeliverableCandidates(
      task([step('publish', { advanceWhen: { file: '{{outputPath}}' } })], {
        craftbookParams: { outputPath: 'decks/france.pptx' },
      }),
    );
    expect(candidates).toEqual([{ kind: 'workspace', path: 'decks/france.pptx' }]);
  });

  it('drops a path whose template cannot resolve', () => {
    const candidates = taskDeliverableCandidates(
      task([step('publish', { advanceWhen: { file: '{{missing}}/deck.pptx' } })]),
    );
    expect(candidates).toEqual([]);
  });

  it('falls back to what the sessions wrote when no step names a file', () => {
    const candidates = taskDeliverableCandidates(task([step('do-it')]), [
      { kind: 'artifact', path: 'artifacts/tasks/13/notes.md' },
      { kind: 'workspace', path: 'site/index.html' },
      { kind: 'workspace', path: 'src/cart.ts' },
    ]);
    expect(candidates).toEqual([{ kind: 'workspace', path: 'site/index.html' }]);
  });
});

describe('deliverableScore', () => {
  it('never offers code, config, or extensionless names', () => {
    expect(deliverableScore('src/cart.ts')).toBe(0);
    expect(deliverableScore('pnpm-lock.lock')).toBe(0);
    expect(deliverableScore('Dockerfile')).toBe(0);
  });

  it('ranks finished formats above prose above working papers', () => {
    expect(deliverableScore('deck.pptx')).toBeGreaterThan(deliverableScore('deck.md'));
    expect(deliverableScore('deck.md')).toBeGreaterThan(deliverableScore('outline.md'));
    expect(deliverableScore('outline.md')).toBe(0);
  });
});

describe('deliverableFormatLabel', () => {
  it('names formats the way a person would', () => {
    expect(deliverableFormatLabel('powerpoint/task-13/deck.pptx')).toBe('PowerPoint deck');
    expect(deliverableFormatLabel('report.DOCX')).toBe('Word document');
    expect(deliverableFormatLabel('site/index.html')).toBe('Web page');
    expect(deliverableFormatLabel('thing.xyz')).toBe('File');
  });
});

describe('outputsWithDeliverableFirst', () => {
  it('moves the deliverable to the front without duplicating it', () => {
    const outputs = [
      { kind: 'artifact' as const, path: 'tasks/13/review.md' },
      { kind: 'workspace' as const, path: 'powerpoint/task-13/deck.pptx' },
    ];
    expect(
      outputsWithDeliverableFirst(outputs, {
        kind: 'workspace',
        path: 'powerpoint/task-13/deck.pptx',
      }),
    ).toEqual([outputs[1], outputs[0]]);
  });
});
