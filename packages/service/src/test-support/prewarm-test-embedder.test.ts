import { describe, expect, it, vi } from 'vitest';
import { prewarmTestEmbedder } from './prewarm-test-embedder.js';

describe('prewarmTestEmbedder', () => {
  it('retries a failed download and accepts a finite verified vector', async () => {
    const embed = vi
      .fn()
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValueOnce([[0.25, -0.5, 0.75]]);

    await expect(
      prewarmTestEmbedder({ attempts: 3, retryDelayMs: 0, embed }),
    ).resolves.toBeUndefined();
    expect(embed).toHaveBeenCalledTimes(2);
  });

  it('rejects a present but unusable model result', async () => {
    await expect(
      prewarmTestEmbedder({
        attempts: 1,
        embed: async () => [[Number.NaN]],
      }),
    ).rejects.toThrow(/invalid warmup vector/);
  });

  it('reports the final failure after the bounded retry budget', async () => {
    const embed = vi.fn().mockRejectedValue(new Error('registry unavailable'));
    await expect(prewarmTestEmbedder({ attempts: 2, retryDelayMs: 0, embed })).rejects.toThrow(
      /after 2 attempts: registry unavailable/,
    );
    expect(embed).toHaveBeenCalledTimes(2);
  });
});
