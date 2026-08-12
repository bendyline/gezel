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
  ModelActionsMenu: ({
    model,
    onUpdate,
  }: {
    model: { updateAvailable?: boolean };
    onUpdate?: () => void;
  }) =>
    model.updateAvailable && onUpdate ? (
      <button type="button" onClick={onUpdate}>
        Update
      </button>
    ) : null,
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
    expect(screen.getByText(/download 153 GB/)).toBeInTheDocument();
    expect(screen.getByText(/memory target ≈ 80 GB/)).toBeInTheDocument();
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
    expect(screen.getByText(/754B · download 197 GB/)).toBeInTheDocument();
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

    expect(await screen.findByText(/context 128K/)).toBeInTheDocument();
    expect(
      screen.getByText(/memory target ≈ 36 GB at 128K context, with SSD streaming/),
    ).toBeInTheDocument();
    // No plan for the FP4 row — it keeps the flat authored footprint and
    // claims no relationship to the window.
    expect(screen.getByText(/memory target ≈ 80 GB with SSD streaming/)).toBeInTheDocument();
    // Nothing is installed, so there is no override to adjust yet.
    expect(screen.queryByRole('button', { name: 'Adjust' })).not.toBeInTheDocument();
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
