import { describe, expect, it } from 'vitest';
import { toolsetIdsExplicitlyDisabledForStep } from './step-toolsets.js';

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
});
