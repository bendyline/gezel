import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));

const { ImageModelManager } = await import('./ImageModelManager.js');
const { api } = await import('../api.js');

const GiB = 1024 ** 3;

const IMAGE_MODEL = {
  sourceId: 'bundled',
  source: { id: 'bundled', label: 'Bundled' },
  manifest: {
    schemaVersion: 1,
    kind: 'image-model',
    id: 'sdxl-turbo',
    name: 'SDXL Turbo',
    version: '1.0.0',
    description: 'Test image model',
    tags: ['sdxl'],
    maintainer: { name: 'Stability AI', url: 'https://example.com' },
    license: 'OpenRAIL++',
    licenseClass: 'open',
    recoScore: 10,
    downloadUrl: 'https://example.com/sdxl-turbo.gguf',
    sha256: 'a'.repeat(64),
    approxSizeBytes: 4 * GiB,
    weightsKind: 'sdxl',
    supportsImg2Img: true,
    auxiliaryFiles: [],
    hardwareTier: 'mid',
    minRamGB: 16,
    quantization: 'Q4',
  },
};

describe('ImageModelManager downloads', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.listInstalledImageModels).mockResolvedValue({ models: [] } as never);
    vi.mocked(api.listActiveImagePulls).mockResolvedValue({ pulls: [] } as never);
    vi.mocked(api.listCatalogItems).mockResolvedValue({ items: [IMAGE_MODEL] } as never);
  });

  it('starts a new pull immediately when a failed download is retried', async () => {
    const callbacks: Array<Parameters<typeof api.pullImageModel>[1]> = [];
    vi.mocked(api.pullImageModel).mockImplementation(((_id, onEvent) => {
      callbacks.push(onEvent);
      return Promise.resolve();
    }) as typeof api.pullImageModel);

    render(<ImageModelManager />);

    await userEvent.click(await screen.findByRole('button', { name: 'Download' }));
    expect(api.pullImageModel).toHaveBeenCalledTimes(1);

    act(() => {
      callbacks[0]?.({ type: 'progress', bytesWritten: GiB, totalBytes: 4 * GiB });
      callbacks[0]?.({ type: 'error', error: 'network error' });
    });

    await userEvent.click(await screen.findByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(api.pullImageModel).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Downloading/ })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Download' })).not.toBeInTheDocument();
  });
});
