import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));

const { ImageRecognitionSettings } = await import('./ImageRecognitionSettings.js');
const { api } = await import('../api.js');

const GRANITE = {
  id: 'granite-vision-4.1-4b-q4',
  name: 'Granite Vision 4.1 (4B)',
  description: 'Reads screenshots, tables, diagrams, and scanned text.',
  license: 'Apache-2.0',
  approxSizeBytes: 3_261_858_176,
  recoScore: 90,
};

describe('ImageRecognitionSettings', () => {
  beforeEach(() => {
    vi.mocked(api.getRecognitionHealth).mockResolvedValue({ state: 'no-model' } as never);
    vi.mocked(api.listRecognitionCatalog).mockResolvedValue({ models: [GRANITE] } as never);
    vi.mocked(api.listInstalledRecognitionModels).mockResolvedValue({ models: [] } as never);
    vi.mocked(api.getConfig).mockResolvedValue({ provider: 'mock' } as never);
  });

  it('lists catalog models with id, size, and license', async () => {
    render(<ImageRecognitionSettings />);
    await waitFor(() => {
      expect(screen.getByText('Granite Vision 4.1 (4B)')).toBeInTheDocument();
    });
    expect(screen.getByText(GRANITE.id)).toBeInTheDocument();
    expect(screen.getByText('3.0 GB')).toBeInTheDocument();
    expect(screen.getByText('Apache-2.0')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download' })).toBeInTheDocument();
  });

  it('shows a no-model state that explains the fallback rather than just failing', async () => {
    render(<ImageRecognitionSettings />);
    await waitFor(() => expect(screen.getByText('No model')).toBeInTheDocument());
    expect(screen.getByText(/described only by their file details/)).toBeInTheDocument();
  });

  it('offers Remove instead of Download once a model is installed', async () => {
    vi.mocked(api.listInstalledRecognitionModels).mockResolvedValue({
      models: [
        {
          id: GRANITE.id,
          name: GRANITE.name,
          approxSizeBytes: GRANITE.approxSizeBytes,
          installedAt: '2026-07-25T00:00:00.000Z',
        },
      ],
    } as never);
    vi.mocked(api.getRecognitionHealth).mockResolvedValue({ state: 'ok' } as never);
    render(<ImageRecognitionSettings />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Remove' })).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Download' })).not.toBeInTheDocument();
    expect(screen.getByText('Ready')).toBeInTheDocument();
  });

  it('defaults the policy to "when needed" and persists a change', async () => {
    vi.mocked(api.updateConfig).mockResolvedValue({ provider: 'mock' } as never);
    render(<ImageRecognitionSettings />);
    await waitFor(() =>
      expect(screen.getByRole('radio', { name: /When needed/ })).toBeInTheDocument(),
    );
    expect(screen.getByRole('radio', { name: /When needed/ })).toHaveAttribute(
      'aria-checked',
      'true',
    );

    await userEvent.click(screen.getByRole('radio', { name: /Always/ }));
    await waitFor(() => {
      expect(api.updateConfig).toHaveBeenCalledWith({ recognition: { mode: 'always' } });
    });
  });

  it('reflects an existing policy from config', async () => {
    vi.mocked(api.getConfig).mockResolvedValue({
      provider: 'mock',
      recognition: { mode: 'off' },
    } as never);
    render(<ImageRecognitionSettings />);
    await waitFor(() => {
      expect(screen.getByRole('radio', { name: /Never/ })).toHaveAttribute('aria-checked', 'true');
    });
  });

  it('clears the description cache on request', async () => {
    vi.mocked(api.clearRecognitionCache).mockResolvedValue({ ok: true } as never);
    render(<ImageRecognitionSettings />);
    await waitFor(() => expect(screen.getByText('Clear cache')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: 'Clear cache' }));
    await waitFor(() => expect(api.clearRecognitionCache).toHaveBeenCalled());
    expect(await screen.findByText('Cleared')).toBeInTheDocument();
  });
});
