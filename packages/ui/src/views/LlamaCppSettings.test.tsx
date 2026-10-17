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
vi.mock('../components/EngineBudgetStrip.js', () => ({
  EngineBudgetStrip: () => <div data-testid="engine-memory">mock-engine-memory</div>,
}));

const { LlamaCppSettings } = await import('./LlamaCppSettings.js');
const { api } = await import('../api.js');

const BASE_CONFIG = { provider: 'llama-cpp' } as ConfigResponse;
const BASE_HEALTH = {
  llamaCppBackend: 'cuda',
  llamaCppDetectedBackend: 'cuda',
  platform: 'win32',
} as HealthResponse;

async function openAdvanced() {
  const heading = screen.getByRole('heading', { name: 'Advanced' });
  const details = heading.closest('details') as HTMLDetailsElement;
  if (!details.open) await userEvent.click(heading);
  return details;
}

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
    vi.mocked(api.getLlamaCppContextSizing).mockResolvedValue({ policy: 'adaptive' });
    vi.mocked(api.getLlamaCppQuarantine).mockResolvedValue({ entries: [], strikeThreshold: 3 });
    vi.mocked(api.getLlamaCppBackendHealth).mockResolvedValue({});
    vi.mocked(api.updateLlamaCppContextSizing).mockImplementation(async (policy) => ({ policy }));
    vi.mocked(api.getLlamaCppLog).mockResolvedValue({
      path: '/tmp/llamacpp.log',
      tail: 'engine started ok',
    } as never);
  });

  it('renders the default-model dropdown without repeating the installed model count', async () => {
    render(
      <LlamaCppSettings config={BASE_CONFIG} onConfigChanged={vi.fn()} health={BASE_HEALTH} />,
    );
    expect(await screen.findByRole('option', { name: /First local model/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Llama 3 8B \(llama-3-8b\)/ })).toBeInTheDocument();
    expect(screen.queryByText(/Local models:/)).not.toBeInTheDocument();
  });

  it('shows model selection and downloads before engine memory management', async () => {
    render(
      <LlamaCppSettings config={BASE_CONFIG} onConfigChanged={vi.fn()} health={BASE_HEALTH} />,
    );

    const defaultModel = await screen.findByRole('heading', { name: 'Default model' });
    const models = screen.getByTestId('llamacpp-manager');
    const memory = screen.getByTestId('engine-memory');

    expect(defaultModel.compareDocumentPosition(models) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(models.compareDocumentPosition(memory) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
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

    await screen.findByRole('option', { name: /First local model/ });
    expect(screen.queryByRole('heading', { name: 'Machine health' })).not.toBeInTheDocument();
  });

  it('collapses Advanced by default and toggles it from the disclosure heading', async () => {
    render(
      <LlamaCppSettings config={BASE_CONFIG} onConfigChanged={vi.fn()} health={BASE_HEALTH} />,
    );

    const heading = screen.getByRole('heading', { name: 'Advanced' });
    const details = heading.closest('details') as HTMLDetailsElement;
    const contextSizing = screen.getByLabelText('Context sizing');

    expect(details).not.toHaveAttribute('open');
    expect(contextSizing).not.toBeVisible();

    await userEvent.click(heading);
    expect(details).toHaveAttribute('open');
    expect(contextSizing).toBeVisible();

    await userEvent.click(heading);
    expect(details).not.toHaveAttribute('open');
    expect(contextSizing).not.toBeVisible();
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
    await screen.findByRole('option', { name: /First local model/ });

    // The default-model select remains first even as Advanced gains controls.
    const selects = screen.getAllByRole('combobox') as HTMLSelectElement[];
    fireEvent.change(selects[0]!, { target: { value: 'qwen-2.5-7b' } });

    await waitFor(() => {
      expect(api.updateConfig).toHaveBeenCalledWith({
        defaultModel: { 'llama-cpp': 'qwen-2.5-7b' },
      });
    });
    expect(onConfigChanged).toHaveBeenCalled();
  });

  it('clears the saved-status reset timer when the view unmounts', async () => {
    const setTimeoutSpy = vi.spyOn(window, 'setTimeout');
    const clearTimeoutSpy = vi.spyOn(window, 'clearTimeout');
    try {
      const { unmount } = render(
        <LlamaCppSettings config={BASE_CONFIG} onConfigChanged={vi.fn()} health={BASE_HEALTH} />,
      );
      await screen.findByRole('option', { name: /First local model/ });

      const defaultModel = screen.getAllByRole('combobox')[0]!;
      fireEvent.change(defaultModel, { target: { value: 'qwen-2.5-7b' } });
      await screen.findByText('saved ✓');

      const resetTimerCall = setTimeoutSpy.mock.calls.findIndex(([, delay]) => delay === 1200);
      expect(resetTimerCall).toBeGreaterThanOrEqual(0);
      const resetTimer = setTimeoutSpy.mock.results[resetTimerCall]!.value;

      unmount();

      expect(clearTimeoutSpy).toHaveBeenCalledWith(resetTimer);
    } finally {
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
    }
  });

  it('changing the backend override saves the value', async () => {
    render(
      <LlamaCppSettings config={BASE_CONFIG} onConfigChanged={vi.fn()} health={BASE_HEALTH} />,
    );
    await openAdvanced();
    await waitFor(() => {
      expect(screen.getByText(/Engine backend/)).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText('Engine backend'), { target: { value: 'cpu' } });

    await waitFor(() => {
      expect(api.updateConfig).toHaveBeenCalledWith({ llamaCppBackendOverride: 'cpu' });
    });
  });

  it('selecting auto-detect clears the override (sends null)', async () => {
    const cfgWithOverride = { ...BASE_CONFIG, llamaCppBackendOverride: 'cpu' } as ConfigResponse;
    render(
      <LlamaCppSettings config={cfgWithOverride} onConfigChanged={vi.fn()} health={BASE_HEALTH} />,
    );
    await openAdvanced();
    await waitFor(() => {
      expect(screen.getByText(/Engine backend/)).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText('Engine backend'), { target: { value: 'auto' } });

    // null, not undefined: undefined is stripped by JSON.stringify, so only
    // an explicit null clears the pinned value on the store side.
    await waitFor(() => {
      expect(api.updateConfig).toHaveBeenCalledWith({ llamaCppBackendOverride: null });
    });
  });

  it('shows the "Restart the app to apply" hint when override differs from running backend', async () => {
    const cfgWithOverride = { ...BASE_CONFIG, llamaCppBackendOverride: 'vulkan' } as ConfigResponse;
    render(
      <LlamaCppSettings config={cfgWithOverride} onConfigChanged={vi.fn()} health={BASE_HEALTH} />,
    );
    await openAdvanced();
    await waitFor(() => {
      expect(screen.getByText(/Restart the app to apply/)).toBeInTheDocument();
    });
  });

  it('loads and persists the machine-owned context sizing policy', async () => {
    render(
      <LlamaCppSettings config={BASE_CONFIG} onConfigChanged={vi.fn()} health={BASE_HEALTH} />,
    );

    await openAdvanced();
    const selector = await screen.findByLabelText('Context sizing');
    expect(selector).toHaveValue('adaptive');

    fireEvent.change(selector, { target: { value: 'model-max' } });

    await waitFor(() => {
      expect(api.updateLlamaCppContextSizing).toHaveBeenCalledWith('model-max');
    });
    expect(selector).toHaveValue('model-max');
    expect(screen.getByText(/model's full advertised window/i)).toBeInTheDocument();
  });

  it('does NOT show the restart hint when override matches running backend', async () => {
    render(
      <LlamaCppSettings config={BASE_CONFIG} onConfigChanged={vi.fn()} health={BASE_HEALTH} />,
    );
    await openAdvanced();
    await waitFor(() => {
      expect(screen.getByText(/Engine backend/)).toBeInTheDocument();
    });
    expect(screen.queryByText(/Restart the app to apply/)).not.toBeInTheDocument();
  });

  it('saving an external base URL calls updateConfig with the trimmed value', async () => {
    render(
      <LlamaCppSettings config={BASE_CONFIG} onConfigChanged={vi.fn()} health={BASE_HEALTH} />,
    );
    await openAdvanced();

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
    await openAdvanced();
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

  describe('a build switched off after crashing while starting', () => {
    const switchedOff = {
      entries: [
        {
          backend: 'vulkan' as const,
          signal: 'exit:0xc0000005',
          reason: 'exited with 0xc0000005 (access violation) before the engine became ready',
          at: '2026-10-17T14:00:00.000Z',
          crashes: 3,
        },
      ],
      strikeThreshold: 3,
      running: 'cpu' as const,
    };
    const fallbackHealth = {
      ...BASE_HEALTH,
      llamaCppBackend: 'cpu',
      llamaCppDetectedBackend: 'vulkan',
      llamaCppQuarantinedBackends: ['vulkan'],
    } as HealthResponse;

    it('says what happened and turns the build back on', async () => {
      vi.mocked(api.getLlamaCppQuarantine).mockResolvedValue(switchedOff);
      vi.mocked(api.clearLlamaCppQuarantine).mockResolvedValue({
        entries: [],
        strikeThreshold: 3,
        running: 'vulkan',
      });
      render(
        <LlamaCppSettings config={BASE_CONFIG} onConfigChanged={vi.fn()} health={fallbackHealth} />,
      );

      // Outside the collapsed Advanced section: it explains a slow engine.
      const notice = await screen.findByTestId('llama-quarantine-vulkan');
      expect(notice).toBeVisible();
      expect(notice).toHaveTextContent('GPU (Vulkan) is switched off on this machine.');
      expect(notice).toHaveTextContent('It crashed 3 times in a row while starting');
      expect(notice).toHaveTextContent('so Gezel is using CPU instead');
      expect(notice).toHaveTextContent('(exit:0xc0000005)');

      await userEvent.click(within(notice).getByRole('button', { name: 'Try GPU (Vulkan) again' }));

      await waitFor(() => expect(api.clearLlamaCppQuarantine).toHaveBeenCalledWith('vulkan'));
      expect(await screen.findByText(/GPU \(Vulkan\) is back on\./)).toBeInTheDocument();
      expect(screen.queryByTestId('llama-quarantine-vulkan')).not.toBeInTheDocument();
    });

    it('keeps the notice and says why when the build cannot be turned back on', async () => {
      vi.mocked(api.getLlamaCppQuarantine).mockResolvedValue(switchedOff);
      vi.mocked(api.clearLlamaCppQuarantine).mockRejectedValue(new Error('engine owner offline'));
      render(
        <LlamaCppSettings config={BASE_CONFIG} onConfigChanged={vi.fn()} health={fallbackHealth} />,
      );

      const notice = await screen.findByTestId('llama-quarantine-vulkan');
      await userEvent.click(within(notice).getByRole('button', { name: 'Try GPU (Vulkan) again' }));

      expect(
        await within(notice).findByText(
          'Could not turn GPU (Vulkan) back on: engine owner offline',
        ),
      ).toBeInTheDocument();
      expect(screen.queryByText(/is back on/)).not.toBeInTheDocument();
    });

    it('stays quiet while a pinned backend decides what runs', async () => {
      vi.mocked(api.getLlamaCppQuarantine).mockResolvedValue(switchedOff);
      render(
        <LlamaCppSettings
          config={{ ...BASE_CONFIG, llamaCppBackendOverride: 'cpu' } as ConfigResponse}
          onConfigChanged={vi.fn()}
          health={fallbackHealth}
        />,
      );

      await waitFor(() => expect(api.getLlamaCppQuarantine).toHaveBeenCalled());
      await screen.findByRole('option', { name: /First local model/ });
      expect(screen.queryByTestId('llama-quarantine-vulkan')).not.toBeInTheDocument();
    });
  });

  describe('an engine that is not getting the GPU this machine has', () => {
    it('asks for a newer NVIDIA driver instead of a restart that changes nothing', async () => {
      vi.mocked(api.getLlamaCppBackendHealth).mockResolvedValue({
        running: 'vulkan',
        cudaBlocker: {
          kind: 'driver-too-old',
          installed: '570.86.10',
          required: '580.65.06',
          cudaToolkit: '13.0',
          detail: 'NVIDIA driver 570.86.10 is older than 580.65.06',
        },
      });
      render(
        <LlamaCppSettings
          config={BASE_CONFIG}
          onConfigChanged={vi.fn()}
          health={{ ...BASE_HEALTH, llamaCppBackend: 'vulkan' } as HealthResponse}
        />,
      );

      const notice = await screen.findByTestId('settings-notice-engine-gpu-unused');
      expect(notice).toBeVisible();
      expect(notice).toHaveTextContent('Your NVIDIA driver is too old');
      expect(notice).toHaveTextContent('version 580.65.06 or newer');
      // Auto-detect found CUDA and runs Vulkan, but a restart would pass CUDA
      // over again: the notice, not the restart hint, is the answer.
      await openAdvanced();
      await screen.findByText(/Engine backend/);
      expect(screen.queryByText(/Restart the app to apply/)).not.toBeInTheDocument();
    });

    it('says a GPU build is running without its GPU', async () => {
      vi.mocked(api.getLlamaCppBackendHealth).mockResolvedValue({
        running: 'cuda',
        gpuUnused: {
          backend: 'cuda',
          reason: 'init-failed',
          detail: 'CUDA driver version is insufficient for CUDA runtime version',
          at: '2026-10-17T10:00:00.000Z',
        },
      });
      render(
        <LlamaCppSettings config={BASE_CONFIG} onConfigChanged={vi.fn()} health={BASE_HEALTH} />,
      );

      const notice = await screen.findByTestId('settings-notice-engine-gpu-unused');
      expect(notice).toHaveTextContent('is not using your graphics card');
      expect(notice).toHaveTextContent('driver version is insufficient');
    });

    it('keeps count of the times Linux ran out of memory', async () => {
      vi.mocked(api.getLlamaCppBackendHealth).mockResolvedValue({
        outOfMemory: {
          count: 1,
          at: '2026-10-17T10:00:00.000Z',
          model: 'qwen3.6-27b-q8',
          whileStarting: false,
        },
      });
      render(
        <LlamaCppSettings config={BASE_CONFIG} onConfigChanged={vi.fn()} health={BASE_HEALTH} />,
      );

      const notice = await screen.findByTestId('settings-notice-engine-out-of-memory');
      expect(notice).toHaveTextContent('Linux stopped the engine once');
      expect(notice).toHaveTextContent('while running qwen3.6-27b-q8');
    });

    it('stays quiet for an external engine this machine does not launch', async () => {
      vi.mocked(api.getLlamaCppBackendHealth).mockResolvedValue({
        running: 'cuda',
        gpuUnused: { backend: 'cuda', reason: 'not-loaded', at: '2026-10-17T10:00:00.000Z' },
      });
      render(
        <LlamaCppSettings
          config={{ ...BASE_CONFIG, llamaCppBaseUrl: 'http://10.0.0.1:8080' } as ConfigResponse}
          onConfigChanged={vi.fn()}
          health={BASE_HEALTH}
        />,
      );

      await waitFor(() => expect(api.getLlamaCppBackendHealth).toHaveBeenCalled());
      await screen.findByRole('option', { name: /First local model/ });
      expect(screen.queryByTestId('settings-notice-engine-gpu-unused')).not.toBeInTheDocument();
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
  it('defaults draft sampling to greedy and explains the experimental alternative', async () => {
    render(
      <LlamaCppSettings config={BASE_CONFIG} onConfigChanged={vi.fn()} health={BASE_HEALTH} />,
    );
    await openAdvanced();
    expect(screen.getByRole('combobox', { name: 'Draft sampling' })).toHaveValue('greedy');
    expect(screen.getByText(/Probabilistic mode can improve speed/)).toBeInTheDocument();
  });

  it('persists probabilistic draft sampling', async () => {
    const onConfigChanged = vi.fn();
    render(
      <LlamaCppSettings
        config={BASE_CONFIG}
        onConfigChanged={onConfigChanged}
        health={BASE_HEALTH}
      />,
    );
    await openAdvanced();
    fireEvent.change(screen.getByRole('combobox', { name: 'Draft sampling' }), {
      target: { value: 'probabilistic' },
    });
    await waitFor(() => {
      expect(api.updateConfig).toHaveBeenCalledWith({ llamaCppSpecDraftSampling: 'probabilistic' });
      expect(onConfigChanged).toHaveBeenCalledWith(
        expect.objectContaining({ llamaCppSpecDraftSampling: 'probabilistic' }),
      );
    });
  });

  it('clears the draft-sampling override when returning to greedy', async () => {
    render(
      <LlamaCppSettings
        config={{ ...BASE_CONFIG, llamaCppSpecDraftSampling: 'probabilistic' }}
        onConfigChanged={vi.fn()}
        health={BASE_HEALTH}
      />,
    );
    await openAdvanced();
    expect(screen.getByRole('combobox', { name: 'Draft sampling' })).toHaveValue('probabilistic');
    fireEvent.change(screen.getByRole('combobox', { name: 'Draft sampling' }), {
      target: { value: 'greedy' },
    });
    await waitFor(() => {
      expect(api.updateConfig).toHaveBeenCalledWith({ llamaCppSpecDraftSampling: null });
    });
  });

  // The SWA cache control is a tri-state select (Auto / On / Off). Auto keeps
  // the memory-efficient cache unless the model's catalog entry pins the full one.
  const findSwaSelect = () =>
    (screen.getAllByRole('combobox') as HTMLSelectElement[]).find((s) =>
      within(s).queryByText(/windowed unless the model asks for full/),
    )!;

  it('explains that Auto keeps the windowed cache', async () => {
    render(
      <LlamaCppSettings config={BASE_CONFIG} onConfigChanged={vi.fn()} health={BASE_HEALTH} />,
    );
    await openAdvanced();
    expect(findSwaSelect()).toHaveValue('auto');
    expect(screen.getByText(/replies usually come more slowly/)).toBeInTheDocument();
  });

  it('setting the full SWA cache to On saves llamaCppSwaFull: true', async () => {
    render(
      <LlamaCppSettings config={BASE_CONFIG} onConfigChanged={vi.fn()} health={BASE_HEALTH} />,
    );
    await openAdvanced();
    await waitFor(() => {
      expect(screen.getByText(/Full SWA cache/)).toBeInTheDocument();
    });

    fireEvent.change(findSwaSelect(), { target: { value: 'on' } });

    await waitFor(() => {
      expect(api.updateConfig).toHaveBeenCalledWith({ llamaCppSwaFull: true });
    });
  });

  it('setting the full SWA cache to Off saves llamaCppSwaFull: false', async () => {
    render(
      <LlamaCppSettings config={BASE_CONFIG} onConfigChanged={vi.fn()} health={BASE_HEALTH} />,
    );
    await openAdvanced();
    await waitFor(() => {
      expect(screen.getByText(/Full SWA cache/)).toBeInTheDocument();
    });

    fireEvent.change(findSwaSelect(), { target: { value: 'off' } });

    await waitFor(() => {
      expect(api.updateConfig).toHaveBeenCalledWith({ llamaCppSwaFull: false });
    });
  });

  it('setting the full SWA cache to Auto clears the override (sends null)', async () => {
    render(
      <LlamaCppSettings
        config={{ ...BASE_CONFIG, llamaCppSwaFull: true } as ConfigResponse}
        onConfigChanged={vi.fn()}
        health={BASE_HEALTH}
      />,
    );
    await openAdvanced();
    await waitFor(() => {
      expect(screen.getByText(/Full SWA cache/)).toBeInTheDocument();
    });

    fireEvent.change(findSwaSelect(), { target: { value: 'auto' } });

    await waitFor(() => {
      expect(api.updateConfig).toHaveBeenCalledWith({ llamaCppSwaFull: null });
    });
  });
});
