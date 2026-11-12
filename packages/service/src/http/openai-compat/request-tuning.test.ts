import {
  disablesThinking,
  overlayOllamaRequestTuning,
  overlayOpenAiRequestTuning,
} from '@bendyline/gezel-inference/internal/http/openai-compat/request-tuning';
import type { ChatCompletionRequest } from '@bendyline/gezel-inference/internal/http/openai-compat/translate';
import type { ResolvedTuning } from '@bendyline/gezel-inference/internal/model-profile/tuning';
import { describe, expect, it } from 'vitest';

const base: ResolvedTuning = {
  sampling: { temperature: 0.7, maxTokens: 8192 },
  reasoning: { enableThinking: true, thinkingBudget: 2048 },
  output: {},
  promptTags: {},
  wasThinking: true,
};

function request(extra: Partial<ChatCompletionRequest>): ChatCompletionRequest {
  return {
    model: 'llama-cpp:gemma4-31b-q4',
    messages: [{ role: 'user', content: 'hi' }],
    ...extra,
  };
}

describe('overlayOpenAiRequestTuning — reasoning_effort', () => {
  it.each(['none', 'minimal'])('turns thinking off for reasoning_effort=%s', (effort) => {
    const out = overlayOpenAiRequestTuning(base, request({ reasoning_effort: effort }));
    expect(out.reasoning).toEqual({ enableThinking: false, thinkingBudget: 2048 });
    expect(base.reasoning.enableThinking).toBe(true);
  });

  it('drops a model’s declared reasoning depth to its floor, since some templates ignore the switch', () => {
    // GPT-OSS reasons whatever enable_thinking says; its depth dial is what moves it.
    const gptOss: ResolvedTuning = {
      ...base,
      reasoning: {
        effort: 'medium',
        thinkingBudget: 6144,
        templateKwargs: { reasoning_effort: 'medium', other_flag: true },
      },
    };
    const out = overlayOpenAiRequestTuning(gptOss, request({ reasoning_effort: 'none' }));
    expect(out.reasoning).toEqual({
      effort: 'medium',
      thinkingBudget: 6144,
      enableThinking: false,
      templateKwargs: { reasoning_effort: 'low', other_flag: true },
    });
    expect(gptOss.reasoning.templateKwargs).toEqual({
      reasoning_effort: 'medium',
      other_flag: true,
    });
    const muse: ResolvedTuning = {
      ...base,
      reasoning: { enableThinking: true, templateKwargs: { reasoning_strength: 'high' } },
    };
    expect(overlayOllamaRequestTuning(muse, undefined, undefined, false).reasoning).toEqual({
      enableThinking: false,
      templateKwargs: { reasoning_strength: 'low' },
    });
    // A request that keeps reasoning keeps the model's depth.
    expect(
      overlayOpenAiRequestTuning(gptOss, request({ reasoning_effort: 'high' })).reasoning,
    ).toBe(gptOss.reasoning);
  });

  it('leaves the resolved reasoning alone for other effort values', () => {
    const out = overlayOpenAiRequestTuning(base, request({ reasoning_effort: 'high' }));
    expect(out.reasoning).toBe(base.reasoning);
  });

  it('never turns thinking on for a model whose tuning leaves it off', () => {
    const off: ResolvedTuning = { ...base, reasoning: { enableThinking: false } };
    expect(
      overlayOpenAiRequestTuning(off, request({ reasoning_effort: 'high' })).reasoning,
    ).toEqual({
      enableThinking: false,
    });
  });

  it('keeps sampling and structured output overlays alongside it', () => {
    const out = overlayOpenAiRequestTuning(
      base,
      request({
        reasoning_effort: 'none',
        temperature: 0.1,
        max_tokens: 900,
        response_format: { type: 'json_schema', json_schema: { schema: { type: 'object' } } },
      }),
    );
    expect(out.sampling).toMatchObject({ temperature: 0.1, maxTokens: 900 });
    expect(out.output.jsonSchema).toEqual({ type: 'object' });
    expect(out.reasoning.enableThinking).toBe(false);
  });

  it('recognizes only the off values', () => {
    expect(disablesThinking('none')).toBe(true);
    expect(disablesThinking('minimal')).toBe(true);
    expect(disablesThinking('low')).toBe(false);
    expect(disablesThinking(undefined)).toBe(false);
  });
});

describe('overlayOllamaRequestTuning — think', () => {
  it('turns thinking off for think: false and keeps the rest of the tuning', () => {
    const out = overlayOllamaRequestTuning(base, { temperature: 0.1 }, undefined, false);
    expect(out.reasoning).toEqual({ enableThinking: false, thinkingBudget: 2048 });
    expect(out.sampling.temperature).toBe(0.1);
    expect(base.reasoning.enableThinking).toBe(true);
  });

  it.each([undefined, true, 'high'])('leaves the model’s own setting for think=%s', (think) => {
    expect(overlayOllamaRequestTuning(base, undefined, undefined, think).reasoning).toBe(
      base.reasoning,
    );
  });

  it('never turns thinking on for a model whose tuning leaves it off', () => {
    const off: ResolvedTuning = { ...base, reasoning: { enableThinking: false } };
    expect(overlayOllamaRequestTuning(off, undefined, undefined, true).reasoning).toEqual({
      enableThinking: false,
    });
  });
});
