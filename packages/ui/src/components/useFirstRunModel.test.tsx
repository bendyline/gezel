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
