import { describe, expect, it } from 'vitest';
import { hostedModelTaskStrategy, resolveAutoTaskStrategy } from './task-strategy.js';

describe('hostedModelTaskStrategy', () => {
  it('finds a measured hosted model only through the provider it was measured on', () => {
    expect(hostedModelTaskStrategy('anthropic', 'claude-sonnet-5-5')).toEqual({
      strategy: 'outcome',
      procedure: 'advisory',
    });
    expect(hostedModelTaskStrategy('anthropic-cli', 'claude-sonnet-5-5')).toBeUndefined();
    expect(hostedModelTaskStrategy('anthropic', 'claude-opus-5-5')).toBeUndefined();
    expect(hostedModelTaskStrategy('anthropic', undefined)).toBeUndefined();
    expect(hostedModelTaskStrategy('codex-cli', 'gpt-6.1-sol')).toEqual({
      strategy: 'outcome',
      procedure: 'none',
    });
    expect(hostedModelTaskStrategy('openai', 'gpt-6.1-sol')).toBeUndefined();
  });

  it('makes auto run GPT-6.1 Sol through Codex as an outcome with no recipe', () => {
    const affinity = hostedModelTaskStrategy('codex-cli', 'gpt-6.1-sol');
    expect(resolveAutoTaskStrategy({ providerName: 'codex-cli', tier: 'cloud', affinity })).toEqual(
      {
        strategy: 'outcome',
        options: { procedure: 'none' },
        source: 'model',
        fallback: 'generalist',
      },
    );
  });

  it('makes auto run Sonnet 5.5 as an outcome with the recipe as advice', () => {
    const affinity = hostedModelTaskStrategy('anthropic', 'claude-sonnet-5-5');
    expect(resolveAutoTaskStrategy({ providerName: 'anthropic', tier: 'cloud', affinity })).toEqual(
      {
        strategy: 'outcome',
        options: { procedure: 'advisory' },
        source: 'model',
        fallback: 'generalist',
      },
    );
    expect(
      resolveAutoTaskStrategy({ generalistMode: 'off', providerName: 'anthropic', affinity })
        .strategy,
    ).toBe('stepwise');
    expect(resolveAutoTaskStrategy({ providerName: 'anthropic', tier: 'cloud' })).toEqual({
      strategy: 'outcome',
      options: { procedure: 'none' },
      source: 'tier',
      fallback: 'generalist',
    });
  });
});
