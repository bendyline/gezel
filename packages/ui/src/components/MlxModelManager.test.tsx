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
} satisfies Awaited<ReturnType<typeof api.listMlxModels>>;

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

    // Legacy record (no representativeContext): the badge names the probe
    // shape so the user knows a re-run gets realistic timing.
    expect(await screen.findByText('short prompt · 62 t/s')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Context size' })).toBeInTheDocument();
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

  it('headlines the single-chat cost and keeps the slot reservation in the tooltip', async () => {
    vi.mocked(api.listMlxModels).mockResolvedValue({
      models: [
        {
          ...INSTALLED.models[0],
          predictedResidentBytes: 18_000_000_000,
          reservedResidentBytes: 30_000_000_000,
          plannedSlots: 2,
        },
      ],
    } as never);
    vi.mocked(api.listModelFitness).mockResolvedValue({ records: [], probing: [] } as never);

    render(<MlxModelManager />);

    const memory = await screen.findByText(/~18\.0 GB in memory/);
    expect(screen.queryByText(/30\.0 GB in memory/)).not.toBeInTheDocument();
    const title = memory.closest('td')?.getAttribute('title') ?? '';
    expect(title).toMatch(/about 18\.0 GB of memory to serve one chat/);
    expect(title).toMatch(/Serving 2 chats at once reserves about 30\.0 GB/);
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
