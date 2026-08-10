import type { CatalogService } from '@bendyline/gezel-catalog';
import { describe, expect, it, vi } from 'vitest';
import { createCodexSetupModelSource } from './model-source.js';

function catalog(
  entries: Record<string, { name: string; supportsTools: boolean }>,
): CatalogService {
  const manifests = Object.entries(entries).map(([id, entry]) => ({
    manifest: {
      kind: 'chat-model' as const,
      id,
      name: entry.name,
      supportsTools: entry.supportsTools,
    },
  }));
  return {
    get: vi.fn(async (_kind: string, id: string) =>
      manifests.find((item) => item.manifest.id === id),
    ),
    list: vi.fn(async () => manifests),
  } as unknown as CatalogService;
}

describe('createCodexSetupModelSource', () => {
  it('uses catalog tool capability and the admitted native context, not inventory claims', async () => {
    const resolveNativeContextWindow = vi.fn(async (_provider: string, modelId: string) =>
      modelId === 'tool-model' ? 49_152 : 131_072,
    );
    const list = createCodexSetupModelSource({
      catalog: catalog({
        'tool-model': { name: 'Tool model', supportsTools: true },
        'chat-only': { name: 'Chat only', supportsTools: false },
      }),
      listModels: async () => [
        {
          id: 'tool-model',
          name: 'Tool model · 8.0 GB · 256k ctx',
          supportsTools: true,
          contextWindow: 262_144,
        },
        {
          id: 'chat-only',
          name: 'Chat only · 4.0 GB · 128k ctx',
          // This is the blanket native claim the Codex source must override.
          supportsTools: true,
          contextWindow: 131_072,
        },
      ],
      resolveNativeContextWindow,
    });

    await expect(list('llama-cpp')).resolves.toEqual([
      {
        id: 'tool-model',
        name: 'Tool model',
        supportsTools: true,
        contextWindow: 49_152,
      },
    ]);
    expect(resolveNativeContextWindow).toHaveBeenCalledOnce();
    expect(resolveNativeContextWindow).toHaveBeenCalledWith(
      'llama-cpp',
      'tool-model',
      expect.any(AbortSignal),
    );
  });

  it('omits native models whose catalog capability or memory admission cannot be proven', async () => {
    const list = createCodexSetupModelSource({
      catalog: catalog({ admitted: { name: 'Admitted', supportsTools: true } }),
      listModels: async () => [
        { id: 'admitted', name: 'Admitted', supportsTools: true, contextWindow: 65_536 },
        { id: 'denied', name: 'Denied', supportsTools: true, contextWindow: 65_536 },
        { id: 'unknown', name: 'Unknown', supportsTools: true, contextWindow: 65_536 },
      ],
      resolveNativeContextWindow: async (_provider, modelId) => {
        if (modelId === 'admitted') return 32_768;
        throw new Error('capacity denied');
      },
    });

    await expect(list('mlx')).resolves.toEqual([
      { id: 'admitted', name: 'Admitted', supportsTools: true, contextWindow: 32_768 },
    ]);
  });

  it('uses catalog capability for known Ollama tags and runtime capability for unknown tags', async () => {
    const resolveNativeContextWindow = vi.fn();
    const list = createCodexSetupModelSource({
      catalog: catalog({
        'known-tool': { name: 'Known tool model', supportsTools: true },
        'known-chat': { name: 'Known chat model', supportsTools: false },
      }),
      listModels: async () => [
        {
          id: 'known-tool',
          name: 'known-tool:latest',
          supportsTools: false,
          contextWindow: 24_576,
        },
        {
          id: 'known-chat',
          name: 'known-chat:latest',
          supportsTools: true,
          contextWindow: 32_768,
        },
        {
          id: 'third-party:latest',
          name: 'third-party:latest',
          supportsTools: true,
          contextWindow: 16_384,
        },
      ],
      resolveNativeContextWindow,
    });

    await expect(list('ollama')).resolves.toEqual([
      {
        id: 'known-tool',
        name: 'Known tool model',
        supportsTools: true,
        contextWindow: 24_576,
      },
      {
        id: 'third-party:latest',
        name: 'third-party:latest',
        supportsTools: true,
        contextWindow: 16_384,
      },
    ]);
    expect(resolveNativeContextWindow).not.toHaveBeenCalled();
  });

  it('returns no models when provider inventory does not settle before the deadline', async () => {
    vi.useFakeTimers();
    try {
      let inventorySignal: AbortSignal | undefined;
      const list = createCodexSetupModelSource({
        catalog: catalog({}),
        listModels: (_provider, signal) => {
          inventorySignal = signal;
          return new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
        },
        resolveNativeContextWindow: vi.fn(),
        providerDeadlineMs: 25,
      });

      const pending = list('ollama');
      await vi.advanceTimersByTimeAsync(25);
      await expect(pending).resolves.toEqual([]);
      expect(inventorySignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns no models when native admission does not settle before the deadline', async () => {
    vi.useFakeTimers();
    try {
      let admissionSignal: AbortSignal | undefined;
      const list = createCodexSetupModelSource({
        catalog: catalog({ tool: { name: 'Tool model', supportsTools: true } }),
        listModels: async () => [
          { id: 'tool', name: 'Tool model', supportsTools: true, contextWindow: 262_144 },
        ],
        resolveNativeContextWindow: (_provider, _modelId, signal) => {
          admissionSignal = signal;
          return new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
        },
        providerDeadlineMs: 25,
      });

      const pending = list('llama-cpp');
      await vi.advanceTimersByTimeAsync(25);
      await expect(pending).resolves.toEqual([]);
      expect(admissionSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
