import type { GezelConfig } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import type { InferenceContext } from '../inference-context.js';
import { resolvePinnedModelTarget } from './chat-target.js';

function contextWith(config: Partial<GezelConfig>): InferenceContext {
  return { store: { readConfig: async () => config } } as unknown as InferenceContext;
}

describe('resolvePinnedModelTarget', () => {
  it('answers a bare id an on-device engine pins', async () => {
    const target = await resolvePinnedModelTarget(
      contextWith({ provider: 'mlx', defaultModel: { mlx: 'qwen3.5-0.8b-q4' } }),
      'qwen3.5-0.8b-q4',
    );
    expect(target).toEqual({ provider: 'mlx', model: 'qwen3.5-0.8b-q4', systemPrefix: '' });
  });

  it('never routes a bare id to a cloud provider because it equals that provider’s default', async () => {
    const ctx = contextWith({
      provider: 'openai',
      defaultModel: { openai: 'gpt-4o', copilot: 'claude-sonnet-4.5', anthropic: 'claude-opus-4' },
    });
    expect(await resolvePinnedModelTarget(ctx, 'gpt-4o')).toBeNull();
    expect(await resolvePinnedModelTarget(ctx, 'claude-sonnet-4.5')).toBeNull();
    expect(await resolvePinnedModelTarget(ctx, 'claude-opus-4')).toBeNull();
  });

  it('keeps the on-device pin when a cloud provider pins the same id', async () => {
    const target = await resolvePinnedModelTarget(
      contextWith({
        provider: 'openai',
        defaultModel: { openai: 'shared', 'llama-cpp': 'shared' },
      }),
      'shared',
    );
    expect(target?.provider).toBe('llama-cpp');
  });
});
