import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));

vi.mock('../components/VideoModelManager.js', () => ({
  VideoModelManager: () => <div data-testid="video-model-manager">mock</div>,
}));

vi.mock('../components/VideoGeneratorGezelHint.js', () => ({
  VideoGeneratorGezelHint: () => <div data-testid="gezel-hint">hint</div>,
}));

const { VideoEngineSettings, cpuFallbackCause } = await import('./VideoEngineSettings.js');
const { api } = await import('../api.js');

/** A Windows/Radeon profile — the shape that exposed the misleading copy. */
const RADEON_PROFILE = {
  platform: 'win32',
  totalRamBytes: 64_000_000_000,
  gpuVramBytes: 34_300_000_000,
  source: 'gpu-vulkan',
  usableBytes: 32_500_000_000,
  gpuVendor: 'amd',
} as never;

function cpuEngine() {
  vi.mocked(api.getVideoEngineStatus).mockResolvedValue({
    engine: {
      status: 'ok',
      kind: 'local',
      baseUrl: 'http://127.0.0.1:9101',
      accelerator: 'cpu',
    },
    modelCount: 1,
  } as never);
}

describe('VideoEngineSettings', () => {
  beforeEach(() => {
    vi.mocked(api.getVideoEngineStatus).mockResolvedValue({
      engine: {
        status: 'ok',
        kind: 'local',
        baseUrl: 'http://127.0.0.1:9101',
        accelerator: 'mps',
      },
      modelCount: 1,
    } as never);
    vi.mocked(api.getConfig).mockResolvedValue({
      provider: 'llama-cpp',
      videoGenerationConfirmation: 'ask',
    } as never);
    vi.mocked(api.updateConfig).mockImplementation(
      async (patch) =>
        ({ provider: 'llama-cpp', videoGenerationConfirmation: 'ask', ...patch }) as never,
    );
  });

  it('renders confirmation choices as keys in a tray and persists the selection', async () => {
    render(<VideoEngineSettings />);

    const group = await screen.findByRole('radiogroup', {
      name: 'Video generation confirmation',
    });
    const ask = screen.getByRole('radio', { name: 'Ask before each generation (default)' });
    const alwaysAllow = screen.getByRole('radio', { name: 'Always allow without asking' });

    expect(group).toHaveClass('gz-tray');
    expect(ask).toHaveClass('gz-key', 'gz-key-active');
    expect(ask).toHaveAttribute('aria-checked', 'true');
    expect(alwaysAllow).toHaveAttribute('aria-checked', 'false');

    await userEvent.click(alwaysAllow);

    await waitFor(() => {
      expect(api.updateConfig).toHaveBeenCalledWith({
        videoGenerationConfirmation: 'always-allow',
      });
      expect(alwaysAllow).toHaveAttribute('aria-checked', 'true');
    });
  });

  describe('CPU fallback notice', () => {
    it('blames PyTorch, not detection, when a non-NVIDIA GPU is present', async () => {
      cpuEngine();
      vi.mocked(api.getMemoryProfile).mockResolvedValue(RADEON_PROFILE);

      render(<VideoEngineSettings />);

      // The bug this replaced: gezel detects the Radeon fine for chat, so
      // "No GPU detected" here reads as a gezel fault instead of an
      // upstream one.
      const notice = await screen.findByText(/Your AMD GPU can't be used for video generation/);
      expect(notice).toHaveTextContent('PyTorch');
      expect(notice).toHaveTextContent('Chat still runs on your GPU');
      expect(screen.queryByText(/No GPU detected/)).not.toBeInTheDocument();
    });

    it('still says "no GPU detected" when the machine really has none', async () => {
      cpuEngine();
      vi.mocked(api.getMemoryProfile).mockResolvedValue({
        platform: 'linux',
        totalRamBytes: 16_000_000_000,
        gpuVramBytes: null,
        source: 'system-ram-fallback',
        usableBytes: 8_000_000_000,
      } as never);

      render(<VideoEngineSettings />);

      expect(await screen.findByText(/No GPU detected/)).toBeInTheDocument();
    });

    it('says nothing about the accelerator when the GPU is usable', async () => {
      vi.mocked(api.getMemoryProfile).mockResolvedValue(RADEON_PROFILE);

      render(<VideoEngineSettings />);

      await screen.findByRole('radiogroup', { name: 'Video generation confirmation' });
      expect(screen.queryByText(/can't be used for video generation/)).not.toBeInTheDocument();
      expect(screen.queryByText(/No GPU detected/)).not.toBeInTheDocument();
    });
  });

  describe('cpuFallbackCause', () => {
    it('falls back to the vague copy when the memory probe failed', () => {
      expect(cpuFallbackCause(null)).toEqual({ kind: 'no-gpu' });
    });

    it('points an NVIDIA owner at their driver rather than at PyTorch', () => {
      expect(cpuFallbackCause({ source: 'gpu-nvidia', gpuVendor: 'nvidia' } as never)).toEqual({
        kind: 'cuda-unavailable',
      });
    });

    it('omits the vendor when the device name was unrecognized', () => {
      expect(cpuFallbackCause({ source: 'gpu-vulkan' } as never)).toEqual({
        kind: 'unsupported-gpu',
        vendorLabel: null,
      });
    });
  });
});
