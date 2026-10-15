import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';
import { primitivesMock } from '../test-utils/primitivesMock.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));
vi.mock('../primitives/index.js', () => primitivesMock);

const { ProviderModelSelect } = await import('./ProviderModelSelect.js');
const { api } = await import('../api.js');

describe('ProviderModelSelect', () => {
  // A gezel's header read "Model: loading providers…" for as long as the
  // slowest provider probe took; the current choice was known all along.
  it('shows the current choice while providers are still answering', () => {
    vi.mocked(api.getConfig).mockReturnValue(new Promise(() => {}) as never);
    const { rerender } = render(
      <ProviderModelSelect
        provider={null}
        model={undefined}
        onChange={() => {}}
        globalProvider="llama-cpp"
      />,
    );
    expect(screen.getByText(/^Inherit default \(/)).toBeInTheDocument();
    expect(screen.queryByText(/loading providers/)).not.toBeInTheDocument();

    rerender(
      <ProviderModelSelect
        provider="llama-cpp"
        model="gemma4-31b-q4"
        onChange={() => {}}
        globalProvider="llama-cpp"
      />,
    );
    expect(screen.getByText(/· gemma4-31b-q4$/)).toBeInTheDocument();
  });

  // Connecting to a server promised "Its models are in your model picker",
  // and a gezel's picker offered none of them.
  it("offers a paired server's models under the server's name", async () => {
    vi.mocked(api.getConfig).mockResolvedValue({ provider: 'llama-cpp' } as never);
    vi.mocked(api.getCopilotStatus).mockResolvedValue({ available: false } as never);
    vi.mocked(api.listProviderModels).mockResolvedValue({ models: [] } as never);
    vi.mocked(api.listRemoteServerModels).mockResolvedValue({
      servers: [
        {
          remoteId: 'a',
          displayName: 'Werkbank',
          status: 'online',
          models: [{ id: 'remote:a/llama-cpp:qwen', name: 'Qwen 27B' }],
        },
      ],
    } as never);
    const onChange = vi.fn();
    render(
      <ProviderModelSelect
        provider={null}
        model={undefined}
        onChange={onChange}
        globalProvider="llama-cpp"
      />,
    );
    const option = await screen.findByRole('option', { name: 'Werkbank — Qwen 27B' });
    fireEvent.change(screen.getByTestId('mock-select'), {
      target: { value: option.getAttribute('value') },
    });
    expect(onChange).toHaveBeenCalledWith('remote', 'remote:a/llama-cpp:qwen');
  });
});
