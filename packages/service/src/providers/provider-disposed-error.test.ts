import { LlamaCppProvider } from '@bendyline/gezel-inference/internal/providers/llama-cpp/provider';
import { MlxProvider } from '@bendyline/gezel-inference/internal/providers/mlx/provider';
import { ProviderDisposedError } from '@bendyline/gezel-inference/internal/providers/provider-disposal';
import { describe, expect, it, vi } from 'vitest';

describe.each([LlamaCppProvider, MlxProvider])('%s pre-start eviction', (Provider) => {
  it('exposes retirement to cached sessions and rejects before fetching or changing history', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const provider = new Provider({ baseUrl: 'http://engine.test', fetchImpl });
    const session = await provider.createSession({
      systemMessage: 'System',
      priorMessages: [{ role: 'user', content: 'Earlier' }],
    });
    const promptChars = session.estimatePromptChars?.();
    expect(session.isDisposed).toBe(false);
    await provider.shutdown();
    expect(session.isDisposed).toBe(true);
    await expect(provider.createSession({ systemMessage: 'System' })).rejects.toBeInstanceOf(
      ProviderDisposedError,
    );
    await expect(session.sendAndWait('Next')).rejects.toBeInstanceOf(ProviderDisposedError);
    await expect(
      session.sendAndWait('Consult', { queue: { lane: 'interactive', bypassQueue: true } }),
    ).rejects.toBeInstanceOf(ProviderDisposedError);
    expect(session.estimatePromptChars?.()).toBe(promptChars);
    expect(fetchImpl).not.toHaveBeenCalled();
    await session.disconnect();
  });

  it('checks retirement again after queue admission', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const provider = new Provider({ baseUrl: 'http://engine.test', fetchImpl, concurrency: 1 });
    const session = await provider.createSession({ systemMessage: 'System' });
    const release = await provider.queue.acquire({ lane: 'interactive' });
    const pending = session.sendAndWait('Next', { queue: { lane: 'interactive' } });
    const rejected = expect(pending).rejects.toBeInstanceOf(ProviderDisposedError);
    await provider.shutdown();
    release();
    await rejected;
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(provider.queue.snapshot().running).toBe(0);
    await session.disconnect();
  });
});
