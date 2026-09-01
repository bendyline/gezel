import type { CraftbookDoc } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import {
  applyDefaultCraftbookStepPolicies,
  outputMediumForCraftbookBlueprint,
} from './craftbook-step-policy.js';

describe('craftbook step policy defaults', () => {
  it('derives all four output media from structure rather than prose path guessing', () => {
    expect(
      outputMediumForCraftbookBlueprint({
        name: 'Build',
        deliverable: { path: 'index.html', kind: 'html-page' },
      }),
    ).toBe('workspace');
    expect(
      outputMediumForCraftbookBlueprint({
        name: 'Report',
        advanceWhen: { file: 'reports/audit.md', artifact: true },
      }),
    ).toBe('artifact');
    expect(
      outputMediumForCraftbookBlueprint({
        name: 'Review',
        prompt: 'Record PASS/FAIL with `write_task_note`.',
      }),
    ).toBe('task-note');
    expect(outputMediumForCraftbookBlueprint({ name: 'Route', terminal: true })).toBe('none');
  });

  it('converts prose toolset denials to exact JSON ids and removes unrelated heavy groups', () => {
    const doc: CraftbookDoc = {
      id: 'deck',
      name: 'Deck',
      toolsets: [{ toolsetId: 'docblocks', autoAllow: true }],
      steps: [
        {
          id: 'research',
          name: 'Research',
          suggestedRole: 'researcher',
          prompt:
            'Research the subject with `web_search`. Write `notes/sources.md` with `write_artifact`. Do not call docblocks.',
          advanceWhen: { file: 'notes/sources.md', artifact: true },
        },
      ],
      entryStepId: 'research',
    };

    const step = applyDefaultCraftbookStepPolicies(doc).steps[0]!;
    expect(step.toolPolicy?.outputMedium).toBe('artifact');
    expect(step.toolPolicy?.disallowToolsets).toEqual(['docblocks']);
    expect(step.toolPolicy?.disallowBuiltinToolsets).toContain('workspace-fs-write');
    expect(step.toolPolicy?.disallowBuiltinToolsets).toContain('code-execution');
    expect(step.toolPolicy?.disallowBuiltinToolsets).not.toContain('web');
  });

  it('keeps artifact reads for a workspace result that consumes an artifact', () => {
    const doc: CraftbookDoc = {
      name: 'Build',
      steps: [
        {
          name: 'Build',
          consumes: [{ file: 'design/brief.md', artifact: true }],
          deliverable: { path: 'index.html', kind: 'html-page' },
          prompt: 'Read the brief and build the page.',
        },
      ],
    };
    const step = applyDefaultCraftbookStepPolicies(doc).steps[0]!;
    expect(step.toolPolicy?.disallowBuiltinToolsets).not.toContain('artifacts');
  });

  it('declares workspace edits as a secondary medium beside an artifact report', () => {
    const doc: CraftbookDoc = {
      name: 'Fix',
      steps: [
        {
          name: 'Fix',
          prompt:
            'Edit the actual source files with `write_file`, then write the evidence report with `write_artifact`.',
          advanceWhen: { file: 'reports/fix.md', artifact: true },
        },
      ],
    };
    const step = applyDefaultCraftbookStepPolicies(doc).steps[0]!;
    expect(step.toolPolicy?.outputMedium).toBe('artifact');
    expect(step.toolPolicy?.additionalOutputMedia).toEqual(['workspace']);
    expect(step.toolPolicy?.disallowBuiltinToolsets).not.toContain('workspace-fs-write');
  });
});
