import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));
vi.mock('./ModelBundleControls.js', () => ({
  ExportModelBundleButton: () => null,
  ImportModelBundleButton: () => <button type="button">Import .gezmodel</button>,
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
    expect(screen.getByText(/download 153 GiB/)).toBeInTheDocument();
    expect(screen.getByText(/memory target ≈ 80 GiB/)).toBeInTheDocument();
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
    expect(screen.getByText(/754B · download 197 GiB/)).toBeInTheDocument();
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
});
