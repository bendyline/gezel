import type { ConfigResponse } from '@bendyline/gezel-client';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));

vi.mock('../components/MlxModelManager.js', () => ({
  MlxModelManager: () => <div data-testid="mlx-manager">mock-mlx-manager</div>,
}));
vi.mock('../components/EngineBudgetStrip.js', () => ({
  EngineBudgetStrip: () => <div data-testid="engine-memory">mock-engine-memory</div>,
}));
vi.mock('../components/CacheControlsPanel.js', () => ({
  CacheControlsPanel: ({ providerName }: { providerName: string }) => (
    <div data-testid={`cache-${providerName}`}>cache-{providerName}</div>
  ),
}));

const { MlxSettings } = await import('./MlxSettings.js');
const { api } = await import('../api.js');

const BASE_CONFIG = {
  provider: 'mlx',
} as ConfigResponse;

const INSTALLED_MODELS = {
  models: [
    { id: 'gemma4-12b-q4', name: 'Gemma 4 (12B)' },
    { id: 'qwen3.6-27b-q8', name: 'Qwen 3.6 (27B)' },
  ],
} as Awaited<ReturnType<typeof api.listMlxModels>>;

describe('MlxSettings', () => {
  beforeEach(() => {
    vi.mocked(api.listMlxModels).mockResolvedValue(INSTALLED_MODELS);
    vi.mocked(api.getMlxRuntime).mockResolvedValue({
      source: 'system',
      uvVersion: '0.5.0',
      pythonVersion: '3.11.7',
    } as never);
    vi.mocked(api.resetMlxRuntime).mockResolvedValue({ ok: true } as never);
    vi.mocked(api.updateConfig).mockImplementation(
      async (patch) => ({ ...BASE_CONFIG, ...patch }) as ConfigResponse,
    );
  });

  it('renders the runtime info from getMlxRuntime', async () => {
    render(<MlxSettings config={BASE_CONFIG} onConfigChanged={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText(/Source:/)).toBeInTheDocument();
    });
    expect(screen.getByText('system')).toBeInTheDocument();
    expect(screen.getByText('0.5.0')).toBeInTheDocument();
    expect(screen.getByText('3.11.7')).toBeInTheDocument();
  });

  it('shows model management before engine memory management', () => {
    render(<MlxSettings config={BASE_CONFIG} onConfigChanged={vi.fn()} />);

    const models = screen.getByTestId('mlx-manager');
    const memory = screen.getByTestId('engine-memory');
    expect(models.compareDocumentPosition(memory) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it('shows the default-model dropdown above model management', async () => {
    render(<MlxSettings config={BASE_CONFIG} onConfigChanged={vi.fn()} />);

    const defaultModel = await screen.findByRole('heading', { name: 'Default model' });
    expect(screen.getByRole('option', { name: 'First local model' })).toBeInTheDocument();
    expect(
      screen.getByRole('option', { name: 'Gemma 4 (12B) (gemma4-12b-q4)' }),
    ).toBeInTheDocument();

    const models = screen.getByTestId('mlx-manager');
    expect(defaultModel.compareDocumentPosition(models) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it('selecting a default model patches config.defaultModel.mlx', async () => {
    const onConfigChanged = vi.fn();
    render(
      <MlxSettings
        config={{ ...BASE_CONFIG, defaultModel: { openai: 'gpt-day' } } as ConfigResponse}
        onConfigChanged={onConfigChanged}
      />,
    );

    const picker = await screen.findByRole('combobox', { name: 'Default model' });
    await userEvent.selectOptions(picker, 'qwen3.6-27b-q8');

    await waitFor(() => {
      expect(api.updateConfig).toHaveBeenCalledWith({
        defaultModel: { openai: 'gpt-day', mlx: 'qwen3.6-27b-q8' },
      });
    });
    expect(onConfigChanged).toHaveBeenCalled();
  });

  it('shows "No Python runtime available" when the runtime info has source=null', async () => {
    vi.mocked(api.getMlxRuntime).mockResolvedValue({
      source: null,
      reason: 'uv not bundled, no system Python',
    } as never);
    render(<MlxSettings config={BASE_CONFIG} onConfigChanged={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText(/No Python runtime available/)).toBeInTheDocument();
    });
    expect(screen.getByText(/uv not bundled/)).toBeInTheDocument();
  });

  it('renders the "external engine" pill when mlxBaseUrl is set', async () => {
    render(
      <MlxSettings
        config={{ ...BASE_CONFIG, mlxBaseUrl: 'http://127.0.0.1:8000' } as ConfigResponse}
        onConfigChanged={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText(/using external engine/)).toBeInTheDocument();
    });
  });

  it('saving the base URL calls updateConfig and propagates via onConfigChanged', async () => {
    const onConfigChanged = vi.fn();
    render(<MlxSettings config={BASE_CONFIG} onConfigChanged={onConfigChanged} />);
    await waitFor(() => {
      expect(api.getMlxRuntime).toHaveBeenCalled();
    });

    const user = userEvent.setup();
    const baseUrlInput = screen.getByPlaceholderText(
      /e\.g\. http:\/\/127\.0\.0\.1:8000/,
    ) as HTMLInputElement;
    await user.type(baseUrlInput, 'http://127.0.0.1:9000');

    // Three Save buttons in advanced (URL, model path, package spec); only
    // the URL one should be enabled now.
    const enabledSave = screen
      .getAllByRole('button', { name: /^Save$/ })
      .find((b) => !(b as HTMLButtonElement).disabled);
    await user.click(enabledSave as HTMLElement);

    await waitFor(() => {
      expect(api.updateConfig).toHaveBeenCalledWith({ mlxBaseUrl: 'http://127.0.0.1:9000' });
    });
    expect(onConfigChanged).toHaveBeenCalled();
  });

  it('reset venv calls resetMlxRuntime and shows confirmation', async () => {
    render(<MlxSettings config={BASE_CONFIG} onConfigChanged={vi.fn()} />);
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /Reset gezel Python environment/ }),
      ).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Reset gezel Python environment/ }));

    await waitFor(() => {
      expect(api.resetMlxRuntime).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(screen.getByText(/venv was reset/)).toBeInTheDocument();
    });
  });

  it('reset venv surfaces an error when resetMlxRuntime rejects', async () => {
    vi.mocked(api.resetMlxRuntime).mockRejectedValue(new Error('uv not on PATH'));
    render(<MlxSettings config={BASE_CONFIG} onConfigChanged={vi.fn()} />);
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /Reset gezel Python environment/ }),
      ).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Reset gezel Python environment/ }));

    await waitFor(() => {
      expect(screen.getByText(/uv not on PATH/)).toBeInTheDocument();
    });
  });

  it('identifies the Apple MLX engine in its heading', async () => {
    render(<MlxSettings config={BASE_CONFIG} onConfigChanged={vi.fn()} />);

    expect(
      await screen.findByRole('heading', { name: 'This Mac (Apple MLX)' }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Show llama local device processing/)).not.toBeInTheDocument();
  });

  it('shows the engine as ready below the description', () => {
    render(<MlxSettings config={BASE_CONFIG} onConfigChanged={vi.fn()} />);

    expect(screen.getByText('Status:')).toBeInTheDocument();
    expect(screen.getByText('ready')).toHaveClass('gz-status-pill', 'gz-status-pill--ok');
  });

  it('renders the cache controls panel for mlx', async () => {
    render(<MlxSettings config={BASE_CONFIG} onConfigChanged={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByTestId('cache-mlx')).toBeInTheDocument();
    });
  });
});
