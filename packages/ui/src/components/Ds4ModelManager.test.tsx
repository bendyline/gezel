import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));
vi.mock('./ModelBundleControls.js', () => ({
  ExportModelBundleButton: () => null,
  ImportModelBundleButton: () => <button type="button">Import .gezmodel</button>,
  useExportModelBundle: () => ({ run: async () => {}, busy: false, error: null }),
}));
vi.mock('./ModelContextControls.js', () => ({
  contextSliderMax: () => undefined,
  ModelContextSliderPanel: () => null,
  // Flattened stand-in for the overflow menu: the real one is Radix, and these
  // tests are about what the row offers, not how the menu opens.
  ModelActionsMenu: ({
    model,
    onUpdate,
    fitnessAction,
  }: {
    model: { updateAvailable?: boolean };
    onUpdate?: () => void;
    fitnessAction?: { label: string; checking?: boolean; onRun: () => void };
  }) => (
    <>
      {model.updateAvailable && onUpdate ? (
        <button type="button" onClick={onUpdate}>
          Update
        </button>
      ) : null}
      {fitnessAction ? (
        <button type="button" disabled={fitnessAction.checking} onClick={fitnessAction.onRun}>
          {fitnessAction.label}
        </button>
      ) : null}
    </>
  ),
}));

const { Ds4ModelManager } = await import('./Ds4ModelManager.js');
const { api } = await import('../api.js');

const GiB = 1024 ** 3;

function catalogModel(opts: {
  id: string;
  name: string;
  quantization: string;
  parameterSize?: string;
  downloadGiB: number;
  residentGiB: number;
  cacheGiB: number;
}) {
  return {
    source: { id: 'bundled', label: 'Bundled' },
    manifest: {
      schemaVersion: 1,
      kind: 'chat-model',
      id: opts.id,
      name: opts.name,
      version: '1.0.0',
      description: 'test',
      tags: ['moe'],
      license: 'MIT',
      licenseClass: 'open',
      parameterSize: opts.parameterSize ?? '284B',
      approxSizeBytes: opts.downloadGiB * GiB,
      supportsTools: true,
      contextWindow: 1_000_000,
      ds4: {
        huggingfaceRepo: 'antirez/deepseek-v4-gguf',
        filename: `${opts.id}.gguf`,
        sha256: 'a'.repeat(64),
        approxSizeBytes: opts.downloadGiB * GiB,
        residentBytes: opts.residentGiB * GiB,
        cacheExpertsBytes: opts.cacheGiB * GiB,
        quantization: opts.quantization,
        ssdStreaming: true,
      },
    },
  };
}

