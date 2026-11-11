import type { ConfigResponse } from '@bendyline/gezel-client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));

const { ParallelWorkersPicker, workerPricing, workersSentence } = await import(
  './ParallelWorkersPicker.js'
);
const { api } = await import('../api.js');

const GB = 1024 ** 3;

// Qwen 3.8 27B Q4 at 262k tokens on a 128 GB Mac: the launch admitted
// three chats, each priced at full precision.
const qwen = {
  name: 'Qwen 3.8 (27B, Q4)',
  weightsResidentBytes: 16.3 * GB,
  reservedResidentBytes: (16.3 + 3 * 16.5) * GB,
  plannedSlots: 3,
};

function configWith(providerConcurrency?: Record<string, number>): ConfigResponse {
  return { providerConcurrency } as unknown as ConfigResponse;
}

describe('ParallelWorkersPicker', () => {
  beforeEach(() => {
    vi.mocked(api.updateConfig).mockReset().mockResolvedValue(configWith());
  });

  it('prices the model by itself and each worker it adds', () => {
    render(
      <ParallelWorkersPicker
        provider="mlx"
        model={qwen}
        config={configWith()}
        onConfigChanged={() => undefined}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Parallel workers' })).toBeInTheDocument();
    expect(
      screen.getByText(
        'How many chats run at the same time. Qwen 3.8 (27B, Q4) uses 16.3 GB by itself, and each worker adds about 16.5 GB.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Parallel workers')).toHaveTextContent('3');
    expect(screen.getByText('Automatic')).toBeInTheDocument();
    expect(screen.getByText('About 65.8 GB in all')).toBeInTheDocument();
    expect(screen.queryByText(/mmap|KV cache|replica|slot/i)).not.toBeInTheDocument();
  });

  it('saves a chosen count for this engine and keeps the others', async () => {
    const onSaved = vi.fn();
    render(
      <ParallelWorkersPicker
        provider="mlx"
        model={qwen}
        config={configWith({ 'llama-cpp': 2 })}
        onConfigChanged={() => undefined}
        onSaved={onSaved}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'One more worker' }));
    await waitFor(() =>
      expect(api.updateConfig).toHaveBeenCalledWith({
        providerConcurrency: { 'llama-cpp': 2, mlx: 4 },
      }),
    );
    expect(onSaved).toHaveBeenCalled();
    expect(await screen.findByText('Saved. It applies from the next chat.')).toBeInTheDocument();
  });

  it('goes back to automatic by dropping only this engine', async () => {
    render(
      <ParallelWorkersPicker
        provider="mlx"
        model={{ ...qwen, plannedSlots: 2 }}
        config={configWith({ mlx: 2, 'llama-cpp': 2 })}
        onConfigChanged={() => undefined}
      />,
    );

    expect(screen.queryByText('Automatic')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Use automatic' }));
    await waitFor(() =>
      expect(api.updateConfig).toHaveBeenCalledWith({
        providerConcurrency: { 'llama-cpp': 2 },
      }),
    );
  });
});

describe('workerPricing', () => {
  it('needs a priced plan', () => {
    expect(workerPricing(undefined)).toBeUndefined();
    expect(workerPricing({ name: 'm', weightsResidentBytes: 4 * GB })).toBeUndefined();
    expect(workersSentence('m', undefined)).toBe(
      'How many chats run at the same time. Each worker needs extra memory for its chat.',
    );
  });
});
