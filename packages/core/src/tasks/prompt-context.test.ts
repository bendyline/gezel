import { describe, expect, it } from 'vitest';
import type { Task } from '../schemas/task.js';
import { isGatedStep, renderTaskContextBlock, renderTaskOutline } from './prompt-context.js';
import { resolveNextStep } from './step-routing.js';

const task = {
  ref: 'default/3',
  num: 3,
  projectId: 'default',
  title: 'Ship the launch page',
  description: 'Build and review the page.',
  status: 'active',
  assignee: { kind: 'gezel', gezelId: 'ada' },
  activeStepId: 'review',
  executionMode: 'generalist',
  craftbook: {
    id: 'launch',
    description: 'A launch page that converts.',
    steps: [
      { id: 'build', name: 'Build', prompt: 'Write the page.', completedAt: 't', next: 'review' },
      {
        id: 'review',
        name: 'Review',
        prompt: 'Check every link.',
        attemptCount: 2,
        gate: { at: 'completion', checks: [{ kind: 'minBytes', file: 'index.html', bytes: 1 }] },
        next: 'build',
      },
    ],
  },
  lastGateHandoff: {
    fromStepId: 'build',
    toStepId: 'review',
    message: 'Two links are dead',
    at: 't',
  },
} as unknown as Task;
const step = task.craftbook.steps[1]!;

