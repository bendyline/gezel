import type { ConfigResponse } from '@bendyline/gezel-client';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';
import { useFirstRunModel } from './useFirstRunModel.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));
const { api } = await import('../api.js');

const RECOMMENDED = 'gemma4-e2b-q4';
const ON_DISK = 'qwen3.6-35b-a3b-q4';

function engineStatus(installed: boolean) {
  return {
    release: '0.1.49',
    pinned: true,
    platformKey: 'win32-x64',
    llamaBackend: 'vulkan',
    engines: [{ name: 'llama-server', installed }],
  };
}

function renderFirstRun(onModelInstalled: () => void) {
  return renderHook(() => {
    const [config, setConfig] = useState<ConfigResponse>({
      provider: 'llama-cpp',
      defaultModel: { 'llama-cpp': RECOMMENDED },
    } as ConfigResponse);
    return useFirstRunModel({
      enabled: true,
      config,
      onConfigChanged: setConfig,
      onModelInstalled,
    });
  });
}

describe('picking a model already on this computer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.listLlamaCppModels).mockResolvedValue({
      models: [{ id: ON_DISK, name: 'Qwen 3.6 35B' }],
    } as never);
    vi.mocked(api.listLlamaCppActiveInstalls).mockResolvedValue({ installs: [] } as never);
    vi.mocked(api.getCatalogItem).mockResolvedValue(null as never);
    vi.mocked(api.updateConfig).mockImplementation(
      async (patch) => ({ provider: 'llama-cpp', ...patch }) as never,
    );
  });

  it('fetches the missing engine before saying the tools are here', async () => {
    let engineInstalled = false;
    vi.mocked(api.getNativeEngineStatus).mockImplementation(
      async () => engineStatus(engineInstalled) as never,
    );
    let finishEngine!: () => void;
    vi.mocked(api.ensureNativeEngine).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishEngine = () => {
            engineInstalled = true;
            resolve();
          };
        }) as never,
    );
    const onModelInstalled = vi.fn();
    const { result } = renderFirstRun(onModelInstalled);
    await waitFor(() => expect(result.current.state.kind).toBe('needs-download'));

    await act(() => result.current.pickInstalled(ON_DISK));

    expect(result.current.state).toMatchObject({ kind: 'engine', modelId: ON_DISK });
    expect(api.ensureNativeEngine).toHaveBeenCalledWith(
      'llama-server',
      expect.any(Function),
      'vulkan',
    );
    expect(onModelInstalled).not.toHaveBeenCalled();

    await act(async () => finishEngine());
    await waitFor(() => expect(result.current.state.kind).toBe('ready'));
    expect(onModelInstalled).toHaveBeenCalledTimes(1);
  });

  it('is ready at once when the engine is already here', async () => {
    vi.mocked(api.getNativeEngineStatus).mockResolvedValue(engineStatus(true) as never);
    const onModelInstalled = vi.fn();
    const { result } = renderFirstRun(onModelInstalled);
    await waitFor(() => expect(result.current.state.kind).toBe('needs-download'));

    await act(() => result.current.pickInstalled(ON_DISK));

    expect(result.current.state.kind).toBe('ready');
    expect(api.ensureNativeEngine).not.toHaveBeenCalled();
    expect(onModelInstalled).toHaveBeenCalledTimes(1);
  });
});

const GB = 1024 ** 3;

function partial(id: string, bytes: number, resumable = true) {
  return { id, bytes, updatedAt: '2026-11-09T10:00:00.000Z', hasPartial: true, resumable };
}

/** Nothing installed, nothing in flight, the engine already here. */
function freshInstall() {
  vi.clearAllMocks();
  vi.mocked(api.listLlamaCppModels).mockResolvedValue({ models: [] } as never);
  vi.mocked(api.listLlamaCppActiveInstalls).mockResolvedValue({ installs: [] } as never);
  vi.mocked(api.listIncompleteLlamaCppModels).mockResolvedValue({ incomplete: [] } as never);
  vi.mocked(api.getCatalogItem).mockResolvedValue(null as never);
  vi.mocked(api.getNativeEngineStatus).mockResolvedValue(engineStatus(true) as never);
  vi.mocked(api.cancelLlamaCppModelInstall).mockResolvedValue({ aborted: true } as never);
}

