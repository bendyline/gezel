import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));

const { CapacityDeniedActions, shortModelName } = await import('./CapacityDeniedActions.js');
const { api } = await import('../api.js');

function renderActions() {
  const onRetry = vi.fn();
  const onError = vi.fn();
  render(<CapacityDeniedActions sessionId="s1" busy={false} onRetry={onRetry} onError={onError} />);
  return { onRetry, onError };
}

describe('CapacityDeniedActions', () => {
  beforeEach(() => {
    vi.mocked(api.getConfig).mockResolvedValue({
      defaultModel: { 'llama-cpp': 'qwen3.6-35b-a3b-q4', openai: 'gpt-5' },
    } as never);
    vi.mocked(api.updateConfig).mockResolvedValue({} as never);
  });

  // "Not enough memory" offered only Retry, which failed the same way, and
  // named no model that would have worked (2026-10-11).
  it('offers the model already on this computer instead of a Retry that cannot work', async () => {
    vi.mocked(api.getSessionModelFit).mockResolvedValue({
      provider: 'llama-cpp',
      model: 'qwen3.6-35b-a3b-q4',
      startsNow: false,
      followsDefault: true,
      alternative: { model: 'gemma4-12b-q4', name: 'Gemma 4 (12B, Q4)' },
    });
    const { onRetry } = renderActions();
    const key = await screen.findByTestId('capacity-alternative');
    expect(key).toHaveTextContent('Use Gemma 4 12B instead');
    expect(key).toHaveTextContent('already on this computer');
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();

    fireEvent.click(key);
    await waitFor(() => expect(onRetry).toHaveBeenCalledTimes(1));
    expect(api.updateConfig).toHaveBeenCalledWith({
      defaultModel: { 'llama-cpp': 'gemma4-12b-q4', openai: 'gpt-5' },
    });
  });

  it('shows Retry once the model would start', async () => {
    vi.mocked(api.getSessionModelFit).mockResolvedValue({
      provider: 'llama-cpp',
      model: 'qwen3.6-35b-a3b-q4',
      startsNow: true,
      followsDefault: true,
    });
    renderActions();
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByTestId('capacity-alternative')).not.toBeInTheDocument();
  });

  it('keeps Retry when the daemon cannot say', async () => {
    vi.mocked(api.getSessionModelFit).mockRejectedValue(new Error('404'));
    renderActions();
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('offers nothing to switch to when the gezel pins its own model', async () => {
    vi.mocked(api.getSessionModelFit).mockResolvedValue({
      provider: 'llama-cpp',
      model: 'qwen3.6-35b-a3b-q4',
      startsNow: false,
      followsDefault: false,
      alternative: { model: 'gemma4-12b-q4', name: 'Gemma 4 (12B, Q4)' },
    });
    renderActions();
    await waitFor(() => expect(api.getSessionModelFit).toHaveBeenCalled());
    expect(screen.queryByTestId('capacity-alternative')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('shortens a catalog name to the model a person chooses', () => {
    expect(shortModelName('Gemma 4 (12B, Q4)')).toBe('Gemma 4 12B');
    expect(shortModelName('Qwen 3.6 (35B-A3B, Q4)')).toBe('Qwen 3.6 35B-A3B');
    expect(shortModelName('Llama 3')).toBe('Llama 3');
  });
});
