import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));

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
});
