import { describe, expect, it } from 'vitest';
import type { McpToolWrapperContext } from '../mcp-wrapper-types.js';
import {
  CraftbookSuggestionCompactor,
  compactCraftbookSuggestion,
} from './craftbook-suggestion-compactor.js';

const FULL_RESULT = `Best craftbook matches for "create a PowerPoint presentation about Honduras":
1. PowerPoint from Content (id: powerpoint-deck) [bundled, 7 step(s), 49% match] [SETUP REQUIRED: docblocks] — Turn source content into a real editable PowerPoint file.
2. Slide Deck from Content (id: content-deck) [bundled, 5 step(s), 44% match] — Build HTML slides.

Next call: invoke_craftbook({"craftbookId":"powerpoint-deck","description":"create a PowerPoint presentation about Honduras","params":{"topic":"create a PowerPoint presentation about Honduras"}}). It will install any exact trusted zero-configuration bundled dependency; if setup still remains, it returns a hard error and creates no task. Do not call suggest_craftbook again.`;

function ctx(modelTier: McpToolWrapperContext['modelTier']): McpToolWrapperContext {
  return { modelTier } as McpToolWrapperContext;
}

describe('CraftbookSuggestionCompactor', () => {
  it('returns one structured recommendation for small models', async () => {
    const result = await CraftbookSuggestionCompactor.postProcess!(
      'suggest_craftbook',
      { query: 'PowerPoint about Honduras' },
      { text: FULL_RESULT, images: [] },
      ctx('small'),
    );

    const compact = JSON.parse(result.text) as {
      recommendedCraftbook: {
        id: string;
        name: string;
        matchPercent: number;
        setupRequired: string[];
      };
      nextCall: {
        tool: string;
        arguments: { craftbookId: string; description: string; params: { topic: string } };
      };
      instruction: string;
    };
    expect(compact.recommendedCraftbook).toEqual({
      id: 'powerpoint-deck',
      name: 'PowerPoint from Content',
      description: 'Turn source content into a real editable PowerPoint file.',
      matchPercent: 49,
      setupRequired: ['docblocks'],
    });
    expect(compact.nextCall).toEqual({
      tool: 'invoke_craftbook',
      arguments: {
        craftbookId: 'powerpoint-deck',
        description: 'create a PowerPoint presentation about Honduras',
        params: { topic: 'create a PowerPoint presentation about Honduras' },
      },
    });
    expect(compact.instruction).toContain('Reject an unsuitable match');
    expect(compact.instruction).toContain('new project, use start_project');
    expect(compact.instruction).not.toContain('Call invoke_craftbook now');
    expect(result.text).not.toContain('content-deck');
  });

  it('also compacts for tiny models while preserving result images', async () => {
    const result = await CraftbookSuggestionCompactor.postProcess!(
      'suggest_craftbook',
      {},
      { text: FULL_RESULT, images: [{ base64: 'AA==', mimeType: 'image/png' }] },
      ctx('tiny'),
    );

    expect(result.text.length).toBeLessThan(FULL_RESULT.length);
    expect(result.images).toEqual([{ base64: 'AA==', mimeType: 'image/png' }]);
  });

  it.each(['medium', 'large', 'cloud'] as const)(
    'keeps the full shortlist for %s models',
    async (modelTier) => {
      const original = { text: FULL_RESULT, images: [] };
      await expect(
        CraftbookSuggestionCompactor.postProcess!(
          'suggest_craftbook',
          {},
          original,
          ctx(modelTier),
        ),
      ).resolves.toBe(original);
    },
  );

  it('leaves unrelated and unrecognized results unchanged', async () => {
    const original = { text: 'No craftbook matched.', images: [] };
    await expect(
      CraftbookSuggestionCompactor.postProcess!('suggest_craftbook', {}, original, ctx('small')),
    ).resolves.toBe(original);
    expect(compactCraftbookSuggestion('not a suggestion')).toBeNull();
  });

  it('preserves the target project and full brief in a conditional candidate call', () => {
    const args = {
      craftbookId: 'report',
      description: 'Write the annual report in the reporting project.',
      project: 'reporting',
    };
    const result = compactCraftbookSuggestion(
      `1. Report (id: report) [bundled, 2 step(s), 8% match] — Draft a report.\n\nCandidate call, only if this recipe and project fit: invoke_craftbook(${JSON.stringify(args)}).`,
    );
    expect(JSON.parse(result!).nextCall.arguments).toEqual(args);
    expect(JSON.parse(result!).recommendedCraftbook.description).toBe('Draft a report.');
  });

  it('keeps the full result if the candidate description cannot be preserved', () => {
    expect(
      compactCraftbookSuggestion(
        '1. Report (id: report) [bundled, 2 step(s), 8% match]\ninvoke_craftbook({"craftbookId":"report"})',
      ),
    ).toBeNull();
  });
});

it('does not turn unbound recipe details into an executable launch', () => {
  const text =
    '1. Report (id: report) [bundled, 2 step(s), 8% match] — Draft a report.\n\nCandidate recipe details (not a launch call): {"craftbookId":"report","description":"Create a new project for the report."}\nSearch scope: "default". The search scope does not select a destination.';
  expect(compactCraftbookSuggestion(text)).toBeNull();
});
