import type { MobileModel } from '@bendyline/gezel/mobile-providers';
import { describe, expect, it, vi } from 'vitest';
import { modelChoices } from './ModelChooser.js';
import {
  VISION_DESCRIBER,
  cleanDescription,
  createVisionModelDescriber,
  isProjectorModel,
  visionDescriberInstall,
} from './vision-model.js';

const source = (
  part: typeof VISION_DESCRIBER.model | typeof VISION_DESCRIBER.projector,
  sizeBytes: number,
) => ({
  ...part,
  sizeBytes,
});
const chatModel: MobileModel = {
  id: 'model-a',
  name: 'Qwen 3.5 (0.8B, Q4)',
  sizeBytes: VISION_DESCRIBER.modelBytes,
  source: source(VISION_DESCRIBER.model, VISION_DESCRIBER.modelBytes),
};
const projector: MobileModel = {
  id: 'projector-a',
  name: 'Qwen 3.5 vision projector',
  sizeBytes: VISION_DESCRIBER.projectorBytes,
  source: source(VISION_DESCRIBER.projector, VISION_DESCRIBER.projectorBytes),
};

function runtime(models: MobileModel[], memoryBudgetBytes?: number) {
  return {
    listModels: vi.fn(async () => ({
      models,
      ...(memoryBudgetBytes ? { memoryBudgetBytes } : {}),
    })),
    describeImage: vi.fn(async () => ({
      status: 'ok' as const,
      description: '<think>\n\n</think>\n\nA dog asleep on a striped rug.',
    })),
    cancel: vi.fn(async () => {}),
  };
}

describe('vision model fallback', () => {
  it('knows a projector from a chat model', () => {
    expect(isProjectorModel(projector)).toBe(true);
    expect(isProjectorModel(chatModel)).toBe(false);
    expect(isProjectorModel({ name: 'imported.gguf' })).toBe(false);
  });

  it('keeps projectors out of the chat model list', () => {
    const { groups } = modelChoices({
      providers: [],
      selectedProviderId: 'llama-cpp',
      inventory: { models: [chatModel, projector] },
      catalog: [],
      native: true,
    });
    expect(groups.flatMap(({ choices }) => choices.map(({ value }) => value))).toEqual([
      'model:model-a',
    ]);
  });

  it('reports what is missing, and refuses a phone without the memory', async () => {
    expect(await visionDescriberInstall(runtime([]))).toMatchObject({
      state: 'not-installed',
      missingBytes: VISION_DESCRIBER.modelBytes + VISION_DESCRIBER.projectorBytes,
    });
    // A chat download of the same file counts toward the pair.
    expect(await visionDescriberInstall(runtime([chatModel]))).toMatchObject({
      state: 'not-installed',
      modelId: 'model-a',
      missingBytes: VISION_DESCRIBER.projectorBytes,
    });
    expect(await visionDescriberInstall(runtime([chatModel, projector]))).toMatchObject({
      state: 'ready',
      modelId: 'model-a',
      projectorId: 'projector-a',
    });
    expect(
      (await visionDescriberInstall(runtime([chatModel, projector], 1024 * 1024 * 1024))).state,
    ).toBe('unavailable');
    expect((await visionDescriberInstall({ listModels: async () => ({ models: [] }) })).state).toBe(
      'unavailable',
    );
  });

  it('describes with the installed pair and the shared prompt', async () => {
    const native = runtime([chatModel, projector]);
    const result = await createVisionModelDescriber(native).describe({
      data: new Uint8Array([1, 2, 3]),
      mimeType: 'image/jpeg',
      signal: new AbortController().signal,
    });
    expect(result).toEqual({
      description: 'A dog asleep on a striped rug.',
      model: 'llama-cpp:qwen3.5-0.8b-q4',
    });
    expect(native.describeImage).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: 'model-a',
        projectorId: 'projector-a',
        image: btoa(String.fromCharCode(1, 2, 3)),
        maxTokens: 400,
      }),
    );
  });

  it('cleans a reasoning block a small model opens with', () => {
    expect(cleanDescription('<think>pondering</think> A cat.')).toBe('A cat.');
    expect(cleanDescription('half a thought</think>\nA cat.')).toBe('A cat.');
    expect(cleanDescription('  A cat.  ')).toBe('A cat.');
  });
});
