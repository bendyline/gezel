import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));
vi.mock('./ModelBundleControls.js', () => ({
  ExportModelBundleButton: () => null,
  ImportModelBundleButton: () => <button type="button">Import .gezmodel</button>,
}));

const { MlxModelManager } = await import('./MlxModelManager.js');
const { api } = await import('../api.js');

const GiB = 1024 ** 3;

const INSTALLED = {
  models: [
    {
      id: 'gemma4-12b-q4',
      name: 'Gemma 4 (12B)',
      approxSizeBytes: 11 * GiB,
      installedAt: '2026-08-01T00:00:00.000Z',
      modelDir: '/tmp/gemma4-12b-q4',
      contextWindow: 256_000,
      effectiveContextWindow: 128_000,
      quantization: '4bit',
      chatTemplatePresent: true,
      catalogVersion: '1.0.0',
    },
  ],
} as never;

function fitnessRecord(overrides: Record<string, unknown> = {}) {
  const ok = { ok: true, detail: 'fine' };
  return {
    key: 'mlx:gemma4-12b-q4',
    stale: false,
    hardwareChanged: false,
    record: {
      schemaVersion: 1,
      provider: 'mlx',
      modelId: 'gemma4-12b-q4',
      status: 'probed',
      admitted: true,
      genTokensPerSec: 62.4,
      createdAt: '2026-08-02T00:00:00.000Z',
      durationMs: 42_000,
      trigger: 'install',
      catalogVersion: '1.0.0',
      host: { totalRamBytes: 128 * GiB, gpuVramBytes: null, source: 'darwin-unified' },
      checks: { spawn: ok, toolRoundTrip: ok, throughput: ok, reasoningBudget: ok, contextFit: ok },
      ...overrides,
    },
  };
}

describe('MlxModelManager fitness column', () => {
  beforeEach(() => {
    vi.mocked(api.listMlxModels).mockResolvedValue(INSTALLED);
    vi.mocked(api.listMlxActiveInstalls).mockResolvedValue({ installs: [] } as never);
    vi.mocked(api.listCatalogItems).mockResolvedValue({ items: [] } as never);
  });

  it('renders the measured decode speed for a probed model', async () => {
    vi.mocked(api.listModelFitness).mockResolvedValue({
      records: [fitnessRecord()],
      probing: [],
    } as never);

    render(<MlxModelManager />);

    expect(await screen.findByText('runs well (62 t/s)')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Context cap' })).toBeInTheDocument();
    expect(screen.getByText('128K')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Re-run' })).toBeInTheDocument();
  });

  it('offers a manual probe for an unchecked model and posts it against the mlx engine', async () => {
    vi.mocked(api.listModelFitness).mockResolvedValue({ records: [], probing: [] } as never);
    vi.mocked(api.runModelFitnessProbe).mockResolvedValue({ started: true } as never);

    render(<MlxModelManager />);

    const button = await screen.findByRole('button', { name: 'Run fitness check' });
    expect(screen.getByText('not checked yet')).toBeInTheDocument();
    await userEvent.click(button);

    await waitFor(() => {
      expect(api.runModelFitnessProbe).toHaveBeenCalledWith('mlx', 'gemma4-12b-q4');
    });
  });

  it('shows a live pill while a probe is running', async () => {
    vi.mocked(api.listModelFitness).mockResolvedValue({
      records: [],
      probing: ['mlx:gemma4-12b-q4'],
    } as never);

    render(<MlxModelManager />);

    expect(await screen.findByText('checking fitness…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Checking…' })).toBeDisabled();
  });
});
