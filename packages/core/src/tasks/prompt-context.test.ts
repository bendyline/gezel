import { describe, expect, it } from 'vitest';
import type { Task } from '../schemas/task.js';
import { isGatedStep, renderTaskContextBlock, renderTaskOutline } from './prompt-context.js';

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
