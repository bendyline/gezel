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
  tags?: string[];
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
      tags: opts.tags ?? ['moe'],
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
    // No context plan in this fixture, so no `fullyResident` verdict — these
    // rows are the streaming rungs. The label leads with the cost rather than
    // reading as an endorsement: "fits with SSD streaming" wore the ok/green
    // chip while describing the ~10x-slower path.
    expect(screen.getByText('streams from SSD · lightest option')).toBeInTheDocument();
    expect(screen.getByText('streams from SSD · slower')).toBeInTheDocument();
    expect(screen.queryByText('fits with SSD streaming')).not.toBeInTheDocument();
    expect(screen.queryByText('recommended on this device')).not.toBeInTheDocument();
    expect(screen.queryByText('runs on this device')).not.toBeInTheDocument();
    // Download size and memory working set share one cell, as they do on the
    // llama.cpp and MLX pages — for a streaming model the two numbers are
    // nearly an order of magnitude apart, and the second decides whether it runs.
    expect(screen.getByRole('columnheader', { name: 'Size' })).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Memory' })).not.toBeInTheDocument();
    expect(screen.getByText(/153\.0 GB/)).toBeInTheDocument();
    // No context plan in this fixture, so the row quotes the flat authored
    // footprint and keeps its hedge.
    expect(screen.getByText('~80.0 GB in memory')).toBeInTheDocument();
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
    expect(screen.getByText(/197\.0 GB/)).toBeInTheDocument();
  });

  it('hides retired downloads until Show all models is selected', async () => {
    vi.mocked(api.listCatalogItems).mockResolvedValue({
      items: [
        catalogModel({
          id: 'current-ds4',
          name: 'Current DS4',
          quantization: 'IQ2_XXS',
          downloadGiB: 81,
          residentGiB: 36,
          cacheGiB: 32,
        }),
        catalogModel({
          id: 'retired-ds4',
          name: 'Retired DS4',
          quantization: 'IQ2_XXS',
          downloadGiB: 81,
          residentGiB: 36,
          cacheGiB: 32,
          tags: ['retired'],
        }),
      ],
    } as never);

    render(<Ds4ModelManager />);

    expect(await screen.findByText('Current DS4')).toBeInTheDocument();
    expect(screen.queryByText('Retired DS4')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show all models' }));

    expect(await screen.findByText('Retired DS4')).toBeInTheDocument();
    expect(screen.getByText('retired')).toHaveClass('catalog-item-tag--retired');
  });

  it('keeps an installed retired model visible for management', async () => {
    vi.mocked(api.listCatalogItems).mockResolvedValue({
      items: [
        catalogModel({
          id: 'retired-ds4',
          name: 'Retired DS4',
          quantization: 'IQ2_XXS',
          downloadGiB: 81,
          residentGiB: 36,
          cacheGiB: 32,
          tags: ['retired'],
        }),
      ],
    } as never);
    vi.mocked(api.listDs4Models).mockResolvedValue({
      models: [
        {
          id: 'retired-ds4',
          name: 'Retired DS4',
          approxSizeBytes: 81 * GiB,
          installedAt: '2026-08-01T00:00:00.000Z',
          weightsPath: '/tmp/retired-ds4/model.gguf',
          contextWindow: 128_000,
          quantization: 'IQ2_XXS',
          chatTemplatePresent: true,
        },
      ],
    } as never);

    render(<Ds4ModelManager />);

    expect(await screen.findByText('Retired DS4')).toBeInTheDocument();
    expect(screen.getByText('on device')).toBeInTheDocument();
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
    // Planned row: the figure is re-based onto this device's window, so it is
    // quoted plainly and the tooltip breaks out the part the window moves.
    const planned = screen.getByText('36.0 GB in memory').closest('.model-size-cell');
    expect(planned).toHaveAttribute('title', expect.stringContaining('granted 128K window'));
    expect(planned).toHaveAttribute('title', expect.stringContaining('1.0 GB of context (KV)'));
    // No plan for the FP4 row — it keeps the flat authored footprint, says so,
    // and keeps the `~` the projected figure has earned its way out of.
    const flat = screen.getByText('~80.0 GB in memory').closest('.model-size-cell');
    expect(flat).toHaveAttribute('title', expect.stringContaining('no per-token slope'));
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

describe('Ds4ModelManager memory projection', () => {
  // Real catalog geometry: DeepSeek V4's compressed MLA KV is 8 KiB/token, so
  // a 64K launch costs exactly 0.5 GB less than a 128K one. The projection was
  // always context-aware; a whole-GB formatter rounded the difference away and
  // made the row look like a fixed number. The decimal is the guard.
  const RESIDENT_AT_128K = 80 * GiB;
  const KV_PER_TOKEN = 8192;
  const CONTEXT_FREE = RESIDENT_AT_128K - KV_PER_TOKEN * 131_072;

  function planAt(ctxTokens: number) {
    return {
      plans: {
        'deepseek-v4-flash-284b-q4': {
          effectiveContextWindow: ctxTokens,
          contextCeilingTokens: 262_144,
          projectedResidentBytes: CONTEXT_FREE + KV_PER_TOKEN * ctxTokens,
          kvBytesPerToken: KV_PER_TOKEN,
          contextFreeResidentBytes: CONTEXT_FREE,
        },
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
  });

  it('badges a fully resident model above the streaming rungs and prices it by weights', async () => {
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
          projectedResidentBytes: 36 * GiB,
          kvBytesPerToken: 8192,
          contextFreeResidentBytes: 35 * GiB,
          // The daemon's verdict, computed with the launcher's own residency
          // function — the UI must not re-derive it.
          fullyResident: true,
        },
      },
    } as never);

    render(<Ds4ModelManager />);

    expect(await screen.findByText('runs fully in memory · fastest')).toBeInTheDocument();
    // The catalog's `residentBytes` (36 GB) is a STREAMING expert-cache budget.
    // Quoting it for a resident launch understates the real cost by ~45 GB, so
    // the headline switches to the weights (81 GB in this fixture).
    expect(screen.getByText('81.0 GB in memory')).toBeInTheDocument();
    expect(screen.queryByText('36.0 GB in memory')).not.toBeInTheDocument();
  });

  it('quotes a smaller working set at a smaller context window', async () => {
    vi.mocked(api.listDs4ContextPlans).mockResolvedValue(planAt(65_536) as never);
    const { unmount } = render(<Ds4ModelManager />);
    expect(await screen.findByText('79.5 GB in memory')).toBeInTheDocument();
    unmount();

    vi.mocked(api.listDs4ContextPlans).mockResolvedValue(planAt(131_072) as never);
    render(<Ds4ModelManager />);
    expect(await screen.findByText('80.0 GB in memory')).toBeInTheDocument();
  });

  it('names the part of the figure the context window actually moves', async () => {
    vi.mocked(api.listDs4ContextPlans).mockResolvedValue(planAt(131_072) as never);

    render(<Ds4ModelManager />);

    const cell = (await screen.findByText('80.0 GB in memory')).closest('.model-size-cell');
    expect(cell).toHaveAttribute(
      'title',
      expect.stringContaining('79.0 GB of routed-expert cache'),
    );
    expect(cell).toHaveAttribute('title', expect.stringContaining('1.0 GB of context (KV)'));
    expect(cell).toHaveAttribute('title', expect.stringContaining('Only the second figure moves'));
  });
});
