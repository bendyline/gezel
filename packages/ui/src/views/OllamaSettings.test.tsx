import type { ConfigResponse } from '@bendyline/gezel-client';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));

vi.mock('../components/OllamaModelManager.js', () => ({
  OllamaModelManager: ({ enabled }: { enabled: boolean }) => (
    <div data-testid="ollama-manager" data-enabled={String(enabled)}>
      mock-ollama-manager
    </div>
  ),
}));

const { OllamaSettings } = await import('./OllamaSettings.js');
const { api } = await import('../api.js');

const BASE_CONFIG = {
  provider: 'ollama',
  ollamaBaseUrl: 'http://localhost:11434',
} as ConfigResponse;

describe('OllamaSettings', () => {
  beforeEach(() => {
    vi.mocked(api.ollamaStatus).mockResolvedValue({
      ok: true,
      baseUrl: 'http://localhost:11434',
      modelCount: 3,
    } as never);
    vi.mocked(api.ollamaStart).mockResolvedValue({ started: true } as never);
    vi.mocked(api.updateConfig).mockImplementation(
      async (patch) =>
        ({
          ...BASE_CONFIG,
          ...patch,
        }) as ConfigResponse,
    );
  });

  it('renders the reachable status with model count when ollamaStatus is ok', async () => {
    render(<OllamaSettings config={BASE_CONFIG} onConfigChanged={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText(/Reachable at/)).toBeInTheDocument();
    });
    expect(screen.getByText(/3 models available locally/)).toBeInTheDocument();
    expect(screen.getByTestId('ollama-manager').getAttribute('data-enabled')).toBe('true');
  });

  it('renders the failure path with a Start Ollama button when probe fails', async () => {
    vi.mocked(api.ollamaStatus).mockResolvedValue({
      ok: false,
      baseUrl: 'http://localhost:11434',
      error: 'connection refused',
    } as never);
    // Auto-start path: refreshStatus tries ollamaStart on fail. Make it
    // return started=false so we stay in the fail state.
    vi.mocked(api.ollamaStart).mockResolvedValue({ started: false } as never);

    render(<OllamaSettings config={BASE_CONFIG} onConfigChanged={vi.fn()} />);

    await waitFor(() => {
      const failLine = screen.getByTitle('connection refused');
      expect(failLine).toHaveTextContent(/Ollama isn't running at/);
    });
    expect(screen.getByRole('button', { name: /Start Ollama/i })).toBeInTheDocument();
    expect(screen.getByTestId('ollama-manager').getAttribute('data-enabled')).toBe('false');
  });

  it('saves a new base URL via updateConfig and re-probes', async () => {
    const onConfigChanged = vi.fn();
    render(<OllamaSettings config={BASE_CONFIG} onConfigChanged={onConfigChanged} />);
    await waitFor(() => {
      expect(api.ollamaStatus).toHaveBeenCalled();
    });
    vi.mocked(api.ollamaStatus).mockClear();

    const user = userEvent.setup();
    const urlInput = screen.getByPlaceholderText('http://localhost:11434') as HTMLInputElement;
    await user.clear(urlInput);
    await user.type(urlInput, 'http://10.0.0.5:11434');

    // The base-URL Save button is the only one enabled at this point
    // (other Save buttons sit on rows whose drafts still match config).
    const saveButtons = screen.getAllByRole('button', { name: /^Save$/ });
    const enabledSave = saveButtons.find((b) => !(b as HTMLButtonElement).disabled);
    await user.click(enabledSave as HTMLElement);

    await waitFor(() => {
      expect(api.updateConfig).toHaveBeenCalledWith({
        ollamaBaseUrl: 'http://10.0.0.5:11434',
      });
    });
    expect(onConfigChanged).toHaveBeenCalled();
    await waitFor(() => {
      expect(api.ollamaStatus).toHaveBeenCalled();
    });
  });

  it('toggling auto-start checkbox updates config', async () => {
    const onConfigChanged = vi.fn();
    render(<OllamaSettings config={BASE_CONFIG} onConfigChanged={onConfigChanged} />);
    await waitFor(() => {
      expect(api.ollamaStatus).toHaveBeenCalled();
    });

    const checkbox = screen.getByRole('checkbox') as HTMLInputElement;
    expect(checkbox.checked).toBe(true); // default
    const user = userEvent.setup();
    await user.click(checkbox);

    await waitFor(() => {
      expect(api.updateConfig).toHaveBeenCalledWith({ autoStartOllama: false });
    });
  });

  it('Save button stays disabled while the draft equals the persisted value', async () => {
    render(<OllamaSettings config={BASE_CONFIG} onConfigChanged={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByPlaceholderText('http://localhost:11434')).toBeInTheDocument();
    });

    const saveBtn = screen.getAllByRole('button', { name: /^Save$/ })[0] as HTMLButtonElement;
    expect(saveBtn).toBeDisabled();
  });

  it('saving num_ctx parses the value to an integer', async () => {
    const onConfigChanged = vi.fn();
    render(<OllamaSettings config={BASE_CONFIG} onConfigChanged={onConfigChanged} />);
    await waitFor(() => {
      expect(api.ollamaStatus).toHaveBeenCalled();
    });

    const ctxInput = screen.getByPlaceholderText('e.g. 8192') as HTMLInputElement;
    const user = userEvent.setup();
    await user.clear(ctxInput);
    await user.type(ctxInput, '16384');

    // Find the Save button right after the ctx input.
    const saveButtons = screen.getAllByRole('button', { name: /^Save$/ });
    // First one is base URL save (disabled at default), second is num_ctx.
    const ctxSave = saveButtons.find((b) => !(b as HTMLButtonElement).disabled);
    expect(ctxSave).toBeDefined();
    await user.click(ctxSave as HTMLElement);

    await waitFor(() => {
      expect(api.updateConfig).toHaveBeenCalledWith({ ollamaNumCtx: 16384 });
    });
  });

  it('clicking Start Ollama re-probes after a successful start', async () => {
    // Initial probe fails AND the auto-start path also fails (no
    // started=true in the chain), so the button is shown.
    vi.mocked(api.ollamaStatus).mockResolvedValue({
      ok: false,
      baseUrl: 'http://localhost:11434',
      error: 'down',
    } as never);
    vi.mocked(api.ollamaStart).mockResolvedValue({ started: false } as never);

    render(<OllamaSettings config={BASE_CONFIG} onConfigChanged={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Start Ollama/i })).toBeInTheDocument();
    });

    // Swap the start mock to succeed and make the next status probe ok,
    // then click Start.
    vi.mocked(api.ollamaStart).mockResolvedValue({ started: true } as never);
    vi.mocked(api.ollamaStatus).mockResolvedValue({
      ok: true,
      baseUrl: 'http://localhost:11434',
      modelCount: 1,
    } as never);

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Start Ollama/i }));

    await waitFor(() => {
      expect(screen.getByText(/Reachable at/)).toBeInTheDocument();
    });
  });
});
