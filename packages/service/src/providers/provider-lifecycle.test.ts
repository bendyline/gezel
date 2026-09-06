import { describe, expect, it, vi } from 'vitest';
import { ProviderLifecycle } from './provider-lifecycle.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const makeProvider = () => ({
  generate: vi.fn(async () => 'done'),
  shutdown: vi.fn(async () => {}),
});

describe('ProviderLifecycle', () => {
  it.each(['reset', 'retireForMachineBroker'] as const)(
    '%s drains a late build and rejects work through its stale handle',
    async (action) => {
      const built = deferred<ReturnType<typeof makeProvider>>();
      const provider = makeProvider();
      const lifecycle = new ProviderLifecycle<ReturnType<typeof makeProvider>>(
        new Set(['generate']),
      );
      const build = vi.fn(() => built.promise);
      const first = lifecycle.current(build);
      const second = lifecycle.current(build);
      const draining = lifecycle[action]();
      built.resolve(provider);
      const [a, b] = await Promise.all([first, second]);
      expect(a).toBe(b);
      expect(build).toHaveBeenCalledTimes(1);
      await draining;
      expect(provider.shutdown).toHaveBeenCalledTimes(1);
      await expect(a.generate()).rejects.toThrow(/retired/);
      if (action === 'reset') {
        const replacement = await lifecycle.current(async () => makeProvider());
        await expect(replacement.generate()).resolves.toBe('done');
      } else await expect(lifecycle.current(build)).rejects.toThrow(/retired/);
    },
  );

  it('waits for admitted work, shares reset/retirement, and prevents a replacement build', async () => {
    const work = deferred<string>();
    const provider = makeProvider();
    provider.generate.mockImplementation(() => work.promise);
    const lifecycle = new ProviderLifecycle<typeof provider>(new Set(['generate']));
    const current = await lifecycle.current(async () => provider);
    const operation = current.generate();
    const reset = lifecycle.reset();
    const retire = lifecycle.retireForMachineBroker();
    expect(retire).toBe(reset);
    await expect(current.generate()).rejects.toThrow(/retired/);
    expect(provider.shutdown).not.toHaveBeenCalled();
    work.resolve('finished');
    await operation;
    await retire;
    expect(provider.shutdown).toHaveBeenCalledTimes(1);
  });

  it('retains a failed shutdown for retry, including after reset', async () => {
    const provider = makeProvider();
    provider.shutdown.mockRejectedValueOnce(new Error('shutdown failed'));
    const lifecycle = new ProviderLifecycle<typeof provider>(new Set(['generate']));
    await lifecycle.current(async () => provider);
    await expect(lifecycle.reset()).rejects.toThrow('shutdown failed');
    await lifecycle.retireForMachineBroker();
    await lifecycle.retireForMachineBroker();
    expect(provider.shutdown).toHaveBeenCalledTimes(2);
  });

  it('finishes retirement after a failed build without retrying the factory', async () => {
    const built = deferred<ReturnType<typeof makeProvider>>();
    const lifecycle = new ProviderLifecycle<ReturnType<typeof makeProvider>>(new Set(['generate']));
    const pending = lifecycle.current(() => built.promise);
    const rejected = expect(pending).rejects.toThrow('build failed');
    const retirement = lifecycle.retireForMachineBroker();
    built.reject(new Error('build failed'));
    await rejected;
    await retirement;
  });

  it('keeps cloud generations available across native retirement and reset', async () => {
    const lifecycle = new ProviderLifecycle<ReturnType<typeof makeProvider>>(new Set(['generate']));
    const cloud = makeProvider();
    const view = await lifecycle.current(async () => cloud, false);
    await lifecycle.retireForMachineBroker();
    await expect(view.generate()).resolves.toBe('done');
    expect(cloud.shutdown).not.toHaveBeenCalled();
    await lifecycle.reset();
    await expect(view.generate()).rejects.toThrow(/retired/);
    const replacement = await lifecycle.current(async () => makeProvider(), false);
    await expect(replacement.generate()).resolves.toBe('done');
    await expect(lifecycle.current(async () => makeProvider())).rejects.toThrow(/retired/);
  });
});
