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

const { VideoEngineSettings } = await import('./VideoEngineSettings.js');
const { api } = await import('../api.js');

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
});
