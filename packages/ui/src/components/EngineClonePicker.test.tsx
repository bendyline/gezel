import type { ConfigResponse } from '@bendyline/gezel-client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));

const { EngineClonePicker, copiesSentence } = await import('./EngineClonePicker.js');
const { api } = await import('../api.js');

const GB = 1024 ** 3;

function configWith(replicas: Record<string, number>): ConfigResponse {
  return { localEngineReplicas: replicas, localEngineReplicasMax: 4 } as unknown as ConfigResponse;
}

describe('EngineClonePicker', () => {
  it('names the fixed cost of a copy and points at workers instead', () => {
    render(
      <EngineClonePicker
        provider="mlx"
        modelId="qwen3.8-27b-q4"
        modelName="Qwen 3.8 (27B, Q4)"
        modelBytes={16.3 * GB}
        config={configWith({ 'qwen3.8-27b-q4': 1 })}
        onConfigChanged={() => undefined}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Copies of the model' })).toBeInTheDocument();
    expect(
      screen.getByText(
        /Each extra copy needs at least 16\.3 GB more, plus room for its own workers\./,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/more parallel workers usually do the job/)).toBeInTheDocument();
    expect(screen.getByLabelText('Copies of the model')).toHaveTextContent('1');
  });

  it('loads another copy through the pool', async () => {
    vi.mocked(api.updateConfig).mockResolvedValue(configWith({ m: 2 }));
    vi.mocked(api.reconcileEnginePool).mockResolvedValue({ ok: true } as never);
    render(
      <EngineClonePicker
        provider="llama-cpp"
        modelId="m"
        config={configWith({ m: 1 })}
        onConfigChanged={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'One more copy' }));
    await waitFor(() =>
      expect(api.reconcileEnginePool).toHaveBeenCalledWith({
        provider: 'llama-cpp',
        clones: { m: 2 },
      }),
    );
  });

  it('falls back to plain words when the model cannot be priced', () => {
    expect(copiesSentence(undefined)).toContain(
      'Each extra copy loads the model again, plus room for its own workers.',
    );
  });
});