describe('Ds4ModelManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.listDs4Models).mockResolvedValue({ models: [] });
    vi.mocked(api.listDs4ActiveInstalls).mockResolvedValue({ installs: [] });
    vi.mocked(api.listCatalogItems).mockResolvedValue({
      items: [
        catalogModel({
          id: 'deepseek-v4-flash-284b-q4',
          name: 'DeepSeek V4 Flash (FP4)',
          quantization: 'Q4_K',
          downloadGiB: 153,
          residentGiB: 80,
          cacheGiB: 64,
        }),
        catalogModel({
          id: 'deepseek-v4-flash-284b-q2',
          name: 'DeepSeek V4 Flash (IQ2_XXS)',
          quantization: 'IQ2_XXS',
          downloadGiB: 81,
          residentGiB: 36,
          cacheGiB: 32,
        }),
      ],
    } as never);
  });

  it('uses streaming-specific fit language and catalog names', async () => {
    vi.mocked(api.getMemoryProfile).mockResolvedValue({
      platform: 'darwin',
      totalRamBytes: 128 * GiB,
      gpuVramBytes: null,
      source: 'darwin-unified',
      usableBytes: Math.floor(128 * GiB * 0.6),
    });

    render(<Ds4ModelManager />);

    expect(await screen.findByText('DeepSeek V4 Flash (FP4)')).toBeInTheDocument();
    expect(screen.getByText('DeepSeek V4 Flash (IQ2_XXS)')).toBeInTheDocument();
    expect(screen.getByText('fits with SSD streaming')).toBeInTheDocument();
    expect(screen.getByText('recommended on this device')).toBeInTheDocument();
    expect(screen.queryByText('runs on this device')).not.toBeInTheDocument();
    // Download size and memory working set are separate columns: for a
    // streaming model the two numbers are nearly an order of magnitude apart,
    // and the memory one is the one that decides whether it runs.
    expect(screen.getByRole('columnheader', { name: 'Size' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Memory' })).toBeInTheDocument();
    expect(screen.getByText('153 GB')).toBeInTheDocument();
    expect(screen.getByText(/≈ 80 GB/)).toBeInTheDocument();
  });

  it('labels a non-DeepSeek ds4 model by its own catalog name', async () => {
    // ds4 runs GLM 5.2 as well as DeepSeek V4. The row used to compose its
    // title as `DeepSeek V4 Flash (${quantization})`, which relabelled every
    // other family as DeepSeek — a wrong model name is worse than no name.
    vi.mocked(api.getMemoryProfile).mockResolvedValue({
      platform: 'darwin',
      totalRamBytes: 128 * GiB,
      gpuVramBytes: null,
      source: 'darwin-unified',
      usableBytes: Math.floor(128 * GiB * 0.6),
    });
    vi.mocked(api.listCatalogItems).mockResolvedValue({
      items: [
        catalogModel({
          id: 'glm-5.2-754b-q2',
          name: 'GLM 5.2 (IQ2_XXS)',
          quantization: 'IQ2_XXS',
          parameterSize: '754B',
          downloadGiB: 197,
          residentGiB: 57,
          cacheGiB: 32,
        }),
      ],
    } as never);

    render(<Ds4ModelManager />);

    expect(await screen.findByText('GLM 5.2 (IQ2_XXS)')).toBeInTheDocument();
    expect(screen.queryByText(/DeepSeek/)).not.toBeInTheDocument();
    expect(screen.getByText('754B')).toBeInTheDocument();
    expect(screen.getByText('197 GB')).toBeInTheDocument();
  });

  it('quotes the launch window and its memory cost on models that are not downloaded', async () => {
    // A ds4 download runs to hundreds of GB, so the window it would run at and
    // what that window costs have to be on the row BEFORE the download starts.
    // Neither is knowable from the installed list — that only speaks for what
    // is already on disk.
    vi.mocked(api.getMemoryProfile).mockResolvedValue({
      platform: 'darwin',
      totalRamBytes: 128 * GiB,
      gpuVramBytes: null,
      source: 'darwin-unified',
      usableBytes: Math.floor(128 * GiB * 0.6),
    });
    vi.mocked(api.listDs4ContextPlans).mockResolvedValue({
      plans: {
        'deepseek-v4-flash-284b-q2': {
          effectiveContextWindow: 131_072,
          contextCeilingTokens: 262_144,
          // 35 GiB context-free + 8192 B/token x 131072 = 36 GiB.
          projectedResidentBytes: 36 * GiB,
          kvBytesPerToken: 8192,
          contextFreeResidentBytes: 35 * GiB,
        },
      },
    } as never);

    render(<Ds4ModelManager />);

    expect(await screen.findByText('128K')).toBeInTheDocument();
    const planned = screen.getByText(/≈ 36 GB/);
    expect(planned).toHaveAttribute('title', expect.stringContaining('context (KV) at 128K'));
    // No plan for the FP4 row — it keeps the flat authored footprint and
    // claims no relationship to the window.
    const flat = screen.getByText(/≈ 80 GB/);
    expect(flat).toHaveAttribute('title', expect.stringContaining('Target memory working set'));
    expect(flat).toHaveAttribute('title', expect.not.stringContaining('context (KV)'));
    // Nothing is downloaded, so no check has run and none can.
    expect(screen.getAllByText('after download')).toHaveLength(2);
  });

  it('does not offer installation when fixed model state cannot preserve system headroom', async () => {
    vi.mocked(api.getMemoryProfile).mockResolvedValue({
      platform: 'darwin',
      totalRamBytes: 32 * GiB,
      gpuVramBytes: null,
      source: 'darwin-unified',
      usableBytes: Math.floor(32 * GiB * 0.6),
    });

    render(<Ds4ModelManager />);

    await waitFor(() => expect(screen.getAllByText('needs more memory')).toHaveLength(2));
    expect(screen.queryByRole('button', { name: 'Download' })).not.toBeInTheDocument();
  });

  it('signals an installed catalog update and offers an in-place update action', async () => {
    vi.mocked(api.listDs4Models).mockResolvedValue({
      models: [
        {
          id: 'deepseek-v4-flash-284b-q4',
          name: 'DeepSeek V4 Flash (FP4)',
          approxSizeBytes: 153 * GiB,
          installedAt: '2026-07-23T00:00:00.000Z',
          weightsPath: '/models/deepseek-v4-flash-284b-q4/model.gguf',
          chatTemplatePresent: true,
          updateAvailable: true,
          availableVersion: '1.1.0',
        },
      ],
    });

    render(<Ds4ModelManager />);

    const signal = await screen.findByText('update available');
    expect(signal).toHaveAttribute('title', expect.stringContaining('→ v1.1.0'));

    fireEvent.click(screen.getByRole('button', { name: 'Update' }));

    await waitFor(() =>
      expect(api.installDs4Model).toHaveBeenCalledWith(
        'deepseek-v4-flash-284b-q4',
        expect.any(Function),
      ),
    );
  });

  it('surfaces a legacy install as manageable disk use and updates it from the catalog', async () => {
    vi.mocked(api.getMemoryProfile).mockResolvedValue({
      platform: 'linux',
      totalRamBytes: 128 * GiB,
      gpuVramBytes: 96 * GiB,
      source: 'gpu-nvidia',
      usableBytes: 96 * GiB,
    });
    vi.mocked(api.listDs4Models).mockResolvedValue({
      models: [],
      unrecognized: [
        {
          id: 'deepseek-v4-flash-284b-q2',
          name: 'DeepSeek V4 Flash (IQ2_XXS)',
          bytes: 81 * GiB,
          updatedAt: '2026-08-12T00:00:00.000Z',
          reason:
            'This model was installed by an older version of Gezel and its metadata needs updating.',
          canUpdate: true,
        },
      ],
    });

    render(<Ds4ModelManager />);

    const heading = await screen.findByText('Models needing attention');
    const attention = heading.closest('.local-model-attention') as HTMLElement;
    expect(within(attention).getByText('DeepSeek V4 Flash (IQ2_XXS)')).toBeInTheDocument();
    expect(screen.getAllByText('DeepSeek V4 Flash (IQ2_XXS)')).toHaveLength(1);
    expect(
      within(attention).getByText(/81\.0 GB · This model was installed by an older version/),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Update' }));

    await waitFor(() =>
      expect(api.installDs4Model).toHaveBeenCalledWith(
        'deepseek-v4-flash-284b-q2',
        expect.any(Function),
      ),
    );
  });

  it('requires confirmation before removing an unreadable legacy install', async () => {
    vi.mocked(api.getMemoryProfile).mockResolvedValue({
      platform: 'linux',
      totalRamBytes: 128 * GiB,
      gpuVramBytes: 96 * GiB,
      source: 'gpu-nvidia',
      usableBytes: 96 * GiB,
    });
    vi.mocked(api.listDs4Models).mockResolvedValue({
      models: [],
      unrecognized: [
        {
          id: 'deepseek-v4-flash-284b-q2',
          name: 'DeepSeek V4 Flash (IQ2_XXS)',
          bytes: 81 * GiB,
          updatedAt: '2026-08-12T00:00:00.000Z',
          reason: 'This model metadata is incomplete or does not match the current format.',
          canUpdate: true,
        },
      ],
    });

    render(<Ds4ModelManager />);

    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    expect(api.deleteDs4Model).not.toHaveBeenCalled();

    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByText('Remove deepseek-v4-flash-284b-q2?')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));

    await waitFor(() =>
      expect(api.deleteDs4Model).toHaveBeenCalledWith('deepseek-v4-flash-284b-q2'),
    );
  });
});

