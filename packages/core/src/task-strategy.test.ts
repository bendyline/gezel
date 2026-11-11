import { describe, expect, it } from 'vitest';
import {
  hostedModelTaskStrategy,
  projectModeForTaskStrategy,
  resolveAutoTaskStrategy,
  resolveNewProjectMode,
  resolvePreferredTaskStrategy,
} from './task-strategy.js';

describe('resolveNewProjectMode', () => {
  it('gives stepwise work a crew and every single-owner strategy one gezel alone', () => {
    expect(projectModeForTaskStrategy('stepwise')).toBe('crew');
    expect(projectModeForTaskStrategy('generalist')).toBe('solo');
    expect(projectModeForTaskStrategy('outcome')).toBe('solo');
  });

  // The old kickoff rule kept a crew for every small on-device model.
  it("follows the default model's preferred strategy under auto", () => {
    for (const tier of ['tiny', 'small', 'medium', 'large']) {
      expect(resolveNewProjectMode({ providerName: 'llama-cpp', tier })).toBe('solo');
    }
    expect(resolveNewProjectMode({ providerName: 'copilot', tier: 'cloud' })).toBe('solo');
    // A model measured to work best step by step gets a crew.
    expect(resolveNewProjectMode({ providerName: 'mlx', affinity: { strategy: 'stepwise' } })).toBe(
      'crew',
    );
    // Nothing is known about this provider, so the task rule decides: stepwise.
    expect(resolveNewProjectMode({ providerName: 'mock' })).toBe('crew');
  });

  it("lets the person's own settings decide before the model", () => {
    const local = { providerName: 'llama-cpp', tier: 'small' };
    expect(resolveNewProjectMode({ ...local, generalistMode: 'off' })).toBe('crew');
    expect(resolveNewProjectMode({ providerName: 'mock', generalistMode: 'on' })).toBe('solo');
    expect(resolveNewProjectMode({ ...local, taskStrategy: 'stepwise' })).toBe('crew');
    expect(
      resolveNewProjectMode({
        providerName: 'mock',
        taskStrategy: 'outcome',
        generalistMode: 'off',
      }),
    ).toBe('solo');
    expect(resolvePreferredTaskStrategy({ ...local, taskStrategy: 'auto' })).toBe('outcome');
  });
});

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
