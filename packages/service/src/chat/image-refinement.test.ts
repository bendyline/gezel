import { describe, expect, it } from 'vitest';
import {
  buildImageRefinementInput,
  classifyImageFollowUp,
  composeImageRefinementPrompt,
  extractGeneratedImageArtifactPath,
  extractGeneratedImageModel,
  extractGeneratedImageSeed,
  heuristicRefinementComposition,
  parseImageRefinementReply,
} from './image-refinement.js';

const PREV = {
  prompt: 'woodcut style image of a dutch artisan craftsman',
  artifactPath: 'generated/image-2026-08-03-123.png',
  seed: 603565817,
};

describe('classifyImageFollowUp', () => {
  it('is always fresh without a previous generation', () => {
    expect(classifyImageFollowUp('no lettering at the bottom', false)).toBe('fresh');
    expect(classifyImageFollowUp('another one', false)).toBe('fresh');
  });

  it('classifies the wild-caught woodcut refinements as revise', () => {
    // The exact messages from the session that motivated this module.
    expect(classifyImageFollowUp('but with no letting at the bottom?', true)).toBe('revise');
    expect(classifyImageFollowUp('no lettering at the bottom?', true)).toBe('revise');
    expect(classifyImageFollowUp('remove the border', true)).toBe('revise');
    expect(classifyImageFollowUp('without the caption please', true)).toBe('revise');
  });

  it('classifies additive and attribute tweaks as edit', () => {
    expect(classifyImageFollowUp('add a red hat', true)).toBe('edit');
    expect(classifyImageFollowUp('make it darker', true)).toBe('edit');
    expect(classifyImageFollowUp('darker', true)).toBe('edit');
    expect(classifyImageFollowUp('a bit warmer', true)).toBe('edit');
    expect(classifyImageFollowUp('zoom out', true)).toBe('edit');
    expect(classifyImageFollowUp('with a windmill in the distance', true)).toBe('edit');
    expect(classifyImageFollowUp('the text should be bigger', true)).toBe('edit');
  });

  it('classifies do-overs as variation', () => {
    expect(classifyImageFollowUp('another one', true)).toBe('variation');
    expect(classifyImageFollowUp('try again', true)).toBe('variation');
    expect(classifyImageFollowUp('regenerate', true)).toBe('variation');
    expect(classifyImageFollowUp('one more?', true)).toBe('variation');
  });

  it('keeps self-contained new requests fresh even with a previous image', () => {
    expect(classifyImageFollowUp('a watercolor of a lighthouse at dawn', true)).toBe('fresh');
    expect(classifyImageFollowUp('draw a picture of a red barn', true)).toBe('fresh');
    expect(classifyImageFollowUp('generate an image of two cats playing chess', true)).toBe(
      'fresh',
    );
    expect(classifyImageFollowUp('a portrait of a king and his crown', true)).toBe('fresh');
    // Long descriptive prompts with internal antecedents stay fresh.
    expect(
      classifyImageFollowUp(
        'a wizard standing on a cliff with mountains in the background and lightning in the sky',
        true,
      ),
    ).toBe('fresh');
  });
});

describe('parseImageRefinementReply', () => {
  it('parses the two-line contract', () => {
    const parsed = parseImageRefinementReply(
      'PROMPT: woodcut style image of a dutch artisan craftsman, clean composition\nAVOID: lettering, text',
    );
    expect(parsed).toEqual({
      prompt: 'woodcut style image of a dutch artisan craftsman, clean composition',
      avoid: 'lettering, text',
    });
  });

  it('tolerates think blocks, labels in bold, and AVOID: none', () => {
    const parsed = parseImageRefinementReply(
      '<think>the user wants no text</think>\n**Prompt**: a woodcut craftsman at his bench\n**Avoid** — none',
    );
    expect(parsed?.prompt).toBe('a woodcut craftsman at his bench');
    expect(parsed?.avoid).toBeUndefined();
  });

  it('accepts a bare unlabeled paragraph as the prompt', () => {
    const parsed = parseImageRefinementReply(
      '"a woodcut style dutch craftsman in his workshop, no borders"',
    );
    expect(parsed?.prompt).toBe('a woodcut style dutch craftsman in his workshop, no borders');
  });

  it('rejects unusable replies', () => {
    expect(parseImageRefinementReply('')).toBeNull();
    expect(parseImageRefinementReply('ok')).toBeNull();
    expect(parseImageRefinementReply('<think>hmm</think>')).toBeNull();
  });
});

