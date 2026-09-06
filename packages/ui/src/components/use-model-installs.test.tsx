import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelInstallEvent, ModelManagementAdapter } from './model-management-adapters.js';
import { useModelInstalls } from './use-model-installs.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function setup() {
  const attempts: {
    event: (event: ModelInstallEvent) => void;
    signal: AbortSignal;
    done: ReturnType<typeof deferred>;
  }[] = [];
  const adapter: ModelManagementAdapter<{ id: string }> = {
    engine: 'mlx',
    list: vi.fn(async () => ({ models: [] })),
    incomplete: vi.fn(async () => ({ incomplete: [] })),
    active: vi.fn(async () => ({ installs: [] })),
    install: vi.fn(async (_id, event, signal) => {
      const done = deferred();
      attempts.push({ event, signal, done });
      await done.promise;
    }),
    cancel: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
  };
  const refresh = vi.fn(async () => {});
  return { adapter, attempts, refresh };
}
afterEach(() => {
  vi.useRealTimers();
});

describe('model install controller', () => {
  it('starts once per click burst and lets an inline retry survive its predecessor finalizer', async () => {
    const { adapter, attempts, refresh } = setup();
    const { result, unmount } = renderHook(() => useModelInstalls(adapter, refresh));
    act(() => {
      result.current.startInstall('model');
      result.current.startInstall('model');
    });
    expect(attempts).toHaveLength(1);
    act(() => attempts[0]!.event({ type: 'error', error: 'disconnected' }));
    act(() => result.current.retryInstall('model'));
    expect(attempts).toHaveLength(2);
    expect(attempts[0]!.signal.aborted).toBe(true);
    await act(async () => attempts[0]!.done.resolve());
    expect(result.current.installs.get('model')?.controller?.signal).toBe(attempts[1]!.signal);
    act(() => attempts[0]!.event({ type: 'error', error: 'late error' }));
    expect(result.current.installs.get('model')?.error).toBeUndefined();
    await act(async () => {
      attempts[1]!.event({ type: 'done', id: 'model' });
      attempts[1]!.done.resolve();
    });
    expect(result.current.installs.size).toBe(0);
    unmount();
  });

  it('detaches on unmount without cancelling the server job', async () => {
    const { adapter, attempts, refresh } = setup();
    const { result, unmount } = renderHook(() => useModelInstalls(adapter, refresh));
    act(() => result.current.startInstall('model'));
    unmount();
    expect(attempts[0]!.signal.aborted).toBe(true);
    attempts[0]!.done.resolve();
    await Promise.resolve();
    expect(adapter.cancel).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('cancels server jobs explicitly and ignores late progress from the detached stream', async () => {
    const { adapter, attempts, refresh } = setup();
    const { result, unmount } = renderHook(() => useModelInstalls(adapter, refresh));
    act(() => result.current.startInstall('model'));
    act(() => result.current.cancelInstall('model'));
    act(() => attempts[0]!.event({ type: 'progress', bytesWritten: 50, totalBytes: 100 }));
    expect(result.current.installs.size).toBe(0);
    expect(adapter.cancel).toHaveBeenCalledWith('model');
    await act(async () => attempts[0]!.done.resolve());
    unmount();
  });

  it('offers checksum override without a stale finalizer deleting the new attempt', async () => {
    const { adapter, attempts, refresh } = setup();
    const { result, unmount } = renderHook(() => useModelInstalls(adapter, refresh));
    act(() => result.current.startInstall('model'));
    act(() =>
      attempts[0]!.event({
        type: 'error',
        error: 'checksum',
        mismatch: { file: 'weights', expected: 'old', actual: 'new' },
      }),
    );
    expect(result.current.installMismatch?.file).toBe('weights');
    act(() => result.current.downloadAnyway('model'));
    await act(async () => attempts[0]!.done.resolve());
    expect(adapter.install).toHaveBeenLastCalledWith(
      'model',
      expect.any(Function),
      attempts[1]!.signal,
      { skipSha: true },
    );
    expect(result.current.installs.has('model')).toBe(true);
    unmount();
    attempts[1]!.done.resolve();
  });

  it('polls without overlap, preserves local progress, and refreshes only when remote jobs disappear', async () => {
    vi.useFakeTimers();
    const { adapter, attempts, refresh } = setup();
    const first = deferred();
    vi.mocked(adapter.active).mockImplementationOnce(async () => {
      await first.promise;
      return { installs: [] };
    });
    const { result, unmount } = renderHook(() => useModelInstalls(adapter, refresh));
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(adapter.active).toHaveBeenCalledTimes(1);
    await act(async () => first.resolve());
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(refresh).not.toHaveBeenCalled();
    act(() => result.current.startInstall('local'));
    act(() => attempts[0]!.event({ type: 'progress', bytesWritten: 70, totalBytes: 100 }));
    vi.mocked(adapter.active).mockResolvedValueOnce({
      installs: ['local', 'remote'].map((catalogId) => ({
        catalogId,
        bytesWritten: 1,
        totalBytes: 100,
        phase: 'downloading',
        startedAt: '',
      })),
    });
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(result.current.installs.get('local')?.bytesWritten).toBe(70);
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(result.current.installs.has('remote')).toBe(false);
    unmount();
    attempts[0]!.done.resolve();
  });
});