describe('a download that stopped part way', () => {
  beforeEach(freshInstall);

  it('reports the bytes already on disk, so the welcome can offer to resume', async () => {
    vi.mocked(api.listIncompleteLlamaCppModels).mockResolvedValue({
      incomplete: [partial(RECOMMENDED, 3 * GB)],
    } as never);
    const { result } = renderFirstRun(vi.fn());
    await waitFor(() => expect(result.current.state.kind).toBe('needs-download'));
    expect(result.current.state).toMatchObject({ modelId: RECOMMENDED, resumeBytes: 3 * GB });
  });

  it('offers a fresh download when nothing of this model can be resumed', async () => {
    vi.mocked(api.listIncompleteLlamaCppModels).mockResolvedValue({
      incomplete: [partial(RECOMMENDED, 3 * GB, false), partial(ON_DISK, 5 * GB), partial('x', 0)],
    } as never);
    const { result } = renderFirstRun(vi.fn());
    await waitFor(() => expect(result.current.state.kind).toBe('needs-download'));
    expect(result.current.state).not.toHaveProperty('resumeBytes');
  });

  // The partial listing is a nicety; the download offer must not wait on it.
  it('still offers the download when the partial listing fails', async () => {
    vi.mocked(api.listIncompleteLlamaCppModels).mockRejectedValue(new Error('offline'));
    const { result } = renderFirstRun(vi.fn());
    await waitFor(() => expect(result.current.state.kind).toBe('needs-download'));
    expect(result.current.state).not.toHaveProperty('resumeBytes');
  });
});

describe('pausing the download', () => {
  beforeEach(freshInstall);

  it('cancels the install this window started and returns to the offer, not to a failure', async () => {
    let stopInstall!: (reason: Error) => void;
    vi.mocked(api.installLlamaCppModel).mockImplementation(
      () =>
        new Promise<void>((_resolve, reject) => {
          stopInstall = reject;
        }) as never,
    );
    // Cancelling is what ends the open install request, and leaves the part.
    vi.mocked(api.cancelLlamaCppModelInstall).mockImplementation((async () => {
      vi.mocked(api.listIncompleteLlamaCppModels).mockResolvedValue({
        incomplete: [partial(RECOMMENDED, 2 * GB)],
      } as never);
      stopInstall(new Error('The operation was aborted'));
      return { aborted: true };
    }) as never);
    const { result } = renderFirstRun(vi.fn());
    await waitFor(() => expect(result.current.state.kind).toBe('needs-download'));

    act(() => void result.current.start());
    await waitFor(() => expect(result.current.state.kind).toBe('installing'));
    expect(result.current.busy).toBe(true);

    await act(() => result.current.pause());

    expect(api.cancelLlamaCppModelInstall).toHaveBeenCalledWith(RECOMMENDED);
    await waitFor(() => expect(result.current.state.kind).toBe('needs-download'));
    expect(result.current.state).toMatchObject({ resumeBytes: 2 * GB });
    expect(result.current.busy).toBe(false);
  });

  it('pauses a download another window started', async () => {
    let installs = [
      {
        catalogId: RECOMMENDED,
        bytesWritten: GB,
        totalBytes: 4 * GB,
        phase: 'downloading',
        startedAt: '2026-11-09T10:00:00.000Z',
      },
    ];
    vi.mocked(api.listLlamaCppActiveInstalls).mockImplementation(
      async () => ({ installs }) as never,
    );
    vi.mocked(api.cancelLlamaCppModelInstall).mockImplementation((async () => {
      installs = [];
      vi.mocked(api.listIncompleteLlamaCppModels).mockResolvedValue({
        incomplete: [partial(RECOMMENDED, GB)],
      } as never);
      return { aborted: true };
    }) as never);
    const { result } = renderFirstRun(vi.fn());
    await waitFor(() => expect(result.current.state.kind).toBe('installing'));

    await act(() => result.current.pause());

    await waitFor(() => expect(result.current.state.kind).toBe('needs-download'));
    expect(result.current.state).toMatchObject({ resumeBytes: GB });
    expect(api.installLlamaCppModel).not.toHaveBeenCalled();
  });

  it('keeps downloading when the cancel does not reach the daemon', async () => {
    vi.mocked(api.installLlamaCppModel).mockReturnValue(new Promise(() => {}) as never);
    vi.mocked(api.cancelLlamaCppModelInstall).mockRejectedValue(new Error('offline'));
    const { result } = renderFirstRun(vi.fn());
    await waitFor(() => expect(result.current.state.kind).toBe('needs-download'));
    act(() => void result.current.start());
    await waitFor(() => expect(result.current.state.kind).toBe('installing'));

    await act(() => result.current.pause());

    expect(result.current.state.kind).toBe('installing');
  });

  it('does nothing when no download is running', async () => {
    const { result } = renderFirstRun(vi.fn());
    await waitFor(() => expect(result.current.state.kind).toBe('needs-download'));

    await act(() => result.current.pause());

    expect(api.cancelLlamaCppModelInstall).not.toHaveBeenCalled();
    expect(result.current.state.kind).toBe('needs-download');
  });
});
