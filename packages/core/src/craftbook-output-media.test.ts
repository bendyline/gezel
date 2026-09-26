import { describe, expect, it } from 'vitest';
import {
  additionalOutputMediaForStep,
  outputMediaForCraftbookBlueprint,
  outputMediaForStep,
  outputMediumForCraftbookBlueprint,
  outputMediumForStep,
} from './craftbook-output-media.js';
import type { NewCraftbookStep } from './schemas/craftbook.js';

function blueprint(step: Partial<NewCraftbookStep>): NewCraftbookStep {
  return { name: 'Step', ...step } as NewCraftbookStep;
}

describe('craftbook blueprint output media', () => {
  it('derives the primary medium from structural declarations before prose', () => {
    expect(
      outputMediumForCraftbookBlueprint(
        blueprint({ deliverable: { path: 'site/index.html', kind: 'html-page' } }),
      ),
    ).toBe('workspace');
    expect(
      outputMediumForCraftbookBlueprint(
        blueprint({ advanceWhen: { file: 'reports/audit.md', artifact: true } }),
      ),
    ).toBe('artifact');
    expect(
      outputMediumForCraftbookBlueprint(
        blueprint({ prompt: 'Record PASS/FAIL in the task notes.' }),
      ),
    ).toBe('task-note');
    expect(outputMediumForCraftbookBlueprint(blueprint({ terminal: true }))).toBe('none');
  });

  it('lets executable gate requirements override a contradictory none policy', () => {
    const step = blueprint({
      toolPolicy: { outputMedium: 'none' },
      gate: {
        at: 'completion',
        scripts: [{ name: 'checkTaskNoteContains', scope: 'standard' }],
      },
    });

    expect(outputMediumForCraftbookBlueprint(step)).toBe('task-note');
    expect([...outputMediaForCraftbookBlueprint(step)]).toEqual(['task-note']);
  });

  it('does not treat an on-enter-generated advance file as model output', () => {
    const step = blueprint({
      prompt: 'The runtime publishes the ledger; write a task note with the result.',
      toolPolicy: { outputMedium: 'artifact' },
      onEnter: {
        name: 'publishCorpusBatches',
        scope: 'standard',
        inputs: { outFile: './tasks/4/batches.json' },
      },
      advanceWhen: { file: 'tasks/4/batches.json', artifact: true },
      gate: {
        at: 'completion',
        scripts: [{ name: 'checkTaskNoteContains', scope: 'standard' }],
      },
    });

    expect(outputMediumForCraftbookBlueprint(step)).toBe('task-note');
  });

  it('collects and de-duplicates secondary media implied by the procedure', () => {
    const step = blueprint({
      prompt:
        'Edit the actual workspace files with write_file, write the report with write_artifact, and record the outcome in the task notes.',
      advanceWhen: { file: 'reports/fix.md', artifact: true },
      toolPolicy: { additionalOutputMedia: ['task-note'] },
    });

    expect(additionalOutputMediaForStep(step, 'artifact')).toEqual(['task-note', 'workspace']);
    expect([...outputMediaForCraftbookBlueprint(step)]).toEqual([
      'artifact',
      'task-note',
      'workspace',
    ]);
  });

  it('recognizes an implementation plus regression-test phase as workspace mutation', () => {
    const step = blueprint({
      name: 'Implement the smallest fix and verify it',
      prompt:
        'Implement the smallest maintainable change that breaks the causal chain. Add or strengthen a regression test that fails on the old behavior and passes with the fix. Write the completed report with write_artifact.',
      advanceWhen: { file: 'reports/root-cause-investigation.md', artifact: true },
    });

    expect(additionalOutputMediaForStep(step, 'artifact')).toEqual(['workspace']);
    expect([...outputMediaForCraftbookBlueprint(step)]).toEqual(['artifact', 'workspace']);
  });
});

describe('persisted craftbook step output media', () => {
  it('handles absent, explicit, and legacy file-gated steps', () => {
    expect(outputMediumForStep(undefined)).toBeNull();
    expect(outputMediumForStep({ toolPolicy: { outputMedium: 'task-note' } })).toBe('task-note');
    expect(outputMediumForStep({ advanceWhen: { file: 'result.md' } })).toBe('workspace');
    expect(outputMediumForStep({ advanceWhen: { file: 'result.md', artifact: true } })).toBe(
      'artifact',
    );
  });

  it('recovers gate and procedure media from older generated policies', () => {
    expect([
      ...outputMediaForStep({
        name: 'Fix',
        prompt: 'Edit the source files, then record the result in the task notes.',
        toolPolicy: { outputMedium: 'workspace' },
      }),
    ]).toEqual(['workspace', 'task-note']);

    expect([
      ...outputMediaForStep({
        toolPolicy: { outputMedium: 'none' },
        gate: {
          at: 'completion',
          scripts: [{ name: 'checkTaskNoteContains', scope: 'standard' }],
        },
      }),
    ]).toEqual(['task-note']);
  });

  it('keeps none as the explicit medium when no writable surface is required', () => {
    expect([...outputMediaForStep({ toolPolicy: { outputMedium: 'none' } })]).toEqual(['none']);
  });
});
