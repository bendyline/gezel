import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));

const { VideoModelManager } = await import('./VideoModelManager.js');
const { api } = await import('../api.js');

const TWO_MODELS = {
  models: [
    {
      id: 'ltx-2.3-22b-fp8',
      name: 'LTX-2.3',
      approxSizeBytes: 1,
      installedAt: '2026-07-20T00:00:00Z',
    },
    {
      id: 'wan2.2-ti2v-5b',
      name: 'Wan 2.2 TI2V-5B',
      approxSizeBytes: 1,
      installedAt: '2026-07-17T00:00:00Z',
    },
  ],
};

const GiB = 1024 ** 3;

const VIDEO_MODEL = {
  sourceId: 'bundled',
  source: { id: 'bundled', label: 'Bundled' },
  manifest: {
    schemaVersion: 1,
    kind: 'video-model',
    id: 'test-video-model',
    name: 'Test Video Model',
    version: '1.0.0',
    description: 'Test video model',
    tags: ['video'],
    maintainer: { name: 'Test Lab', url: 'https://example.com' },
    license: 'Apache-2.0',
    licenseClass: 'open',
    recoScore: 10,
    approxSizeBytes: 4 * GiB,
    family: 'ltx',
    hardwareTier: 'mid',
    minVramGB: 16,
  },
};

describe('VideoModelManager active-model selection', () => {
  beforeEach(() => {
    vi.mocked(api.listInstalledVideoModels).mockResolvedValue(TWO_MODELS as never);
  });

  it('omits the Active column when no onSetActiveModel handler is given', async () => {
    render(<VideoModelManager />);

    await screen.findByText('ltx-2.3-22b-fp8');
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.queryByRole('columnheader', { name: 'Active' })).toBeNull();
  });

  it('marks the configured default active and persists a new pick', async () => {
    const onSet = vi.fn();
    render(
      <VideoModelManager configuredDefaultModelId="ltx-2.3-22b-fp8" onSetActiveModel={onSet} />,
    );

    const ltx = await screen.findByRole('radio', {
      name: 'Use ltx-2.3-22b-fp8 as the active video model',
    });
    const wan = screen.getByRole('radio', {
      name: 'Use wan2.2-ti2v-5b as the active video model',
    });
    expect(ltx).toBeChecked();
    expect(wan).not.toBeChecked();

    await userEvent.click(wan);
    expect(onSet).toHaveBeenCalledWith('wan2.2-ti2v-5b');
  });

  it('falls back to the first installed model when no default is configured', async () => {
    render(<VideoModelManager onSetActiveModel={vi.fn()} />);

    const ltx = await screen.findByRole('radio', { name: /ltx-2\.3-22b-fp8/ });
    expect(ltx).toBeChecked();
  });
});

describe('VideoModelManager machine-wide models', () => {
  it('labels read-only models Machine-wide instead of offering Delete', async () => {
    const [ltx, wan] = TWO_MODELS.models;
    vi.mocked(api.listInstalledVideoModels).mockResolvedValue({
      models: [ltx, { ...wan, readOnly: true }],
    } as never);

    render(<VideoModelManager />);

    await screen.findByText('wan2.2-ti2v-5b');
    expect(screen.getByText('Machine-wide')).toBeInTheDocument();
    // Only the user-owned row keeps its Delete action.
    expect(screen.getAllByRole('button', { name: 'Delete' })).toHaveLength(1);
  });
});

describe('VideoModelManager downloads', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.listInstalledVideoModels).mockResolvedValue({ models: [] } as never);
    vi.mocked(api.listActiveVideoPulls).mockResolvedValue({ pulls: [] } as never);
    vi.mocked(api.listCatalogItems).mockResolvedValue({ items: [VIDEO_MODEL] } as never);
  });

  it('starts a new pull immediately when a failed download is retried', async () => {
    const callbacks: Array<Parameters<typeof api.pullVideoModel>[1]> = [];
    vi.mocked(api.pullVideoModel).mockImplementation(((_id, onEvent) => {
      callbacks.push(onEvent);
      return Promise.resolve();
    }) as typeof api.pullVideoModel);

    render(<VideoModelManager />);

    await userEvent.click(await screen.findByRole('button', { name: 'Download' }));
    expect(api.pullVideoModel).toHaveBeenCalledTimes(1);

    act(() => {
      callbacks[0]?.({
        type: 'progress',
        file: 'model.safetensors',
        fileIndex: 0,
        fileCount: 1,
        bytesWritten: GiB,
        totalBytes: 4 * GiB,
        bytesWrittenAll: GiB,
        totalBytesAll: 4 * GiB,
      });
      callbacks[0]?.({ type: 'error', error: 'network error' });
    });

    await userEvent.click(await screen.findByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(api.pullVideoModel).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Downloading/ })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Download' })).not.toBeInTheDocument();
  });
});
