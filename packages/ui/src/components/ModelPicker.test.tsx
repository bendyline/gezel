import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';
import { primitivesMock } from '../test-utils/primitivesMock.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));
vi.mock('../primitives/index.js', () => primitivesMock);

const { ModelPicker, EffortTray } = await import('./ModelPicker.js');
const { api } = await import('../api.js');
const { announceModelInventoryChanged } = await import('../model-inventory.js');

describe('ModelPicker model inventory', () => {
  beforeEach(() => {
    vi.mocked(api.listModelFitness).mockResolvedValue({ records: [], probing: [] } as never);
  });

  it('forces a broker refresh after a native model inventory change', async () => {
    vi.mocked(api.listProviderModels)
      .mockResolvedValueOnce({
        provider: 'ds4',
        models: [{ id: 'old.gguf', name: 'Old' }],
      } as never)
      .mockResolvedValueOnce({
        provider: 'ds4',
        models: [{ id: 'new.gguf', name: 'New' }],
      } as never);

    render(<ModelPicker provider="ds4" value={undefined} onChange={vi.fn()} />);
    await waitFor(() => expect(api.listProviderModels).toHaveBeenCalledTimes(1));

    announceModelInventoryChanged('ds4');

    await waitFor(() => {
      expect(api.listProviderModels).toHaveBeenNthCalledWith(2, 'ds4', { refresh: true });
      expect(screen.getByText('New')).toBeInTheDocument();
    });
  });

  it('keeps reasoning choices keyboard-reachable when the saved effort is unavailable', async () => {
    vi.mocked(api.listProviderModels).mockResolvedValue({
      provider: 'openai',
      models: [
        {
          id: 'review-model',
          name: 'Review model',
          supportsReasoning: true,
          reasoningEfforts: ['low', 'high'],
        },
      ],
    } as never);
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <EffortTray
        provider="openai"
        model="review-model"
        value="unsupported-effort"
        onChange={onChange}
      />,
    );
    const fallback = await screen.findByRole('radio', { name: 'Model default' });
    await user.tab();
    expect(fallback).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('radio', { name: 'Low' })).toHaveFocus();
    expect(onChange).toHaveBeenCalledWith('low');
  });
});
