import type { ResolvedTuning } from '@bendyline/gezel-inference/internal/model-profile/tuning';
import { describe, expect, it } from 'vitest';
import {
  anthropicDefaultReasoningEffort,
  anthropicReasoningEfforts,
  buildAnthropicGenerationOptions,
} from './anthropic-options.js';

function tuning(overrides: Partial<ResolvedTuning>): ResolvedTuning {
  return {
    sampling: {},
    reasoning: {},
    output: {},
    promptTags: {},
    wasThinking: false,
    ...overrides,
  };
}

describe('Sonnet 5.5 request options', () => {
  it('uses adaptive thinking with readable summaries and the documented default effort', () => {
    expect(buildAnthropicGenerationOptions('claude-sonnet-5-5')).toEqual({
      model: 'claude-sonnet-5-5',
      max_tokens: 16384,
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'high' },
    });
    expect(anthropicDefaultReasoningEffort('claude-sonnet-5-5')).toBe('high');
  });

  it.each(['low', 'medium', 'high', 'xhigh', 'max'])('supports %s effort', (effort) => {
    expect(anthropicReasoningEfforts('claude-sonnet-5-5')).toContain(effort);
    expect(buildAnthropicGenerationOptions('claude-sonnet-5-5', effort).output_config).toEqual({
      effort,
    });
  });

  it('removes incompatible saved sampling and thinking budgets while honoring output limits', () => {
    const settings = tuning({
      sampling: { temperature: 0.7, topP: 0.9, topK: 40, maxTokens: 8192 },
      reasoning: { effort: 'low', thinkingBudget: 4096 },
    });
    const original = structuredClone(settings);
    expect(buildAnthropicGenerationOptions('claude-sonnet-5-5', 'high', settings)).toEqual({
      model: 'claude-sonnet-5-5',
      max_tokens: 8192,
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'low' },
    });
    expect(settings).toEqual(original);
  });

  it('does not invent an effort mapping for a legacy token budget', () => {
    const request = buildAnthropicGenerationOptions(
      'claude-sonnet-5-5',
      undefined,
      tuning({ reasoning: { thinkingBudget: 2048 } }),
    );
    expect(request.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
    expect(request.output_config).toEqual({ effort: 'high' });
  });

  it('uses between_tools without extra thinking fields when up-front thinking is disabled', () => {
    const request = buildAnthropicGenerationOptions(
      'claude-sonnet-5-5',
      'medium',
      tuning({ reasoning: { enableThinking: false, thinkingBudget: 4096 } }),
    );
    expect(request.thinking).toEqual({ type: 'between_tools' });
    expect(request.output_config).toEqual({ effort: 'medium' });
  });

  it.each(['xhigh', 'max'])(
    'rejects disabled thinking with %s before sending a request',
    (effort) => {
      expect(() =>
        buildAnthropicGenerationOptions(
          'claude-sonnet-5-5',
          effort,
          tuning({ reasoning: { enableThinking: false } }),
        ),
      ).toThrow(`requires adaptive thinking at ${effort} effort`);
    },
  );

  it('rejects unknown effort values before sending a request', () => {
    expect(() => buildAnthropicGenerationOptions('claude-sonnet-5-5', 'typo')).toThrow(
      'does not support reasoning effort "typo"',
    );
  });

  it.each([
    ['auto', 'auto'],
    ['required', 'auto'],
    ['none', 'none'],
  ] as const)('translates %s tool choice to the supported %s object', (toolChoice, type) => {
    const request = buildAnthropicGenerationOptions(
      'claude-sonnet-5-5',
      undefined,
      tuning({ toolChoice }),
    );
    expect(request.tool_choice).toEqual({ type });
  });
});

