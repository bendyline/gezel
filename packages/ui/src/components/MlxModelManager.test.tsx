import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));
vi.mock('./ModelBundleControls.js', () => ({
  ExportModelBundleButton: () => null,
  ImportModelBundleButton: () => <button type="button">Import .gezmodel</button>,
  ModelBundleExportProgressDialog: () => null,
  useExportModelBundle: () => ({
    run: async () => {},
    busy: false,
    error: null,
    progress: { phase: 'idle' },
    dismissProgress: () => {},
  }),
}));

const { MlxModelManager } = await import('./MlxModelManager.js');
const { api } = await import('../api.js');

const GiB = 1024 ** 3;

// Radix Popper measures tooltip content with ResizeObserver. jsdom does not
// provide it, so give the size-tooltip tests the inert browser shape.
vi.stubGlobal(
  'ResizeObserver',
  class ResizeObserverMock {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);

/** Open the Radix size tooltip (focus opens it without the hover delay). */
async function readSizeTooltip(memory: HTMLElement): Promise<string> {
  const trigger = memory.closest('.model-size-cell');
  expect(trigger).not.toBeNull();
  fireEvent.focus(trigger as HTMLElement);
  const tooltips = await screen.findAllByRole('tooltip');
  return tooltips[0]?.textContent ?? '';
}

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
    expect(screen.queryByRole('button', { name: 'Re-run' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Actions for gemma4-12b-q4' }));
    expect(
      await screen.findByRole('menuitem', { name: 'Re-run fitness check' }),
    ).toBeInTheDocument();
  });

  it('offers a manual probe for an unchecked model and posts it against the mlx engine', async () => {
    vi.mocked(api.listModelFitness).mockResolvedValue({ records: [], probing: [] } as never);
    vi.mocked(api.runModelFitnessProbe).mockResolvedValue({ started: true } as never);

    render(<MlxModelManager />);

    expect(await screen.findByText('not checked yet')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Actions for gemma4-12b-q4' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Run fitness check' }));

    await waitFor(() => {
      expect(api.runModelFitnessProbe).toHaveBeenCalledWith('mlx', 'gemma4-12b-q4');
    });
  });

  it('headlines the single-chat cost and keeps the slot reservation in the tooltip', async () => {
    vi.mocked(api.listMlxModels).mockResolvedValue({
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
          predictedResidentBytes: 18_000_000_000,
          reservedResidentBytes: 30_000_000_000,
          plannedSlots: 2,
        },
      ],
    } as never);
    vi.mocked(api.listModelFitness).mockResolvedValue({ records: [], probing: [] } as never);

    render(<MlxModelManager />);

    const memory = await screen.findByText(/~16\.8 GB in memory/);
    expect(screen.queryByText(/27\.9 GB in memory/)).not.toBeInTheDocument();
    const title = await readSizeTooltip(memory);
    expect(title).toMatch(/about 16\.8 GB of memory to serve one chat/);
    expect(title).toMatch(/Serving 2 chats at once reserves about 27\.9 GB/);
  });

  it('shows a live pill while a probe is running', async () => {
    vi.mocked(api.listModelFitness).mockResolvedValue({
      records: [],
      probing: ['mlx:gemma4-12b-q4'],
    } as never);

    render(<MlxModelManager />);

    expect(await screen.findByText('checking fitness…')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Actions for gemma4-12b-q4' }));
    expect(await screen.findByRole('menuitem', { name: 'Checking fitness…' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });
});