describe('renderTaskContextBlock', () => {
  describe('the launch reference list', () => {
    const withReferences = {
      ...task,
      references: {
        subject: 'quiche',
        gatheredAt: '2026-09-26T00:10:53.000Z',
        items: [
          {
            source: 'knowledge',
            title: 'Quiche',
            uri: 'knowledge://bendyline/wikipedia-food-drink/290627#chunk=abc',
            catalogId: 'wikipedia-food-drink',
            catalogVersion: '2026.5.0',
            snippet: 'A French tart with a pastry case and a savoury `custard`\nfilling.',
          },
          { source: 'shared', title: 'recipes.md', path: 'recipes.md' },
        ],
      },
    } as unknown as Task;

    it('lists each reference as untrusted evidence', () => {
      const block = renderTaskContextBlock({ task: withReferences, step });
      expect(block).toContain('#### Reference material found at launch');
      expect(block).toContain('subject ("quiche")');
      expect(block).toContain('untrusted evidence');
      expect(block).toContain(
        '- [knowledge] Quiche `knowledge://bendyline/wikipedia-food-drink/290627#chunk=abc` · wikipedia-food-drink@2026.5.0 — "A French tart with a pastry case and a savoury \'custard\' filling."',
      );
      expect(block).toContain('- [shared] recipes.md `recipes.md`');
      expect(block).not.toContain('2026-09-26');
    });

    it('names read_document only when the turn wired it', () => {
      const wired = renderTaskContextBlock(
        { task: withReferences, step },
        { availableToolNames: new Set(['read_document']) },
      );
      expect(wired).toContain('Open one with `read_document`');
      const unwired = renderTaskContextBlock(
        { task: withReferences, step },
        { availableToolNames: new Set(['write_artifact']) },
      );
      expect(unwired).toContain('#### Reference material found at launch');
      expect(unwired).not.toContain('read_document');
    });

    it('renders nothing for a task without references', () => {
      expect(renderTaskContextBlock({ task, step })).not.toContain('Reference material');
    });
  });

  it('renders the task, the outline, the procedure, the handoff and the gate', () => {
    const block = renderTaskContextBlock({ task, step });
    expect(block).toContain('### Current task: default/3 — "Ship the launch page"');
    expect(block).toContain('### Task outline');
    expect(block).toContain('1. Build (done)');
    expect(block).toContain('2. Review (active) (gated)');
    expect(block).toContain('#### Step procedure\n\nCheck every link.');
    expect(block).toContain('#### Handoff from the completion gate\n\nTwo links are dead');
    expect(block).toContain('#### Phase gate');
    expect(block).toContain('attempt 2');
    expect(block).toContain('Task tools wired this turn');
  });

  it('narrows the guidance to the tools this turn wired', () => {
    const block = renderTaskContextBlock(
      { task, step },
      { availableToolNames: new Set(['read_task_notes']) },
    );
    expect(block).toContain('Task tools wired this turn: `read_task_notes`.');
    expect(block).not.toContain('Task artifact folder');
    expect(block).toContain('finish and pass them before the next step is revealed');
  });

  it('explains the default repair loop and the explicit review branch', () => {
    const steps = [
      ...task.craftbook.steps,
      { id: 'finish', name: 'Finish', terminal: true, createdAt: '2026-10-08T00:00:00Z' },
    ];
    const reviewTask = { ...task, craftbook: { ...task.craftbook, steps } };
    const block = renderTaskContextBlock({ task: reviewTask, step });
    expect(resolveNextStep({ steps, currentId: 'review' })).toEqual({
      kind: 'advance',
      to: 'build',
    });
    expect(resolveNextStep({ steps, currentId: 'review', override: 'next' })).toEqual({
      kind: 'advance',
      to: 'build',
    });
    expect(resolveNextStep({ steps, currentId: 'review', override: 'finish' })).toEqual({
      kind: 'advance',
      to: 'finish',
    });
    expect(block).toContain('declared default destination is `build`');
    expect(block).toContain('include that exact step id in the `next` argument');
    expect(block).toContain(
      'Writing a PASS note or saying the review passed does not select a destination',
    );
    expect(
      renderTaskContextBlock(
        { task: reviewTask, step },
        { availableToolNames: new Set(['write_task_note']) },
      ),
    ).not.toContain('#### Step routing');
    expect(renderTaskContextBlock({ task: reviewTask, step: steps[2] })).not.toContain(
      '#### Step routing',
    );
  });

  it('names a checked file outside the task folder, and only then', () => {
    const handover = {
      ...task,
      craftbook: {
        ...task.craftbook,
        steps: [
          {
            id: 'write',
            name: 'Write handover',
            prompt: 'Write handover.md in the artifacts.',
            gate: {
              at: 'completion',
              checks: [{ kind: 'minBytes', file: 'handover.md', artifact: true, bytes: 40 }],
            },
          },
        ],
      },
      activeStepId: 'write',
    } as unknown as Task;
    const block = renderTaskContextBlock({ task: handover, step: handover.craftbook.steps[0]! });
    expect(block).toContain(
      "This step's completion checks read `handover.md`; save that file at exactly that path, not in the task folder.",
    );
    const inFolder = structuredClone(handover);
    (inFolder.craftbook.steps[0]!.gate as { checks: { file: string }[] }).checks[0]!.file =
      'tasks/3/handover.md';
    expect(
      renderTaskContextBlock({ task: inFolder, step: inFolder.craftbook.steps[0]! }),
    ).not.toContain("This step's completion checks read");
  });

  it('describes an input by where it is and the tools that open it', () => {
    const withInput = {
      ...task,
      craftbookParams: { source: 'tasks/3/inputs/source', audience: 'teens' },
      inputs: {
        source: {
          kind: 'folder',
          drawer: 'artifacts',
          path: 'tasks/3/inputs/source',
          from: 'upload',
          label: 'Blog drafts',
          manifest: 'tasks/3/inputs/source.json',
          fileCount: 37,
          totalBytes: 2_200_000,
          skippedCount: 0,
          hasOfficeDocuments: true,
        },
      },
    } as Task;
    const block = renderTaskContextBlock({ task: withInput, step });
    expect(block).toContain(
      '- `source`: 37 files (2.1 MB), copied from "Blog drafts", in the folder `tasks/3/inputs/source/` in the **artifacts drawer**.',
    );
    expect(block).toContain('`read_doc_as_markdown({ path, artifact: true })`');
    expect(block).toContain('The complete file list is the artifact `tasks/3/inputs/source.json`.');
    expect(block).toContain('- `audience`: "teens"');

    const narrow = renderTaskContextBlock(
      { task: withInput, step },
      { availableToolNames: new Set(['read_artifact']) },
    );
    expect(narrow).not.toContain('list_artifacts');
    expect(narrow).not.toContain('read_doc_as_markdown');
    expect(narrow).toContain('read text files with `read_artifact`');
  });

  it('is deterministic and carries no timestamp', () => {
    expect(renderTaskContextBlock({ task, step })).toBe(renderTaskContextBlock({ task, step }));
    expect(renderTaskOutline(task, step, { advanceWired: true })).toContain('`advance_task_step`');
    expect(isGatedStep(step, task.craftbook.steps)).toBe(true);
    expect(isGatedStep(task.craftbook.steps[0]!, task.craftbook.steps)).toBe(false);
  });
});

