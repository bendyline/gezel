import type { ConfigResponse } from '@bendyline/gezel-client';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));
vi.mock('./useCopilotAvailability.js', () => ({ useCopilotAvailability: () => null }));

const { FirstRunInstallBanner } = await import('./FirstRunInstallBanner.js');
const { api } = await import('../api.js');

const GB = 1024 ** 3;

function config(over: Partial<ConfigResponse> = {}): ConfigResponse {
  return {
    provider: 'llama-cpp',
    defaultModel: { 'llama-cpp': 'qwen3.8-27b-q4' },
    ...over,
  } as ConfigResponse;
}

describe('FirstRunInstallBanner', () => {
  beforeEach(() => {
    vi.mocked(api.listLlamaCppActiveInstalls).mockResolvedValue({ installs: [] } as never);
    vi.mocked(api.getCatalogItem).mockResolvedValue({
      manifest: { kind: 'chat-model', llamaCpp: { approxSizeBytes: 16 * GB } },
    } as never);
    vi.mocked(api.getMemoryProfile).mockResolvedValue(null as never);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // The first inventory answer can take minutes while shared models are
  // hashed; rendering nothing meanwhile left the setup page with no action.
  it('says it is checking while the model inventory is still loading', async () => {
    vi.mocked(api.listLlamaCppModels).mockReturnValue(new Promise(() => {}) as never);
    render(<FirstRunInstallBanner config={config()} onConfigChanged={vi.fn()} />);
    expect(screen.getByText('Checking this computer for AI models')).toBeInTheDocument();
  });

  it('keeps one inventory request in flight instead of stacking a new one every poll', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(api.listLlamaCppModels).mockReturnValue(new Promise(() => {}) as never);
    render(<FirstRunInstallBanner config={config()} onConfigChanged={vi.fn()} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(api.listLlamaCppModels).toHaveBeenCalledTimes(1);
  });

  it('offers models already on the computer beside the recommended download', async () => {
    vi.mocked(api.listLlamaCppModels).mockResolvedValue({
      models: [{ id: 'gemma4-31b-q4', name: 'Gemma 4 (31B, Q4)' }],
    } as never);
    const next = config({ defaultModel: { 'llama-cpp': 'gemma4-31b-q4' } });
    vi.mocked(api.updateConfig).mockResolvedValue(next as never);
    const onConfigChanged = vi.fn();
    const onModelInstalled = vi.fn();
    render(
      <FirstRunInstallBanner
        config={config()}
        onConfigChanged={onConfigChanged}
        onModelInstalled={onModelInstalled}
      />,
    );

    expect(
      await screen.findByRole('button', { name: /Download recommended model \(Qwen 3\.8 \(27B\)/ }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Gemma 4 (31B, Q4)' }));

    await waitFor(() => expect(onModelInstalled).toHaveBeenCalled());
    expect(api.updateConfig).toHaveBeenCalledWith({
      defaultModel: { 'llama-cpp': 'gemma4-31b-q4' },
    });
    expect(onConfigChanged).toHaveBeenCalledWith(next);
  });

  // The first-run pin is written in the background at daemon start, so Home
  // can hold a config from before it landed.
  it('re-reads the config when the recommended model has not been pinned yet', async () => {
    const pinned = config();
    vi.mocked(api.getConfig).mockResolvedValue(pinned as never);
    const onConfigChanged = vi.fn();
    render(
      <FirstRunInstallBanner
        config={config({ defaultModel: {} })}
        onConfigChanged={onConfigChanged}
      />,
    );
    await waitFor(() => expect(onConfigChanged).toHaveBeenCalledWith(pinned));
    expect(screen.getByText('Checking this computer for AI models')).toBeInTheDocument();
  });

  it('shows speed and time left once a download has been measured', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(api.listLlamaCppModels).mockResolvedValue({ models: [] } as never);
    let written = 0;
    vi.mocked(api.listLlamaCppActiveInstalls).mockImplementation(async () => {
      written += 20 * 1024 ** 2;
      return {
        installs: [
          {
            catalogId: 'qwen3.8-27b-q4',
            bytesWritten: written,
            totalBytes: 16 * GB,
            phase: 'downloading',
            startedAt: new Date().toISOString(),
          },
        ],
      } as never;
    });
    render(<FirstRunInstallBanner config={config()} onConfigChanged={vi.fn()} />);

    expect(await screen.findByText(/Downloading Qwen 3\.8 \(27B\)/)).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_000);
    });
    expect(screen.getByText(/MB\/s · about .* left/)).toBeInTheDocument();
  });
});
