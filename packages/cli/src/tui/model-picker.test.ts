import type { ModelInfo, ProviderName } from '@bendyline/gezel';
import type { ConfigResponse } from '@bendyline/gezel-client/node';
import { describe, expect, it } from 'vitest';
import { configuredModelProviders, loadModelChoices, modelProviderLabel } from './model-picker.js';

function config(overrides: Partial<ConfigResponse> = {}): ConfigResponse {
  return {
    provider: 'llama-cpp',
    hasGithubToken: false,
    hasOpenaiApiKey: false,
    hasAnthropicApiKey: false,
    hasBraveSearchApiKey: false,
    hasTavilyApiKey: false,
    hasWebhookBearerToken: false,
    hasWebhookBasicAuth: false,
    ...overrides,
  } as ConfigResponse;
}

describe('configuredModelProviders', () => {
  it('offers local engines and only configured remote/CLI providers', () => {
    expect(
      configuredModelProviders(
        config({
          hasOpenaiApiKey: true,
          anthropicCliStatus: { installed: false },
          codexCliStatus: { installed: true },
        }),
        { platform: 'linux', arch: 'x64', copilotAvailable: false, totalRamBytes: 64 * 1024 ** 3 },
      ),
    ).toEqual(['llama-cpp', 'ds4', 'ollama', 'openai', 'codex-cli']);
  });

  it('adds MLX on macOS and preserves Copilot for older daemons', () => {
    expect(
      configuredModelProviders(config(), {
        platform: 'darwin',
        arch: 'arm64',
        copilotAvailable: null,
        totalRamBytes: 64 * 1024 ** 3,
      }),
    ).toEqual(['mlx', 'llama-cpp', 'ds4', 'ollama', 'copilot']);
  });

  it('hides unsupported or undersized native engines but honors an external ds4 server', () => {
    expect(
      configuredModelProviders(config(), {
        platform: 'win32',
        arch: 'x64',
        copilotAvailable: false,
        totalRamBytes: 32 * 1024 ** 3,
      }),
    ).toEqual(['llama-cpp', 'ollama']);
    expect(
      configuredModelProviders(config({ ds4BaseUrl: 'http://ds4.test' }), {
        platform: 'win32',
        arch: 'x64',
        copilotAvailable: false,
        totalRamBytes: 32 * 1024 ** 3,
      }),
    ).toEqual(['llama-cpp', 'ds4', 'ollama']);
  });
});

describe('loadModelChoices', () => {
  it('flattens non-empty inventories into engine + model rows', async () => {
    const calls: ProviderName[] = [];
    const models: Partial<Record<ProviderName, ModelInfo[]>> = {
      'llama-cpp': [{ id: 'gemma', name: 'Gemma 4' }],
      'codex-cli': [{ id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', supportsReasoning: true }],
    };
    const client = {
      getCopilotStatus: async () => ({ available: false }),
      getMemoryProfile: async () => ({ totalRamBytes: 64 * 1024 ** 3 }),
      listProviderModels: async (provider: ProviderName) => {
        calls.push(provider);
        if (provider === 'ds4') throw new Error('not installed');
        return { models: models[provider] ?? [] };
      },
    };

    await expect(
      loadModelChoices(client, config({ codexCliStatus: { installed: true } }), 'linux', 'x64'),
    ).resolves.toEqual([
      {
        provider: 'llama-cpp',
        model: { id: 'gemma', name: 'Gemma 4' },
        value: 'llama-cpp:gemma',
        label: 'llama.cpp · Gemma 4',
      },
      {
        provider: 'codex-cli',
        model: { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', supportsReasoning: true },
        value: 'codex-cli:gpt-5.6-sol',
        label: 'Codex CLI · GPT-5.6 Sol',
      },
    ]);
    expect(calls).toEqual(['llama-cpp', 'ds4', 'ollama', 'codex-cli']);
  });
});

describe('modelProviderLabel', () => {
  it('keeps local engines distinguishable', () => {
    expect(modelProviderLabel('mlx')).toBe('MLX');
    expect(modelProviderLabel('llama-cpp')).toBe('llama.cpp');
    expect(modelProviderLabel('ds4')).toBe('DwarfStar (ds4)');
  });
});
