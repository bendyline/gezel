import { describe, expect, it } from 'vitest';
import type { ResolvedTuning } from '../model-profile/tuning.js';
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

describe('older Anthropic model compatibility', () => {
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
