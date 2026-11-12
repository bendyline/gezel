import type { CatalogService } from '@bendyline/gezel-catalog';
import { describe, expect, it } from 'vitest';
import type { Store } from '../fs/store.js';
import { resolveExecutionModelFor } from './generalist-continuity.js';

function stubs(opts: {
  defaultModel?: Record<string, string>;
  gezel?: { model?: string; tuning?: unknown };
  manifests?: Record<string, { parameterSize?: string; tuning?: unknown }>;
}) {
  const store = {
    readConfig: async () => ({ defaultModel: opts.defaultModel ?? {} }),
    getGezel: async () => (opts.gezel ? { parsed: { frontmatter: { ...opts.gezel } } } : null),
  } as unknown as Store;
  const catalog = {
    get: async (_kind: string, id: string) => {
      const manifest = opts.manifests?.[id];
      return manifest ? { manifest: { kind: 'chat-model', id, ...manifest } } : null;
    },
    list: async () => [],
  } as unknown as CatalogService;
  return { store, catalog };
}

describe('resolveExecutionModelFor', () => {
  const manifests = {
    'gemma4-e4b-q4': {
      parameterSize: '8B',
      tuning: { taskStrategy: { strategy: 'outcome', procedure: 'none' } },
    },
    'qwen3.8-27b-q4': { parameterSize: '27B', tuning: { taskStrategy: { strategy: 'outcome' } } },
  };

  it("reads the catalog pick for the install's default model", async () => {
    const profile = await resolveExecutionModelFor({
      ...stubs({ defaultModel: { 'llama-cpp': 'gemma4-e4b-q4' }, manifests }),
      providerName: 'llama-cpp',
    });
    expect(profile.modelId).toBe('gemma4-e4b-q4');
    expect(profile.affinity).toEqual({ strategy: 'outcome', procedure: 'none' });
  });

  it("follows the gezel's pinned model, and its own pick wins over the catalog's", async () => {
    const pinned = await resolveExecutionModelFor({
      ...stubs({
        defaultModel: { 'llama-cpp': 'gemma4-e4b-q4' },
        gezel: { model: 'qwen3.8-27b-q4' },
        manifests,
      }),
      providerName: 'llama-cpp',
      gezelId: 'g1',
    });
    expect(pinned.modelId).toBe('qwen3.8-27b-q4');
    expect(pinned.tier).toBe('medium');
    expect(pinned.affinity).toEqual({ strategy: 'outcome' });
    const overridden = await resolveExecutionModelFor({
      ...stubs({
        gezel: { model: 'qwen3.8-27b-q4', tuning: { taskStrategy: { strategy: 'stepwise' } } },
        manifests,
      }),
      providerName: 'llama-cpp',
      gezelId: 'g1',
    });
    expect(overridden.affinity).toEqual({ strategy: 'stepwise' });
  });

  it("carries the review the model's outcome work was measured to gain from", async () => {
    const profile = await resolveExecutionModelFor({
      ...stubs({
        defaultModel: { 'llama-cpp': 'qwen3.8-27b-q4' },
        manifests: {
          'qwen3.8-27b-q4': {
            parameterSize: '27B',
            tuning: { taskStrategy: { strategy: 'outcome', procedure: 'none', review: 'self' } },
          },
        },
      }),
      providerName: 'llama-cpp',
    });
    expect(profile.affinity?.review).toBe('self');
  });

  it('treats a cloud provider as the cloud tier and finds no catalog pick', async () => {
    const profile = await resolveExecutionModelFor({
      ...stubs({ defaultModel: { anthropic: 'claude-opus-5-5' }, manifests }),
      providerName: 'anthropic',
    });
    expect(profile.tier).toBe('cloud');
    expect(profile.affinity).toBeUndefined();
  });

  it('reads a measured hosted model from the hosted-model table, only through its provider', async () => {
    const sonnet = await resolveExecutionModelFor({
      ...stubs({ defaultModel: { anthropic: 'claude-sonnet-5-5' }, manifests }),
      providerName: 'anthropic',
    });
    expect(sonnet.affinity).toEqual({ strategy: 'outcome', procedure: 'advisory' });
    const elsewhere = await resolveExecutionModelFor({
      ...stubs({ defaultModel: { 'anthropic-cli': 'claude-sonnet-5-5' }, manifests }),
      providerName: 'anthropic-cli',
    });
    expect(elsewhere.affinity).toBeUndefined();
    const pinned = await resolveExecutionModelFor({
      ...stubs({
        defaultModel: { anthropic: 'claude-sonnet-5-5' },
        gezel: { tuning: { taskStrategy: { strategy: 'generalist' } } },
        manifests,
      }),
      providerName: 'anthropic',
      gezelId: 'g1',
    });
    expect(pinned.affinity).toEqual({ strategy: 'generalist' });
  });

  it("reads the provider's own default model when nothing names one", async () => {
    const codex = await resolveExecutionModelFor({
      ...stubs({ manifests }),
      providerName: 'codex-cli',
    });
    expect(codex.affinity).toEqual({ strategy: 'outcome', procedure: 'none' });
    expect(codex.modelId).toBeUndefined();
    const opus = await resolveExecutionModelFor({
      ...stubs({ manifests }),
      providerName: 'anthropic',
    });
    expect(opus.affinity).toBeUndefined();
  });
});