describe('heuristicRefinementComposition', () => {
  it('routes removals into the negative prompt and keeps the previous prompt', () => {
    const out = heuristicRefinementComposition(PREV, 'no lettering at the bottom?');
    expect(out.prompt).toBe(PREV.prompt);
    expect(out.negativePrompt).toBe('lettering at the bottom');
  });

  it('strips the leading connective and appends additive refinements', () => {
    const out = heuristicRefinementComposition(PREV, 'but with a windmill behind him');
    expect(out.prompt).toBe(`${PREV.prompt}, with a windmill behind him`);
    expect(out.negativePrompt).toBeUndefined();
  });

  it('merges removals with an existing negative prompt without duplicates', () => {
    const out = heuristicRefinementComposition(
      { ...PREV, negativePrompt: 'blurry, lettering' },
      'remove the lettering and the border',
    );
    expect(out.prompt).toBe(PREV.prompt);
    expect(out.negativePrompt).toBe('blurry, lettering, border');
  });
});

describe('composeImageRefinementPrompt', () => {
  it('uses the one-shot reply when it parses', async () => {
    const inputs: string[] = [];
    const out = await composeImageRefinementPrompt(
      PREV,
      'no lettering at the bottom',
      async (input) => {
        inputs.push(input);
        return 'PROMPT: woodcut style image of a dutch artisan craftsman, clean lower edge\nAVOID: lettering, text, captions';
      },
    );
    expect(inputs[0]).toBe(buildImageRefinementInput(PREV.prompt, 'no lettering at the bottom'));
    expect(out.prompt).toBe('woodcut style image of a dutch artisan craftsman, clean lower edge');
    expect(out.negativePrompt).toBe('lettering, text, captions');
  });

  it('falls back to the heuristic when the one-shot throws', async () => {
    const out = await composeImageRefinementPrompt(PREV, 'no lettering at the bottom', async () => {
      throw new Error('engine busy');
    });
    expect(out.prompt).toBe(PREV.prompt);
    expect(out.negativePrompt).toBe('lettering at the bottom');
  });

  it('falls back when the model just echoes the refinement', async () => {
    const out = await composeImageRefinementPrompt(
      PREV,
      'but with a windmill behind him',
      async () => 'But with a windmill behind him.',
    );
    expect(out.prompt).toBe(`${PREV.prompt}, with a windmill behind him`);
  });
});

describe('tool-summary extractors', () => {
  const SUMMARY =
    'Generated 512×512 image with flux-2-klein-4b-q4 (seed 603565817, 4 steps, 830ms). ' +
    'The user already sees this image inline below the tool call — DO NOT embed it again as Markdown. ' +
    'To read its bytes, call `read_artifact` with path `generated/image-2026-08-03-603565817.png`.';

  it('extracts seed, model, and artifact path from the generate_image summary', () => {
    expect(extractGeneratedImageSeed(SUMMARY)).toBe(603565817);
    expect(extractGeneratedImageModel(SUMMARY)).toBe('flux-2-klein-4b-q4');
    expect(extractGeneratedImageArtifactPath(SUMMARY)).toBe(
      'generated/image-2026-08-03-603565817.png',
    );
  });

  it('degrades to undefined on unrecognized text', () => {
    expect(extractGeneratedImageSeed('nope')).toBeUndefined();
    expect(extractGeneratedImageModel('nope')).toBeUndefined();
    expect(extractGeneratedImageArtifactPath('nope')).toBeUndefined();
  });
});
