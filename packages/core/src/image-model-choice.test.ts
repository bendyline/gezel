import { describe, expect, it } from 'vitest';
import { type ImageModelChoiceCandidate, chooseImageModel } from './image-model-choice.js';

const sdxl: ImageModelChoiceCandidate = { id: 'sdxl-base-1.0', editMode: 'img2img' };
const krea: ImageModelChoiceCandidate = { id: 'krea-2-turbo-q4' };
const klein: ImageModelChoiceCandidate = { id: 'flux-2-klein-4b-q4', editMode: 'reference' };
const qwenEdit: ImageModelChoiceCandidate = {
  id: 'qwen-image-edit-2511-q4',
  editMode: 'reference',
  editOnly: true,
};

describe('chooseImageModel', () => {
  it('draws a fresh picture with the default, else the first model that draws', () => {
    expect(
      chooseImageModel([krea, sdxl], { defaultModelId: 'sdxl-base-1.0', hasSources: false }),
    ).toBe('sdxl-base-1.0');
    expect(chooseImageModel([krea, sdxl], { hasSources: false })).toBe('krea-2-turbo-q4');
    expect(chooseImageModel([krea], { defaultModelId: 'gone', hasSources: false })).toBe(
      'krea-2-turbo-q4',
    );
  });

  it('never hands an edit-only model a blank page, even as the default', () => {
    expect(chooseImageModel([qwenEdit, sdxl], { hasSources: false })).toBe('sdxl-base-1.0');
    expect(
      chooseImageModel([qwenEdit, sdxl], { defaultModelId: qwenEdit.id, hasSources: false }),
    ).toBe('sdxl-base-1.0');
    expect(chooseImageModel([qwenEdit], { hasSources: false })).toBeUndefined();
  });

  it('edits with a model made for editing before the default', () => {
    expect(
      chooseImageModel([klein, qwenEdit, sdxl], { defaultModelId: klein.id, hasSources: true }),
    ).toBe(qwenEdit.id);
  });

  it('prefers a default that reads references, then any model that does', () => {
    expect(
      chooseImageModel([sdxl, klein], { defaultModelId: 'sdxl-base-1.0', hasSources: true }),
    ).toBe(klein.id);
    expect(chooseImageModel([krea, klein], { defaultModelId: krea.id, hasSources: true })).toBe(
      klein.id,
    );
  });

  it('falls back to img2img, then to the default when nothing edits', () => {
    expect(chooseImageModel([krea, sdxl], { defaultModelId: krea.id, hasSources: true })).toBe(
      'sdxl-base-1.0',
    );
    expect(chooseImageModel([krea], { defaultModelId: krea.id, hasSources: true })).toBe(krea.id);
    expect(chooseImageModel([], { hasSources: true })).toBeUndefined();
  });
});
