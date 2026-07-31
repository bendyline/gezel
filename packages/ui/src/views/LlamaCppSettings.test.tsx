import type { HealthResponse } from '@bendyline/gezel';
import type { ConfigResponse } from '@bendyline/gezel-client';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));

vi.mock('../components/LlamaCppModelManager.js', () => ({
  LlamaCppModelManager: () => <div data-testid="llamacpp-manager">mock-manager</div>,
}));

const { LlamaCppSettings } = await import('./LlamaCppSettings.js');
const { api } = await import('../api.js');

const BASE_CONFIG = { provider: 'llama-cpp' } as ConfigResponse;
const BASE_HEALTH = {
  llamaCppBackend: 'cuda',
  llamaCppDetectedBackend: 'cuda',
  platform: 'win32',
} as HealthResponse;

describe('LlamaCppSettings', () => {
  beforeEach(() => {
    window.__GEZEL__ = { ...window.__GEZEL__!, platform: 'linux' };
    vi.mocked(api.listLlamaCppModels).mockResolvedValue({
      models: [
        { id: 'llama-3-8b', name: 'Llama 3 8B', sizeMb: 4500, status: 'installed' } as never,
        { id: 'qwen-2.5-7b', name: 'Qwen 2.5 7B', sizeMb: 4200, status: 'installed' } as never,
      ],
    } as never);
    vi.mocked(api.updateConfig).mockImplementation(
      async (patch) => ({ ...BASE_CONFIG, ...patch }) as ConfigResponse,
    );
    vi.mocked(api.getLlamaCppLog).mockResolvedValue({
      path: '/tmp/llamacpp.log',
      tail: 'engine started ok',
    } as never);
  });

  it('renders the installed model count and the default-model dropdown', async () => {
    render(
      <LlamaCppSettings config={BASE_CONFIG} onConfigChanged={vi.fn()} health={BASE_HEALTH} />,
    );
    await waitFor(() => {
      expect(screen.getByText(/Local models:/)).toBeInTheDocument();
    });
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /First local model/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Llama 3 8B \(llama-3-8b\)/ })).toBeInTheDocument();
  });

  it('shows machine-health controls on Windows and persists Manage mode', async () => {
    const user = userEvent.setup();
    render(
      <LlamaCppSettings config={BASE_CONFIG} onConfigChanged={vi.fn()} health={BASE_HEALTH} />,
    );

    const policy = await screen.findByRole('group', { name: 'Machine health mode' });
    expect(screen.getByRole('heading', { name: 'Machine health' })).toBeInTheDocument();
    const temperature = screen.getByRole('slider', { name: 'Manage temperature' });
    expect(temperature).toHaveValue('80');
    expect(temperature).toHaveAttribute('min', '40');
    expect(temperature).toHaveAttribute('max', '95');
    expect(temperature).toHaveAttribute('aria-valuetext', '80 degrees Celsius');
    expect(screen.getByText(/105°C emergency cutoff/)).toBeInTheDocument();

    await user.click(within(policy).getByRole('button', { name: /Manage/ }));

    await waitFor(() => {
      expect(api.updateConfig).toHaveBeenCalledWith({
        deviceSafety: { mode: 'guard' },
      });
    });
  });

  it('persists the Manage threshold with a five-degree resume margin', async () => {
    render(
      <LlamaCppSettings
        config={
          {
            ...BASE_CONFIG,
            deviceSafety: { mode: 'guard', maxStartTemperatureC: 80 },
          } as ConfigResponse
        }
        onConfigChanged={vi.fn()}
        health={BASE_HEALTH}
      />,
    );

    const input = await screen.findByRole('slider', { name: 'Manage temperature' });
    fireEvent.change(input, { target: { value: '90' } });
    expect(input).toHaveAttribute('aria-valuetext', '90 degrees Celsius');
    expect(screen.getByLabelText('Manage temperature: 90 degrees Celsius')).toBeInTheDocument();
    fireEvent.blur(input);

    await waitFor(() => {
      expect(api.updateConfig).toHaveBeenCalledWith({
        deviceSafety: {
          mode: 'guard',
          maxStartTemperatureC: 90,
          resumeTemperatureC: 85,
        },
      });
    });
  });

  it('hides machine-health controls on macOS', async () => {
    window.__GEZEL__ = { ...window.__GEZEL__!, platform: 'darwin' };
    render(
      <LlamaCppSettings
        config={BASE_CONFIG}
        onConfigChanged={vi.fn()}
        health={{ ...BASE_HEALTH, platform: 'darwin' } as HealthResponse}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(/Local models:/)).toBeInTheDocument();
    });
    expect(screen.queryByRole('heading', { name: 'Machine health' })).not.toBeInTheDocument();
  });

  it('selecting a default model patches config.defaultModel.llama-cpp', async () => {
    const onConfigChanged = vi.fn();
    render(
      <LlamaCppSettings
        config={BASE_CONFIG}
        onConfigChanged={onConfigChanged}
        health={BASE_HEALTH}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText(/Local models:/)).toBeInTheDocument();
    });

    // The default-model select is the first <select>; backend is second.
    const selects = screen.getAllByRole('combobox') as HTMLSelectElement[];
    fireEvent.change(selects[0]!, { target: { value: 'qwen-2.5-7b' } });

    await waitFor(() => {
      expect(api.updateConfig).toHaveBeenCalledWith({
        defaultModel: { 'llama-cpp': 'qwen-2.5-7b' },
      });
    });
    expect(onConfigChanged).toHaveBeenCalled();
  });

  it('changing the backend override saves the value', async () => {
    render(
      <LlamaCppSettings config={BASE_CONFIG} onConfigChanged={vi.fn()} health={BASE_HEALTH} />,
    );
    await waitFor(() => {
      expect(screen.getByText(/Engine backend/)).toBeInTheDocument();
    });

    const selects = screen.getAllByRole('combobox') as HTMLSelectElement[];
    // Backend select is the second one (default-model select is first).
    fireEvent.change(selects[1]!, { target: { value: 'cpu' } });

    await waitFor(() => {
      expect(api.updateConfig).toHaveBeenCalledWith({ llamaCppBackendOverride: 'cpu' });
    });
  });

  it('selecting auto-detect clears the override (sends undefined)', async () => {
    const cfgWithOverride = { ...BASE_CONFIG, llamaCppBackendOverride: 'cpu' } as ConfigResponse;
    render(
      <LlamaCppSettings config={cfgWithOverride} onConfigChanged={vi.fn()} health={BASE_HEALTH} />,
    );
    await waitFor(() => {
      expect(screen.getByText(/Engine backend/)).toBeInTheDocument();
    });

    const selects = screen.getAllByRole('combobox') as HTMLSelectElement[];
    fireEvent.change(selects[1]!, { target: { value: 'auto' } });

    await waitFor(() => {
      expect(api.updateConfig).toHaveBeenCalledWith({ llamaCppBackendOverride: undefined });
    });
  });

  it('shows the "Restart the app to apply" hint when override differs from running backend', async () => {
    const cfgWithOverride = { ...BASE_CONFIG, llamaCppBackendOverride: 'vulkan' } as ConfigResponse;
    render(
      <LlamaCppSettings config={cfgWithOverride} onConfigChanged={vi.fn()} health={BASE_HEALTH} />,
    );
    await waitFor(() => {
      expect(screen.getByText(/Restart the app to apply/)).toBeInTheDocument();
    });
  });

  it('does NOT show the restart hint when override matches running backend', async () => {
    render(
      <LlamaCppSettings config={BASE_CONFIG} onConfigChanged={vi.fn()} health={BASE_HEALTH} />,
    );
    await waitFor(() => {
      expect(screen.getByText(/Engine backend/)).toBeInTheDocument();
    });
    expect(screen.queryByText(/Restart the app to apply/)).not.toBeInTheDocument();
  });

  it('saving an external base URL calls updateConfig with the trimmed value', async () => {
    render(
      <LlamaCppSettings config={BASE_CONFIG} onConfigChanged={vi.fn()} health={BASE_HEALTH} />,
    );
    await waitFor(() => {
      expect(screen.getByText(/Advanced/)).toBeInTheDocument();
    });

    const user = userEvent.setup();
    const urlInput = screen.getByPlaceholderText(/127\.0\.0\.1:8080/) as HTMLInputElement;
    await user.type(urlInput, '  http://10.0.0.5:8080  ');

    const enabledSave = screen
      .getAllByRole('button', { name: /^Save$/ })
      .find((b) => !(b as HTMLButtonElement).disabled);
    await user.click(enabledSave as HTMLElement);

    await waitFor(() => {
      expect(api.updateConfig).toHaveBeenCalledWith({ llamaCppBaseUrl: 'http://10.0.0.5:8080' });
    });
  });

  it('the engine log expand-and-load fetches via getLlamaCppLog', async () => {
    render(
      <LlamaCppSettings config={BASE_CONFIG} onConfigChanged={vi.fn()} health={BASE_HEALTH} />,
    );
    await waitFor(() => {
      expect(screen.getByText(/Engine log/)).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /^Refresh$/ }));

    await waitFor(() => {
      expect(api.getLlamaCppLog).toHaveBeenCalledWith(4096);
    });
    await waitFor(() => {
      expect(screen.getByText(/engine started ok/)).toBeInTheDocument();
    });
  });

  it('renders the using-external-engine pill when llamaCppBaseUrl is set', async () => {
    render(
      <LlamaCppSettings
        config={{ ...BASE_CONFIG, llamaCppBaseUrl: 'http://10.0.0.1:8080' } as ConfigResponse}
        onConfigChanged={vi.fn()}
        health={BASE_HEALTH}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText(/using external engine/)).toBeInTheDocument();
    });
  });
  // `--swa-full` is the precondition for llama-server accepting
  // `--cache-reuse` on SWA models; without it the engine logs
  // "cache_reuse is not supported by this context" and drops the flag.
  it('toggling the full SWA cache saves llamaCppSwaFull', async () => {
    render(
      <LlamaCppSettings config={BASE_CONFIG} onConfigChanged={vi.fn()} health={BASE_HEALTH} />,
    );
    await waitFor(() => {
      expect(screen.getByText(/Full SWA cache/)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText(/full-size sliding-window KV cache/i));

    await waitFor(() => {
      expect(api.updateConfig).toHaveBeenCalledWith({ llamaCppSwaFull: true });
    });
  });

  it('clearing the full SWA cache sends undefined, not false', async () => {
    render(
      <LlamaCppSettings
        config={{ ...BASE_CONFIG, llamaCppSwaFull: true } as ConfigResponse}
        onConfigChanged={vi.fn()}
        health={BASE_HEALTH}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText(/Full SWA cache/)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText(/full-size sliding-window KV cache/i));

    await waitFor(() => {
      expect(api.updateConfig).toHaveBeenCalledWith({ llamaCppSwaFull: undefined });
    });
  });
});
