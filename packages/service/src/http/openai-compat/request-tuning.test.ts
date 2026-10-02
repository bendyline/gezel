import { describe, expect, it } from 'vitest';
import type { ResolvedTuning } from '../../model-profile/tuning.js';
import { disablesThinking, overlayOpenAiRequestTuning } from './request-tuning.js';
import type { ChatCompletionRequest } from './translate.js';

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
