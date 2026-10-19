import { describe, expect, it } from 'vitest';
import { imagePromptGuide } from './image-prompting.js';

describe('imagePromptGuide', () => {
  it('names a sentence model that letters text and ignores negative prompts', () => {
    expect(
      imagePromptGuide({
        name: 'Krea 2 Turbo',
        promptStyle: 'sentences',
        rendersText: true,
        negativePromptHonored: false,
      }),
    ).toBe(
      'Krea 2 Turbo reads plain descriptive sentences; can letter short text: put the exact words in quotes; ignores negative prompts, so leave unwanted things out of the prompt instead.',
    );
  });

  it('names a tag model that cannot letter text', () => {
    expect(
      imagePromptGuide({
        name: 'Animagine XL 4',
        promptStyle: 'tags',
        rendersText: false,
        negativePromptHonored: true,
      }),
    ).toBe(
      'Animagine XL 4 reads comma-separated booru tags (red apple, wooden table, soft light), not sentences; cannot letter text reliably, so leave words out of the image.',
    );
  });

  it('says nothing about a model it knows nothing about', () => {
    expect(imagePromptGuide({ name: 'Mystery' })).toBeUndefined();
  });
});
