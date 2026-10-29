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
    quantization: 'Q4',
  },
};

const TWO_INSTALLED = {
  models: [
    {
      id: 'flux-2-klein-4b-q4',
      name: 'FLUX.2 Klein 4B (Q4)',
      approxSizeBytes: 4.8 * GiB,
      installedAt: '2026-06-24T00:00:00.000Z',
    },
    {
      id: 'krea-2-turbo-q4',
      name: 'Krea 2 Turbo (Q4)',
      approxSizeBytes: 9.5 * GiB,
      installedAt: '2026-06-25T00:00:00.000Z',
    },
  ],
};

describe('ImageModelManager active-model selection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.listInstalledImageModels).mockResolvedValue(TWO_INSTALLED as never);
    vi.mocked(api.listActiveImagePulls).mockResolvedValue({ pulls: [] } as never);
    vi.mocked(api.listCatalogItems).mockResolvedValue({ items: [] } as never);
  });

  it('omits the Active column when no onSetActiveModel handler is given', async () => {
    render(<ImageModelManager />);

    await screen.findByText('FLUX.2 Klein 4B (Q4)');
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.queryByRole('columnheader', { name: 'Active' })).toBeNull();
  });

  it('marks the configured default active and persists a new pick', async () => {
    const onSet = vi.fn();
    render(
      <ImageModelManager configuredDefaultModelId="krea-2-turbo-q4" onSetActiveModel={onSet} />,
    );

    const krea = await screen.findByRole('radio', {
      name: 'Use Krea 2 Turbo (Q4) as the active image model',
    });
    const flux = screen.getByRole('radio', {
      name: 'Use FLUX.2 Klein 4B (Q4) as the active image model',
    });
    expect(krea).toBeChecked();
    expect(flux).not.toBeChecked();

    await userEvent.click(flux);
    expect(onSet).toHaveBeenCalledWith('flux-2-klein-4b-q4');
  });

  it('falls back to the first installed model when the configured default is gone', async () => {
    const onSet = vi.fn();
    render(<ImageModelManager configuredDefaultModelId="deleted-model" onSetActiveModel={onSet} />);

    const flux = await screen.findByRole('radio', { name: /FLUX.2 Klein 4B/ });
    expect(flux).toBeChecked();
  });

  it('never makes a model that only edits the active one', async () => {
    vi.mocked(api.listInstalledImageModels).mockResolvedValue({
      models: [
        {
          id: 'a-qwen-image-edit',
          name: 'Qwen Image Edit',
          approxSizeBytes: 19 * GiB,
          installedAt: '2026-10-27T00:00:00.000Z',
          editMode: 'reference',
          editOnly: true,
        },
        ...TWO_INSTALLED.models,
      ],
    } as never);
    render(
      <ImageModelManager configuredDefaultModelId="a-qwen-image-edit" onSetActiveModel={vi.fn()} />,
    );

    const flux = await screen.findByRole('radio', { name: /FLUX.2 Klein 4B/ });
    expect(flux).toBeChecked();
    expect(screen.queryByRole('radio', { name: /Qwen Image Edit/ })).toBeNull();
    expect(screen.getByText('Edits')).toBeInTheDocument();
  });
});

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

  it('hides a model whose weights cannot fit the card, and names the memory it needs', async () => {
    vi.mocked(api.getImageModelFit).mockResolvedValue({
      pool: 'discrete',
      budgetBytes: 17 * GiB,
      gpuBudgetBytes: 7.6 * GiB,
      totalRamBytes: 16 * GiB,
      models: [
        {
          id: 'sdxl-turbo',
          verdict: 'wont-run',
          pool: 'discrete',
          weightBytes: 9 * GiB,
          bytes: 11 * GiB,
          gpuBytes: 9 * GiB,
          exact: true,
          neededBytes: 9 * GiB,
          availableBytes: 7.6 * GiB,
          reason: 'Its weights need about 9 GB of graphics memory; this card has about 7.6 GB.',
        },
      ],
    } as never);
    render(<ImageModelManager />);

    expect(await screen.findByText(/1 model is too large for this machine/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Download' })).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Show all models' }));
    expect(await screen.findByRole('button', { name: 'Too large' })).toBeDisabled();
    expect(screen.getByText('needs ~9 GB graphics memory')).toBeInTheDocument();
  });

  it('sizes the card by the whole download and says the need is memory', async () => {
    // Ming-shaped: the text encoder is three times the diffusion weights.
    vi.mocked(api.listCatalogItems).mockResolvedValue({
      items: [
        {
          ...IMAGE_MODEL,
          manifest: {
            ...IMAGE_MODEL.manifest,
            approxSizeBytes: 11.5 * GiB,
            auxiliaryFiles: [
              { role: 'llm', approxSizeBytes: 34.2 * GiB },
              { role: 'vae', approxSizeBytes: 0.3 * GiB },
            ],
          },
        },
      ],
    } as never);
    vi.mocked(api.getImageModelFit).mockResolvedValue({
      pool: 'unified',
      budgetBytes: 96 * GiB,
      totalRamBytes: 128 * GiB,
      models: [
        {
          id: 'sdxl-turbo',
          verdict: 'fits',
          pool: 'unified',
          weightBytes: 46 * GiB,
          bytes: 52 * GiB,
          exact: true,
          neededBytes: 52 * GiB,
          availableBytes: 96 * GiB,
          reason: '',
        },
      ],
    } as never);
    render(<ImageModelManager />);

    expect(await screen.findByText('46.0 GB')).toBeInTheDocument();
    expect(screen.getByText('needs ~52 GB memory')).toBeInTheDocument();
  });
});
