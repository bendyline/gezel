import { describe, expect, it } from 'vitest';
import type { ChatModelTuning } from '../schemas/model-tuning.js';
import { portableSampling } from './portable-sampling.js';

// Shaped like the qwen3.5 catalog entries.
const qwen: ChatModelTuning = {
  sampling: { temperature: 0.7, topP: 0.8, topK: 20, minP: 0 },
  samplingWhenThinking: { temperature: 0.6, topP: 0.95 },
  reasoning: { enableThinking: true, thinkingBudget: 2048 },
  profiles: {
    'thinking-general': {
      sampling: { temperature: 0.6, topP: 0.95, topK: 20, repetitionPenalty: 1.05 },
    },
    instruct: { sampling: { temperature: 0.7, topP: 0.8, topK: 20, repetitionPenalty: 1.1 } },
  },
};

describe('phone sampling from the catalog', () => {
  it('resolves the profile layer the desktop would', () => {
    expect(portableSampling({ catalog: { tuning: qwen, reasoningFormat: 'think' } })).toEqual({
      temperature: 0.6,
      topP: 0.95,
      topK: 20,
      minP: 0,
      repetitionPenalty: 1.05,
    });
    // A non-thinking profile on a thinking turn folds `samplingWhenThinking`
    // over it, exactly as the desktop does.
    expect(
      portableSampling({ catalog: { tuning: qwen }, suggestedProfileId: 'instruct' }),
    ).toMatchObject({ temperature: 0.6, topP: 0.95, repetitionPenalty: 1.1 });
  });

  it('lets the install default and the gezel override win, in that order', () => {
    expect(
      portableSampling({
        catalog: { tuning: qwen },
        installDefault: { sampling: { temperature: 0.2 } },
        override: { sampling: { topK: 5 } },
      }),
    ).toMatchObject({ temperature: 0.2, topK: 5 });
  });

  it('keeps the engine default for a model with no catalog entry or override', () => {
    expect(portableSampling({})).toBeUndefined();
    expect(portableSampling({ catalog: { reasoningFormat: 'think' } })).toBeUndefined();
  });

  it('drops values the phone engine would refuse rather than failing the turn', () => {
    expect(
      portableSampling({
        override: {
          sampling: {
            temperature: 3,
            topK: 5000,
            topP: 0,
            minP: 1,
            repetitionPenalty: 0.9,
            repetitionContext: 99999,
            seed: -1,
          },
        },
      }),
    ).toBeUndefined();
    expect(
      portableSampling({ override: { sampling: { seed: 2 ** 32 + 7, repetitionContext: 128 } } }),
    ).toEqual({ seed: 7, repetitionContext: 128 });
  });
});
