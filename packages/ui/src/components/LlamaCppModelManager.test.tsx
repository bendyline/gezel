import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    vi.clearAllMocks();
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

  it('shows the expected in-memory footprint beside the on-disk size', async () => {
    vi.mocked(api.listLlamaCppModels).mockResolvedValue({
      models: [
        {
          id: 'qwen3.5-4b-q4',
          name: 'Qwen 3.5 (4B)',
          approxSizeBytes: 2_600_000_000,
          installedAt: '2026-08-01T00:00:00.000Z',
          weightsPath: '/tmp/qwen3.5-4b-q4/model.gguf',
          contextWindow: 256_000,
          effectiveContextWindow: 65_536,
          // Weights + KV at the granted window — for a small dense model
          // the KV can exceed the weights, which is exactly why the disk
          // size alone misleads.
          predictedResidentBytes: 7_000_000_000,
          quantization: 'Q4_K_M',
          chatTemplatePresent: true,
        },
      ],
    } as never);

    render(<LlamaCppModelManager />);

    const memory = await screen.findByText(/~6\.5 GB in memory/);
    expect(memory.closest('td')).toHaveAttribute(
      'title',
      expect.stringMatching(/weights plus the KV cache/),
    );
    expect(memory.closest('td')?.textContent).toContain('2.4 GB');
  });

  it('headlines the single-chat cost and keeps the slot reservation in the tooltip', async () => {
    // The regression this pins: the headline used to quote weights + N
    // slots of KV, which on a 3-slot host read as ~49 GB for a model whose
    // measured peak RSS was ~32 GB. One chat is what the number should mean.
    vi.mocked(api.listLlamaCppModels).mockResolvedValue({
      models: [
        {
          id: 'qwen3.6-27b-q4',
          name: 'Qwen 3.6 (27B)',
          approxSizeBytes: 17_100_000_000,
          installedAt: '2026-08-01T00:00:00.000Z',
          weightsPath: '/tmp/qwen3.6-27b-q4/model.gguf',
          contextWindow: 262_144,
          effectiveContextWindow: 65_536,
          predictedResidentBytes: 30_100_000_000,
          reservedResidentBytes: 49_300_000_000,
          plannedSlots: 3,
          quantization: 'Q4_K_M',
          chatTemplatePresent: true,
        },
      ],
    } as never);

    render(<LlamaCppModelManager />);

    const memory = await screen.findByText(/~28\.0 GB in memory/);
    expect(screen.queryByText(/45\.9 GB in memory/)).not.toBeInTheDocument();
    const title = memory.closest('td')?.getAttribute('title') ?? '';
    expect(title).toMatch(/about 28\.0 GB of memory to serve one chat/);
    expect(title).toMatch(/Serving 3 chats at once reserves about 45\.9 GB/);
  });

  it('omits the concurrency sentence on a single-slot host', async () => {
    vi.mocked(api.listLlamaCppModels).mockResolvedValue({
      models: [
        {
          id: 'gemma4-e4b-q4',
          name: 'Gemma 4 (E4B)',
          approxSizeBytes: 4_200_000_000,
          installedAt: '2026-08-01T00:00:00.000Z',
          weightsPath: '/tmp/gemma4-e4b-q4/model.gguf',
          contextWindow: 128_000,
          effectiveContextWindow: 65_536,
          predictedResidentBytes: 9_000_000_000,
          reservedResidentBytes: 9_000_000_000,
          plannedSlots: 1,
          quantization: 'Q4_K_M',
          chatTemplatePresent: true,
        },
      ],
    } as never);

    render(<LlamaCppModelManager />);

    const memory = await screen.findByText(/~8\.4 GB in memory/);
    const title = memory.closest('td')?.getAttribute('title') ?? '';
    expect(title).toMatch(/serve one chat/);
    expect(title).not.toMatch(/at once reserves/);
  });

  it('does not stack inventory requests while shared models are being verified', async () => {
    let finish!: (value: { models: never[] }) => void;
    const verification = new Promise<{ models: never[] }>((resolve) => {
      finish = resolve;
    });
    vi.mocked(api.listLlamaCppModels).mockReturnValue(verification as never);

    render(<LlamaCppModelManager />);

    expect(screen.getByText(/Checking shared models/)).toBeInTheDocument();
    await waitFor(() => expect(api.listLlamaCppActiveInstalls).toHaveBeenCalled());
    expect(api.listLlamaCppModels).toHaveBeenCalledTimes(1);

    await act(async () => finish({ models: [] }));
    await waitFor(() =>
      expect(screen.queryByText(/Checking shared models/)).not.toBeInTheDocument(),
    );
  });

  it('refreshes inventory when an install finishes, not on every idle poll', async () => {
    vi.useFakeTimers();
    let active = false;
    vi.mocked(api.listLlamaCppActiveInstalls).mockImplementation(
      async () =>
        ({
          installs: active
            ? [
                {
                  catalogId: 'new-model',
                  bytesWritten: 1,
                  totalBytes: 2,
                  phase: 'downloading',
                },
              ]
            : [],
        }) as never,
    );

    render(<LlamaCppModelManager />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(api.listLlamaCppModels).toHaveBeenCalledTimes(1);

    active = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(api.listLlamaCppModels).toHaveBeenCalledTimes(1);

    active = false;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(api.listLlamaCppModels).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(api.listLlamaCppModels).toHaveBeenCalledTimes(2);
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
