import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));
vi.mock('./ModelBundleControls.js', () => ({
  ExportModelBundleButton: () => null,
  ImportModelBundleButton: () => <button type="button">Import .gezmodel</button>,
}));

const { LlamaCppModelManager } = await import('./LlamaCppModelManager.js');
const { api } = await import('../api.js');

const GiB = 1024 ** 3;

function catalogModel(id: string, name: string, category: 'general' | 'coding') {
  return {
    source: { id: 'bundled', label: 'Bundled' },
    manifest: {
      schemaVersion: 1,
      kind: 'chat-model',
      id,
      name,
      version: '1.0.0',
      description: 'test model',
      tags: [],
      category,
      license: 'MIT',
      licenseClass: 'open',
      parameterSize: '7B',
      approxSizeBytes: 4 * GiB,
      supportsTools: true,
      contextWindow: 32_768,
      llamaCpp: {
        huggingfaceRepo: `test/${id}`,
        filename: `${id}.gguf`,
        sha256: 'a'.repeat(64),
        approxSizeBytes: 4 * GiB,
        quantization: 'Q4_K_M',
      },
    },
  };
}

describe('LlamaCppModelManager local model list', () => {
  beforeEach(() => {
    vi.mocked(api.listLlamaCppModels).mockResolvedValue({
      models: [
        {
          id: 'gemma4-e4b-q4',
          name: 'Gemma 4 (E4B)',
          approxSizeBytes: 4.3 * GiB,
          installedAt: '2026-08-01T00:00:00.000Z',
          weightsPath: '/tmp/gemma4-e4b-q4/model.gguf',
          contextWindow: 131_072,
          effectiveContextWindow: 65_536,
          quantization: 'Q4_K_M',
          chatTemplatePresent: true,
        },
      ],
    } as never);
    vi.mocked(api.listLlamaCppActiveInstalls).mockResolvedValue({ installs: [] } as never);
    vi.mocked(api.listCatalogItems).mockResolvedValue({ items: [] } as never);
    vi.mocked(api.listModelFitness).mockResolvedValue({ records: [], probing: [] } as never);
  });

  it("shows Gezel's effective cap rather than the model's advertised window", async () => {
    render(<LlamaCppModelManager />);

    expect(await screen.findByText('gemma4-e4b-q4')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Context size' })).toBeInTheDocument();
    expect(screen.getByText('64K')).toBeInTheDocument();
    expect(screen.queryByText('128K')).not.toBeInTheDocument();
  });

  it('explains when the selected context policy will not fit', async () => {
    vi.mocked(api.listLlamaCppModels).mockResolvedValue({
      models: [
        {
          id: 'qwen3.6-27b-q4',
          name: 'Qwen 3.6 (27B)',
          approxSizeBytes: 17 * GiB,
          installedAt: '2026-08-01T00:00:00.000Z',
          weightsPath: '/tmp/qwen3.6-27b-q4/model.gguf',
          contextWindow: 262_144,
          contextSizingStatus: 'insufficient-memory',
          quantization: 'Q4_K_M',
          chatTemplatePresent: true,
        },
      ],
    } as never);

    render(<LlamaCppModelManager />);

    const cell = await screen.findByText("Won't fit");
    expect(cell).toHaveAttribute('title', expect.stringMatching(/Choose Adaptive/));
    // The tooltip names the window the policy is insisting on, so the scale
    // of the ask is visible next to the refusal.
    expect(cell).toHaveAttribute('title', expect.stringMatching(/262,144-token window/));
  });

  it('tells a resident-below-policy model to restart, not to free memory', async () => {
    vi.mocked(api.listLlamaCppModels).mockResolvedValue({
      models: [
        {
          id: 'gemma4-12b-q4',
          name: 'Gemma 4 (12B)',
          approxSizeBytes: 7 * GiB,
          installedAt: '2026-08-01T00:00:00.000Z',
          weightsPath: '/tmp/gemma4-12b-q4/model.gguf',
          contextWindow: 256_000,
          contextSizingStatus: 'restart-required',
          quantization: 'Q4_K_M',
          chatTemplatePresent: true,
        },
      ],
    } as never);

    render(<LlamaCppModelManager />);

    const cell = await screen.findByText('Restart needed');
    expect(cell).toHaveAttribute('title', expect.stringMatching(/Restart the local engine/));
    expect(cell).toHaveAttribute('title', expect.not.stringMatching(/free memory/));
  });

  it('shows one continuous catalog without category filter buttons', async () => {
    vi.mocked(api.listCatalogItems).mockResolvedValue({
      items: [
        catalogModel('general-model', 'General Model', 'general'),
        catalogModel('coding-model', 'Coding Model', 'coding'),
      ],
    } as never);

    render(<LlamaCppModelManager />);

    expect(await screen.findByText('General Model')).toBeInTheDocument();
    expect(screen.getByText('Coding Model')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'All' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'General' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Coding' })).not.toBeInTheDocument();
  });
});
