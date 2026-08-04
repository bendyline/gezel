import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';
import { primitivesMock } from '../test-utils/primitivesMock.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));
vi.mock('../primitives/index.js', () => primitivesMock);

const { ModelPicker } = await import('./ModelPicker.js');
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
});
