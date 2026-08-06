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
    expect(screen.getByRole('columnheader', { name: 'Context cap' })).toBeInTheDocument();
    expect(screen.getByText('64K')).toBeInTheDocument();
    expect(screen.queryByText('128K')).not.toBeInTheDocument();
  });
});