describe('Ds4ModelManager fitness column', () => {
  const INSTALLED = {
    models: [
      {
        id: 'deepseek-v4-flash-284b-q2',
        name: 'DeepSeek V4 Flash (IQ2_XXS)',
        approxSizeBytes: 81 * GiB,
        installedAt: '2026-08-01T00:00:00.000Z',
        weightsPath: '/models/deepseek-v4-flash-284b-q2/model.gguf',
        chatTemplatePresent: true,
      },
    ],
  };

  function fitnessRecord(overrides: Record<string, unknown> = {}) {
    const ok = { ok: true, detail: 'fine' };
    return {
      key: 'ds4:deepseek-v4-flash-284b-q2',
      stale: false,
      hardwareChanged: false,
      record: {
        schemaVersion: 1,
        provider: 'ds4',
        modelId: 'deepseek-v4-flash-284b-q2',
        status: 'probed',
        admitted: true,
        genTokensPerSec: 18.4,
        createdAt: '2026-08-20T00:00:00.000Z',
        durationMs: 240_000,
        trigger: 'install',
        host: { totalRamBytes: 128 * GiB, gpuVramBytes: null, source: 'darwin-unified' },
        checks: {
          spawn: ok,
          toolRoundTrip: ok,
          throughput: ok,
          reasoningBudget: ok,
          contextFit: ok,
        },
        representativeContext: {
          targetPromptTokens: 20_000,
          promptTokens: 19_891,
          cachedPromptTokens: 124,
          completionTokens: 400,
          durationMs: 105_000,
          ttftMs: 84_000,
          promptTokensPerSec: null,
          genTokensPerSec: 18.4,
        },
        ...overrides,
      },
    };
  }

  beforeEach(() => {
    vi.mocked(api.getMemoryProfile).mockResolvedValue({
      platform: 'darwin',
      totalRamBytes: 128 * GiB,
      gpuVramBytes: null,
      source: 'darwin-unified',
      usableBytes: Math.floor(128 * GiB * 0.6),
    });
    vi.mocked(api.listDs4Models).mockResolvedValue(INSTALLED as never);
  });

  it('reports startup, decode, and the prefill rate the badge has no room for', async () => {
    // A DwarfStar build streams routed experts from SSD, so it can decode at a
    // usable rate and still take a minute and a half to READ a 20K prompt.
    // That wait is what the user feels, so the row carries it.
    vi.mocked(api.listModelFitness).mockResolvedValue({
      records: [fitnessRecord()],
      probing: [],
    } as never);

    render(<Ds4ModelManager />);

    expect(await screen.findByText('starts ~84s · 18 t/s')).toBeInTheDocument();
    // ds4-server reports no prefill timing of its own; (19891 - 124) / 84s.
    const prefill = screen.getByText('prefill ~235 t/s');
    expect(prefill).toHaveAttribute('title', expect.stringContaining('19,767-token'));
    expect(prefill).toHaveAttribute('title', expect.stringContaining('first word'));
  });

  it('prefers the engine-reported prefill rate over the derived one', async () => {
    vi.mocked(api.listModelFitness).mockResolvedValue({
      records: [
        fitnessRecord({
          representativeContext: {
            targetPromptTokens: 20_000,
            promptTokens: 19_891,
            cachedPromptTokens: 124,
            completionTokens: 400,
            durationMs: 105_000,
            ttftMs: 84_000,
            promptTokensPerSec: 190,
            genTokensPerSec: 18.4,
          },
        }),
      ],
      probing: [],
    } as never);

    render(<Ds4ModelManager />);

    const prefill = await screen.findByText('prefill 190 t/s');
    expect(prefill).toHaveAttribute('title', expect.stringContaining('The engine read'));
  });

  it('runs a manual check for the ds4 engine from the row menu', async () => {
    vi.mocked(api.listModelFitness).mockResolvedValue({ records: [], probing: [] } as never);
    vi.mocked(api.runModelFitnessProbe).mockResolvedValue({ started: true } as never);

    render(<Ds4ModelManager />);

    fireEvent.click(await screen.findByRole('button', { name: 'Run fitness check' }));

    await waitFor(() =>
      expect(api.runModelFitnessProbe).toHaveBeenCalledWith('ds4', 'deepseek-v4-flash-284b-q2'),
    );
  });

  it('shows a running check and disables re-running it', async () => {
    vi.mocked(api.listModelFitness).mockResolvedValue({
      records: [],
      probing: ['ds4:deepseek-v4-flash-284b-q2'],
    } as never);

    render(<Ds4ModelManager />);

    expect(await screen.findByText('checking fitness…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Checking fitness…' })).toBeDisabled();
  });

  it('does not print stale speeds under a badge that says the check is out of date', async () => {
    // The weights changed; the numbers describe a model that is no longer on
    // disk, and the badge already says so.
    vi.mocked(api.listModelFitness).mockResolvedValue({
      records: [{ ...fitnessRecord(), stale: true }],
      probing: [],
    } as never);

    render(<Ds4ModelManager />);

    expect(await screen.findByText('not checked yet')).toBeInTheDocument();
    expect(screen.queryByText(/prefill/)).not.toBeInTheDocument();
  });
});
