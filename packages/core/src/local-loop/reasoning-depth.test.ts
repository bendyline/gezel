import { describe, expect, it } from 'vitest';
import {
  CONSTRAINED_TURN_REASONING_DEPTH,
  REASONING_DEPTH_TEMPLATE_KWARGS,
  downgradeReasoningDepthKwargs,
} from './reasoning-depth.js';

describe('downgradeReasoningDepthKwargs', () => {
  it('downgrades a declared reasoning_effort and reports it', () => {
    // The qwen3.8 case: the HF template resolves
    // `reasoning_effort|default('xhigh')` INSIDE its thinking branch, so
    // flipping enable_thinking alone leaves depth at the most expensive
    // setting the model has.
    const body: Record<string, unknown> = {
      chat_template_kwargs: { enable_thinking: false, reasoning_effort: 'xhigh' },
    };
    expect(downgradeReasoningDepthKwargs(body)).toEqual(['reasoning_effort']);
    expect(body.chat_template_kwargs).toEqual({
      enable_thinking: false,
      reasoning_effort: CONSTRAINED_TURN_REASONING_DEPTH,
    });
  });

  it('downgrades reasoning_strength for templates that read only that dial', () => {
    // Muse Glimmer has no enable_thinking at all, so the depth dial is the
    // ONLY lever that reaches its template.
    const body: Record<string, unknown> = {
      chat_template_kwargs: { reasoning_strength: 'high' },
    };
    expect(downgradeReasoningDepthKwargs(body)).toEqual(['reasoning_strength']);
    expect(body.chat_template_kwargs).toEqual({ reasoning_strength: 'low' });
  });

  it('never invents a dial the model did not declare', () => {
    // Qwen 3.8's jinja calls raise_exception on an unexpected effort value,
    // so writing a key the template does not read would trade a silent
    // divergence for a hard template failure.
    const body: Record<string, unknown> = { chat_template_kwargs: { enable_thinking: false } };
    expect(downgradeReasoningDepthKwargs(body)).toEqual([]);
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
  });

  it('reports nothing when the dial is already low, so logs do not claim a no-op change', () => {
    const body: Record<string, unknown> = { chat_template_kwargs: { reasoning_effort: 'low' } };
    expect(downgradeReasoningDepthKwargs(body)).toEqual([]);
  });

  it('tolerates a body with no chat_template_kwargs at all', () => {
    const body: Record<string, unknown> = { max_tokens: 4096 };
    expect(downgradeReasoningDepthKwargs(body)).toEqual([]);
    expect(body.chat_template_kwargs).toBeUndefined();
  });

  it('leaves unrelated kwargs untouched', () => {
    const body: Record<string, unknown> = {
      chat_template_kwargs: { reasoning_effort: 'xhigh', add_generation_prompt: true },
    };
    downgradeReasoningDepthKwargs(body);
    expect(body.chat_template_kwargs).toEqual({
      reasoning_effort: 'low',
      add_generation_prompt: true,
    });
  });

  it('knows both depth dials', () => {
    expect([...REASONING_DEPTH_TEMPLATE_KWARGS].sort()).toEqual([
      'reasoning_effort',
      'reasoning_strength',
    ]);
  });
});
