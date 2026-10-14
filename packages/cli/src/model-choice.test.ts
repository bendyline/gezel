import { describe, expect, it, vi } from 'vitest';
import {
  type ModelChoiceClient,
  formatAvailableChatModels,
  pinPulledModel,
  useChatModel,
} from './model-choice.js';
import type { BootstrapChatModel } from './tui/bootstrap.js';

function model(
  id: string,
  gb: number,
  fit: BootstrapChatModel['fit'] = 'fits',
): BootstrapChatModel {
  return {
    id,
    name: id.toUpperCase(),
    provider: 'mlx',
    approxSizeBytes: gb * 1e9,
    residentBytes: gb * 1.3e9,
    recoScore: 1,
    fit,
    attribution: 'test',
  };
}

function fakeClient(state: {
  installed: Partial<Record<'mlx' | 'llama-cpp' | 'ds4', string[]>>;
  defaultModel?: Record<string, string>;
  provider?: string;
}) {
  const updateConfig = vi.fn(async () => ({}));
  const list = (engine: 'mlx' | 'llama-cpp' | 'ds4') => async () => ({
    models: (state.installed[engine] ?? []).map((id) => ({ id })),
  });
  const client = {
    getConfig: async () => ({
      provider: state.provider ?? 'mlx',
      defaultModel: state.defaultModel ?? {},
    }),
    updateConfig,
    listMlxModels: list('mlx'),
    listLlamaCppModels: list('llama-cpp'),
    listDs4Models: list('ds4'),
  } as unknown as ModelChoiceClient;
  return { client, updateConfig };
}

describe('formatAvailableChatModels', () => {
  it('ranks the catalog with sizes, marks what is installed and in use, and names the smallest', () => {
    const text = formatAvailableChatModels({
      engine: 'mlx',
      platformDefault: 'mlx',
      ranked: [model('qwen3.8-27b-q4', 16.1), model('qwen3.5-0.8b-q4', 0.65)],
      installed: new Set(['qwen3.8-27b-q4']),
      pinned: 'qwen3.8-27b-q4',
    });
    expect(text).toContain('qwen3.8-27b-q4   16.1 GB');
    expect(text).toContain('(recommended, installed, in use)');
    expect(text).toContain('qwen3.5-0.8b-q4   650 MB');
    expect(text).toContain('The smallest is qwen3.5-0.8b-q4 (650 MB)');
    expect(text).toContain('`gezel model pull <id>`');
  });

  it('carries --provider when the engine is not the platform default', () => {
    const text = formatAvailableChatModels({
      engine: 'llama-cpp',
      platformDefault: 'mlx',
      ranked: [model('qwen3.5-0.8b-q4', 0.55)],
      installed: new Set(),
    });
    expect(text).toContain('`gezel model pull <id> --provider llama-cpp`');
    expect(text).toContain('`gezel model use <id> --provider llama-cpp`');
  });
});

describe('useChatModel', () => {
  it('switches chats to the engine that has the model and pins it', async () => {
    const { client, updateConfig } = fakeClient({
      installed: { 'llama-cpp': ['qwen3.5-0.8b-q4'] },
      defaultModel: { mlx: 'qwen3.8-27b-q4' },
      provider: 'openai',
    });
    await expect(useChatModel(client, 'qwen3.5-0.8b-q4', { platformDefault: 'mlx' })).resolves.toBe(
      'llama-cpp',
    );
    expect(updateConfig).toHaveBeenCalledWith({
      provider: 'llama-cpp',
      defaultModel: { mlx: 'qwen3.8-27b-q4', 'llama-cpp': 'qwen3.5-0.8b-q4' },
      firstRunCompleted: true,
    });
  });

  it('refuses a model that is not downloaded and says how to get it', async () => {
    const { client, updateConfig } = fakeClient({ installed: {} });
    await expect(
      useChatModel(client, 'qwen3.5-0.8b-q4', { platformDefault: 'mlx' }),
    ).rejects.toThrow('gezel model pull qwen3.5-0.8b-q4');
    expect(updateConfig).not.toHaveBeenCalled();
  });
});

describe('pinPulledModel', () => {
  it('pins the pulled model when the current default is not downloaded', async () => {
    // The daemon's first-run picker had chosen a 16 GB model the person never pulled.
    const { client, updateConfig } = fakeClient({
      installed: { mlx: ['qwen3.5-0.8b-q4'] },
      defaultModel: { mlx: 'qwen3.8-27b-q4' },
    });
    await expect(pinPulledModel(client, 'mlx', 'qwen3.5-0.8b-q4')).resolves.toBe('pinned');
    expect(updateConfig).toHaveBeenCalledWith({
      defaultModel: { mlx: 'qwen3.5-0.8b-q4' },
      firstRunCompleted: true,
    });
  });

  it('keeps a default that is downloaded', async () => {
    const { client, updateConfig } = fakeClient({
      installed: { mlx: ['qwen3.8-27b-q4', 'qwen3.5-0.8b-q4'] },
      defaultModel: { mlx: 'qwen3.8-27b-q4' },
    });
    await expect(pinPulledModel(client, 'mlx', 'qwen3.5-0.8b-q4')).resolves.toBe('kept');
    expect(updateConfig).not.toHaveBeenCalled();
  });
});
