import { act, render, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));

const { ImageModelManager } = await import('./ImageModelManager.js');
const { VideoModelManager } = await import('./VideoModelManager.js');
const { api } = await import('../api.js');

describe.each(['image', 'video'] as const)('%s download subscriptions', (kind) => {
  const Manager = kind === 'image' ? ImageModelManager : VideoModelManager;
  const listActive = kind === 'image' ? api.listActiveImagePulls : api.listActiveVideoPulls;
  const subscribe = kind === 'image' ? api.subscribeImagePull : api.subscribeVideoPull;
  const cancel = kind === 'image' ? api.cancelImagePull : api.cancelVideoPull;
  const snapshot = {
    id: 'downloading-model',
    startedAt: '2026-10-26T00:00:00Z',
    bytesWritten: 100,
    totalBytes: 1000,
    finished: false,
  };
  let listeners: Array<{
    onEvent: (event: { type: 'done'; id: string }) => void;
    signal: AbortSignal;
  }>;

  beforeEach(() => {
    listeners = [];
    vi.mocked(api.listInstalledImageModels).mockResolvedValue({ models: [] });
    vi.mocked(api.listInstalledVideoModels).mockResolvedValue({ models: [] });
    vi.mocked(api.listCatalogItems).mockResolvedValue({ items: [] });
    vi.mocked(listActive).mockResolvedValue({ pulls: [snapshot] });
    vi.mocked(subscribe).mockImplementation((_id, onEvent, signal) => {
      listeners.push({ onEvent, signal: signal! });
      return new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve()));
    });
  });

  afterEach(() => vi.useRealTimers());

  it('keeps one subscription through parent refreshes and calls the latest completion handler', async () => {
    const original = vi.fn();
    const latest = vi.fn();
    const view = render(<Manager onModelsChanged={original} />);
    await waitFor(() => expect(subscribe).toHaveBeenCalledTimes(1));

    // Settings passes a new callback whenever its status polling rerenders.
    for (let i = 0; i < 3; i++) {
      await act(async () => view.rerender(<Manager onModelsChanged={() => latest()} />));
    }
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(listActive).toHaveBeenCalledTimes(1);

    vi.useFakeTimers();
    act(() => listeners[0]!.onEvent({ type: 'done', id: snapshot.id }));
    await act(async () => vi.advanceTimersByTime(800));
    expect(latest).toHaveBeenCalledTimes(1);
    expect(original).not.toHaveBeenCalled();
  });

  it('detaches on navigation and reattaches without cancelling the service download', async () => {
    const first = render(<Manager />);
    await waitFor(() => expect(listeners).toHaveLength(1));
    first.unmount();
    expect(listeners[0]!.signal.aborted).toBe(true);
    expect(cancel).not.toHaveBeenCalled();

    const second = render(<Manager />);
    await waitFor(() => expect(listeners).toHaveLength(2));
    expect(listeners[1]!.signal.aborted).toBe(false);
    second.unmount();
    expect(listeners[1]!.signal.aborted).toBe(true);
    expect(cancel).not.toHaveBeenCalled();
  });

  it('ignores delayed completion after leaving the download view', async () => {
    const changed = vi.fn();
    const view = render(<Manager onModelsChanged={changed} />);
    await waitFor(() => expect(listeners).toHaveLength(1));
    vi.useFakeTimers();
    act(() => listeners[0]!.onEvent({ type: 'done', id: snapshot.id }));
    view.unmount();
    await act(async () => vi.advanceTimersByTime(800));
    expect(changed).not.toHaveBeenCalled();
  });

  it('owns only one listener under StrictMode effect replay', async () => {
    const view = render(
      <StrictMode>
        <Manager />
      </StrictMode>,
    );
    await waitFor(() => expect(listeners).toHaveLength(1));
    expect(listeners[0]!.signal.aborted).toBe(false);
    view.unmount();
    expect(listeners[0]!.signal.aborted).toBe(true);
  });
});