describe('current-generation request options', () => {
  it.each([
    ['claude-opus-5-5', 'medium'],
    ['claude-fable-5-1', 'high'],
    ['claude-fable-5', 'high'],
    ['claude-mythos-5-1', 'high'],
    ['claude-opus-5', 'high'],
    ['claude-opus-4-8', 'high'],
    ['claude-opus-4-7', 'high'],
    ['claude-haiku-5-5', 'medium'],
  ])('sends %s adaptive thinking at its documented default effort', (model, effort) => {
    expect(anthropicReasoningEfforts(model)).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(anthropicDefaultReasoningEffort(model)).toBe(effort);
    expect(buildAnthropicGenerationOptions(model)).toEqual({
      model,
      max_tokens: 16384,
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort },
    });
  });

  it('never sends a thinking budget or sampling to Opus 4.7 and later', () => {
    const request = buildAnthropicGenerationOptions(
      'claude-opus-4-8',
      'high',
      tuning({ sampling: { temperature: 0.7, topP: 0.9 }, reasoning: { thinkingBudget: 4096 } }),
    );
    expect(request).toEqual({
      model: 'claude-opus-4-8',
      max_tokens: 16384,
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'high' },
    });
  });

  it.each(['claude-opus-5-5', 'claude-fable-5-1'])(
    'keeps %s thinking on when a setting asks to disable it',
    (model) => {
      const request = buildAnthropicGenerationOptions(
        model,
        'low',
        tuning({ reasoning: { enableThinking: false } }),
      );
      expect(request.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
      expect(request.output_config).toEqual({ effort: 'low' });
    },
  );

  it.each(['claude-opus-5', 'claude-haiku-5-5'])(
    'disables %s thinking only at high effort or below',
    (model) => {
      const off = tuning({ reasoning: { enableThinking: false } });
      expect(buildAnthropicGenerationOptions(model, 'high', off).thinking).toEqual({
        type: 'disabled',
      });
      expect(() => buildAnthropicGenerationOptions(model, 'max', off)).toThrow(
        'requires adaptive thinking at max effort',
      );
    },
  );

  it('accepts disabled thinking on Opus 4.8 at any effort', () => {
    expect(
      buildAnthropicGenerationOptions(
        'claude-opus-4-8',
        'max',
        tuning({ reasoning: { enableThinking: false } }),
      ).thinking,
    ).toEqual({ type: 'disabled' });
  });

  it.each([
    ['claude-opus-5-5', 'auto'],
    ['claude-fable-5-1', 'auto'],
    ['claude-fable-5', 'any'],
    ['claude-opus-5', 'any'],
  ])('sends %s a required tool choice as %s', (model, type) => {
    expect(
      buildAnthropicGenerationOptions(model, undefined, tuning({ toolChoice: 'required' }))
        .tool_choice,
    ).toEqual({ type });
  });

  it('shares a family contract with its dated snapshot but not with a newer point release', () => {
    expect(anthropicDefaultReasoningEffort('claude-opus-5-20260301')).toBe('high');
    expect(anthropicDefaultReasoningEffort('claude-opus-5-5')).toBe('medium');
  });

  it('leaves an unrecognized future model on its API defaults', () => {
    expect(anthropicReasoningEfforts('claude-opus-6')).toBeUndefined();
    expect(buildAnthropicGenerationOptions('claude-opus-6', 'high')).toEqual({
      model: 'claude-opus-6',
      max_tokens: 16384,
    });
  });
});

describe('older Anthropic model compatibility', () => {
  it('raises max_tokens above a high thinking budget', () => {
    expect(buildAnthropicGenerationOptions('claude-sonnet-4-5', 'high')).toEqual({
      model: 'claude-sonnet-4-5',
      max_tokens: 16384 + 8192,
      thinking: { type: 'enabled', budget_tokens: 16384 },
    });
  });

  it('retains manual thinking budgets on Sonnet 4.6', () => {
    expect(buildAnthropicGenerationOptions('claude-sonnet-4-6', 'medium')).toEqual({
      model: 'claude-sonnet-4-6',
      max_tokens: 16384,
      thinking: { type: 'enabled', budget_tokens: 4096 },
    });
    expect(anthropicReasoningEfforts('claude-sonnet-4-6')).toEqual(['low', 'medium', 'high']);
    expect(anthropicDefaultReasoningEffort('claude-sonnet-4-6')).toBe('medium');
  });

  it('retains legacy explicit tuning and formats forced tool choice for the Messages API', () => {
    expect(
      buildAnthropicGenerationOptions(
        'claude-sonnet-4-6',
        'medium',
        tuning({
          reasoning: { thinkingBudget: 8192 },
          sampling: { temperature: 1, topP: 0.9, topK: 40 },
          toolChoice: 'required',
        }),
      ),
    ).toMatchObject({
      thinking: { type: 'enabled', budget_tokens: 8192 },
      temperature: 1,
      top_p: 0.9,
      top_k: 40,
      tool_choice: { type: 'any' },
    });
  });

  it('keeps non-reasoning models free of automatic thinking settings', () => {
    expect(buildAnthropicGenerationOptions('claude-3-5-sonnet-20241022')).toEqual({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 16384,
    });
  });

  it('uses Sonnet 5 adaptive thinking but its older disabled setting', () => {
    expect(anthropicReasoningEfforts('claude-sonnet-5')).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
    expect(buildAnthropicGenerationOptions('claude-sonnet-5', 'medium').thinking).toEqual({
      type: 'adaptive',
      display: 'summarized',
    });
    expect(
      buildAnthropicGenerationOptions(
        'claude-sonnet-5',
        'medium',
        tuning({ reasoning: { enableThinking: false } }),
      ).thinking,
    ).toEqual({ type: 'disabled' });
  });
});
