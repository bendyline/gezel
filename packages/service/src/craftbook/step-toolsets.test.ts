import { describe, expect, it } from 'vitest';
import {
  builtinToolsetIdsDisabledForStep,
  outputMediaForStep,
  outputMediumForStep,
  toolsetIdsExplicitlyDisabledForStep,
} from './step-toolsets.js';

const needs = [{ toolsetId: 'docblocks', autoAllow: true }, { toolsetId: 'github' }];

describe('toolsetIdsExplicitlyDisabledForStep', () => {
  it('suppresses a declared production toolset when the active step explicitly forbids it', () => {
    const disabled = toolsetIdsExplicitlyDisabledForStep(
      {
        description: 'Lock the narrative before authoring.',
        prompt: 'Write notes/outline.md. Do not write slide content or call DocBlocks.',
      },
      needs,
    );

    expect([...disabled]).toEqual(['docblocks']);
  });

  it('keeps the toolset for a production step that calls one of its tools', () => {
    const disabled = toolsetIdsExplicitlyDisabledForStep(
      {
        description: 'Publish the PowerPoint.',
        prompt: 'Call convert_document once, preview_document, then save_artifact.',
      },
      needs,
    );

    expect(disabled.size).toBe(0);
  });

  it('does not suppress undeclared or separately instructed toolsets', () => {
    const disabled = toolsetIdsExplicitlyDisabledForStep(
      {
        description: 'Review the source.',
        prompt: 'Do not call DocBlocks. Use GitHub to verify the linked issue.',
      },
      [{ toolsetId: 'github' }],
    );

    expect(disabled.size).toBe(0);
  });

  it('does not carry a denial across a sentence boundary', () => {
    const disabled = toolsetIdsExplicitlyDisabledForStep(
      {
        description: 'Prepare carefully.',
        prompt: 'Do not change the source. Call DocBlocks to publish it.',
      },
      needs,
    );

    expect(disabled.size).toBe(0);
  });

  it('honors structured JSON ids without requiring a top-level craftbook declaration', () => {
    const disabled = toolsetIdsExplicitlyDisabledForStep(
      {
        toolPolicy: { disallowToolsets: ['docblocks', 'custom-heavy-server'] },
      },
      undefined,
    );

    expect([...disabled]).toEqual(['docblocks', 'custom-heavy-server']);
  });

  it('unions the structured policy with the legacy prose compatibility parser', () => {
    const disabled = toolsetIdsExplicitlyDisabledForStep(
      {
        prompt: 'Do not call DocBlocks during research.',
        toolPolicy: { disallowToolsets: ['another-server'] },
      },
      needs,
    );

    expect([...disabled]).toEqual(['another-server', 'docblocks']);
  });
});

describe('structured step tool policy', () => {
  it('returns stable built-in group ids', () => {
    expect([
      ...builtinToolsetIdsDisabledForStep({
        toolPolicy: { disallowBuiltinToolsets: ['code-execution', 'git'] },
      }),
    ]).toEqual(['code-execution', 'git']);
  });

  it('prefers explicit outputMedium and infers legacy file surfaces', () => {
    expect(outputMediumForStep({ toolPolicy: { outputMedium: 'task-note' } })).toBe('task-note');
    expect(outputMediumForStep({ advanceWhen: { file: 'report.md', artifact: true } })).toBe(
      'artifact',
    );
    expect(outputMediumForStep({ advanceWhen: { file: 'index.html' } })).toBe('workspace');
    expect(
      outputMediumForStep({
        gate: {
          at: 'completion',
          checks: [{ kind: 'minBytes', file: 'audit.md', bytes: 1, artifact: true }],
        },
      }),
    ).toBe('artifact');
  });

  it('resolves a primary result plus intentional secondary write surfaces', () => {
    expect([
      ...outputMediaForStep({
        toolPolicy: {
          outputMedium: 'artifact',
          additionalOutputMedia: ['workspace', 'task-note'],
        },
      }),
    ]).toEqual(['artifact', 'workspace', 'task-note']);
  });

  it('lets a gate-required surface override a contradictory legacy none policy', () => {
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

  it('recovers secondary output implied by a procedure from an older generated policy', () => {
    expect([
      ...outputMediaForStep({
        name: 'Fix',
        prompt: 'Edit the source, then record the result in the task notes.',
        advanceWhen: { file: 'src/fix.ts' },
        toolPolicy: { outputMedium: 'workspace' },
      }),
    ]).toEqual(['workspace', 'task-note']);
  });
});