describe('renderTaskContextBlock — stepwise handoffs', () => {
  const steps = [
    {
      id: 'scope',
      name: 'Scope the run',
      completedAt: 't',
      advanceWhen: { file: 'tasks/3/scope.md', artifact: true },
    },
    {
      id: 'billables',
      name: 'List billables',
      completedAt: 't',
      advanceWhen: { file: 'tasks/3/billables.json', artifact: true },
    },
    {
      id: 'collect',
      name: 'Collect',
      prompt: 'Name any client skipped this month, as recorded in scope.md.',
      advanceWhen: { file: 'tasks/3/collect.md', artifact: true },
    },
  ];
  const invoiceTask = (executionMode: 'generalist' | 'stepwise') =>
    ({
      ...task,
      activeStepId: 'collect',
      executionMode,
      craftbook: { id: 'invoice-run', steps },
    }) as unknown as Task;

  it('gives a stepwise step the earlier files its procedure names, and the rest as a list', () => {
    const block = renderTaskContextBlock({
      task: invoiceTask('stepwise'),
      step: steps[2] as never,
    });
    expect(block).toContain(
      '`tasks/3/scope.md` — written by the earlier step **Scope the run**, and this procedure uses it. Open it with `read_artifact({ path: "tasks/3/scope.md" })`.',
    );
    expect(block).toContain("#### Earlier steps' files");
    expect(block).toContain('**List billables** → `tasks/3/billables.json` (artifacts drawer)');
  });

  it('adds neither for a generalist owner, who wrote those files itself', () => {
    const block = renderTaskContextBlock({
      task: invoiceTask('generalist'),
      step: steps[2] as never,
    });
    expect(block).not.toContain('written by the earlier step');
    expect(block).not.toContain("Earlier steps' files");
  });

  it('shows a stepwise session the outline, scoped to its own step', () => {
    const block = renderTaskContextBlock({
      task: invoiceTask('stepwise'),
      step: steps[2] as never,
    });
    expect(block).toContain('### Task outline');
    expect(block).toContain(
      '1. Scope the run (done)\n2. List billables (done)\n3. Collect (active)',
    );
    expect(block).toContain('Only the active step is yours.');
    expect(block).not.toContain('You own every step');
    expect(block.indexOf('### Task outline')).toBeLessThan(block.indexOf('#### Step procedure'));
  });
});

describe('authoring notes', () => {
  it('teaches the Squisq format a step declares, from the one shared source', () => {
    const slideshow = { ...step, authoring: 'squisq-slideshow' } as typeof step;
    const block = renderTaskContextBlock({ task, step: slideshow });
    expect(block).toContain('### Writing a Squisq slideshow');
    expect(block).toContain('{[imageWithCaption caption=');
    expect(block.indexOf('#### Step procedure')).toBeLessThan(
      block.indexOf('### Writing a Squisq slideshow'),
    );

    const doc = renderTaskContextBlock({
      task,
      step: { ...step, authoring: 'squisq' } as typeof step,
    });
    expect(doc).toContain('### Squisq extended markdown');
    expect(doc).toContain("The step's procedure decides heading levels, slide breaks and layout");
    expect(renderTaskContextBlock({ task, step })).not.toContain('Squisq');
  });
});
