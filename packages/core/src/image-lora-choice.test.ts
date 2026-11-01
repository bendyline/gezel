import { describe, expect, it } from 'vitest';
import { type ImageLoraCandidate, chooseImageLoras } from './image-lora-choice.js';

const fast: ImageLoraCandidate = {
  id: 'qwen-edit-lightning',
  name: 'Fast mode',
  purpose: 'speed',
  steps: 4,
};
const anime: ImageLoraCandidate = { id: 'qwen-edit-anime', name: 'Anime', purpose: 'style' };
const papercut: ImageLoraCandidate = {
  id: 'qwen-edit-papercut',
  name: '3D paper cut',
  purpose: 'style',
};
const available = [fast, anime, papercut];

describe('chooseImageLoras', () => {
  it('uses fast mode when it is on, and the style asked for by id or name', () => {
    expect(chooseImageLoras(available, { fast: true }).loras).toEqual([fast]);
    expect(chooseImageLoras(available, { fast: false, style: 'qwen-edit-anime' }).loras).toEqual([
      anime,
    ]);
    expect(chooseImageLoras(available, { fast: true, style: 'anime' }).loras).toEqual([
      fast,
      anime,
    ]);
    expect(chooseImageLoras(available, { fast: false, style: 'paper' }).loras).toEqual([papercut]);
  });

  it('leaves fast mode off when more steps are asked than it renders in', () => {
    const choice = chooseImageLoras(available, { fast: true, askedSteps: 30 });
    expect(choice.loras).toEqual([]);
    expect(choice.notes).toEqual(['Fast mode was left off for the 30 steps asked.']);
    expect(chooseImageLoras(available, { fast: true, askedSteps: 4 }).loras).toEqual([fast]);
  });

  it('never fails on a style it cannot find, and names the ones there are', () => {
    const choice = chooseImageLoras(available, { fast: false, style: 'watercolor' });
    expect(choice.loras).toEqual([]);
    expect(choice.notes).toEqual([
      'No "watercolor" style for this model, so it was drawn without one. Its styles: Anime, 3D paper cut.',
    ]);
    expect(choice.styles).toEqual([
      { id: 'qwen-edit-anime', name: 'Anime' },
      { id: 'qwen-edit-papercut', name: '3D paper cut' },
    ]);
    expect(chooseImageLoras([], { fast: true, style: 'anime' }).notes).toEqual([
      'This model has no styles installed, so "anime" was left out.',
    ]);
  });

  it('treats an empty style as none', () => {
    expect(chooseImageLoras(available, { fast: false, style: '' })).toEqual({
      loras: [],
      notes: [],
      styles: [
        { id: 'qwen-edit-anime', name: 'Anime' },
        { id: 'qwen-edit-papercut', name: '3D paper cut' },
      ],
    });
  });
});
