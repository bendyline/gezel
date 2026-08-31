import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));

vi.mock('../components/ImageModelManager.js', () => ({
  ImageModelManager: ({
    disabledReason,
    configuredDefaultModelId,
    onSetActiveModel,
  }: {
    disabledReason?: string;
    configuredDefaultModelId?: string;
    onSetActiveModel?: (id: string) => void;
  }) => (
    <div
      data-testid="image-model-manager"
      data-disabled-reason={disabledReason ?? ''}
      data-configured-default={configuredDefaultModelId ?? ''}
    >
      <button type="button" onClick={() => onSetActiveModel?.('krea-2-turbo-q4')}>
        pick krea
      </button>
    </div>
  ),
}));
vi.mock('../components/ImageGeneratorGezelHint.js', () => ({
  ImageGeneratorGezelHint: () => <div data-testid="gezel-hint">hint</div>,
}));

const { ImageEngineSettings } = await import('./ImageEngineSettings.js');
const { api } = await import('../api.js');

describe('ImageEngineSettings', () => {
  beforeEach(() => {
    vi.mocked(api.getImageEngineStatus).mockResolvedValue({
      engine: { status: 'ok', kind: 'local', baseUrl: 'http://127.0.0.1:9100' },
      modelCount: 2,
    } as never);
    vi.mocked(api.getConfig).mockResolvedValue({
      provider: 'llama-cpp',
      imageProvider: 'sd-cpp',
    } as never);
    vi.mocked(api.updateConfig).mockImplementation(
      async (patch) => ({ provider: 'llama-cpp', imageProvider: 'sd-cpp', ...patch }) as never,
    );
  });

  it('patches only the sd-cpp slot, keeping a configured cloud default', async () => {
    vi.mocked(api.getConfig).mockResolvedValue({
      provider: 'llama-cpp',
      imageProvider: 'sd-cpp',
      defaultImageModel: { openai: 'gpt-image-2', 'sd-cpp': 'flux-2-klein-4b-q4' },
    } as never);

    render(<ImageEngineSettings />);

    await waitFor(() => {
      expect(screen.getByTestId('image-model-manager')).toHaveAttribute(
        'data-configured-default',
        'flux-2-klein-4b-q4',
      );
    });

    await userEvent.click(screen.getByRole('button', { name: 'pick krea' }));

    await waitFor(() => {
      expect(api.updateConfig).toHaveBeenCalledWith({
        defaultImageModel: { openai: 'gpt-image-2', 'sd-cpp': 'krea-2-turbo-q4' },
      });
    });
  });

  it('renders Ready status and the local engine description', async () => {
    render(<ImageEngineSettings />);
    await waitFor(() => {
      expect(screen.getByText('Ready')).toBeInTheDocument();
    });
    expect(screen.getByText(/Generate images locally/)).toBeInTheDocument();
    expect(screen.getByTestId('image-model-manager')).toBeInTheDocument();
  });

  it('renders "No local models" when modelCount is 0', async () => {
    vi.mocked(api.getImageEngineStatus).mockResolvedValue({
      engine: { status: 'ok', kind: 'local', baseUrl: 'http://127.0.0.1:9100' },
      modelCount: 0,
    } as never);
    render(<ImageEngineSettings />);
    await waitFor(() => {
      expect(screen.getByText('No local models')).toBeInTheDocument();
    });
  });

  it('renders engine-not-configured guidance when sd-server is missing', async () => {
    vi.mocked(api.getImageEngineStatus).mockResolvedValue({
      engine: { status: 'not-configured' },
      modelCount: 0,
    } as never);
    render(<ImageEngineSettings />);
    await waitFor(() => {
      expect(screen.getByText(/image engine isn't wired up/)).toBeInTheDocument();
    });
    const mgr = screen.getByTestId('image-model-manager');
    expect(mgr.getAttribute('data-disabled-reason')).toMatch(/not configured/i);
  });

  it('switching the engine to google-ai persists imageProvider via updateConfig', async () => {
    render(<ImageEngineSettings />);
    await waitFor(() => {
      expect(screen.getByText('Ready')).toBeInTheDocument();
    });

    const engineSelect = screen.getByRole('combobox') as HTMLSelectElement;
    fireEvent.change(engineSelect, { target: { value: 'google-ai' } });

    await waitFor(() => {
      expect(api.updateConfig).toHaveBeenCalledWith({ imageProvider: 'google-ai' });
    });
  });

  it('with a cloud provider, saving an API key sends the right credential field', async () => {
    vi.mocked(api.getConfig).mockResolvedValue({
      provider: 'llama-cpp',
      imageProvider: 'google-ai',
    } as never);
    vi.mocked(api.getImageEngineStatus).mockResolvedValue({
      engine: { status: 'not-configured', kind: 'cloud' },
      modelCount: 0,
    } as never);
    render(<ImageEngineSettings />);
    await waitFor(() => {
      expect(screen.getByPlaceholderText('AIza…')).toBeInTheDocument();
    });

    const user = userEvent.setup();
    const keyInput = screen.getByPlaceholderText('AIza…') as HTMLInputElement;
    await user.type(keyInput, 'AIzaABCDEF');
    await user.click(screen.getByRole('button', { name: /^Save$/ }));

    await waitFor(() => {
      expect(api.updateConfig).toHaveBeenCalledWith({ googleAiApiKey: 'AIzaABCDEF' });
    });
  });

  it('with openai provider, saving an API key uses openaiApiKey', async () => {
    vi.mocked(api.getConfig).mockResolvedValue({
      provider: 'llama-cpp',
      imageProvider: 'openai',
    } as never);
    render(<ImageEngineSettings />);
    await waitFor(() => {
      expect(screen.getByPlaceholderText('sk-…')).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText('sk-…'), 'sk-XYZ');
    await user.click(screen.getByRole('button', { name: /^Save$/ }));

    await waitFor(() => {
      expect(api.updateConfig).toHaveBeenCalledWith({ openaiApiKey: 'sk-XYZ' });
    });
  });

  it('with a saved cloud key, Clear button sends an empty string', async () => {
    vi.mocked(api.getConfig).mockResolvedValue({
      provider: 'llama-cpp',
      imageProvider: 'google-ai',
      hasGoogleAiApiKey: true,
      googleAiApiKey: 'AIza••••',
    } as never);
    render(<ImageEngineSettings />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^Clear$/ })).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /^Clear$/ }));

    await waitFor(() => {
      expect(api.updateConfig).toHaveBeenCalledWith({ googleAiApiKey: '' });
    });
  });

  it('cost-confirmation radios update the imageGenerationConfirmation setting', async () => {
    vi.mocked(api.getConfig).mockResolvedValue({
      provider: 'llama-cpp',
      imageProvider: 'google-ai',
    } as never);
    render(<ImageEngineSettings />);
    await waitFor(() => {
      expect(screen.getByText(/Cost confirmation/)).toBeInTheDocument();
    });

    const alwaysRadio = screen.getByLabelText(/Always allow without asking/) as HTMLInputElement;
    const user = userEvent.setup();
    await user.click(alwaysRadio);

    await waitFor(() => {
      expect(api.updateConfig).toHaveBeenCalledWith({
        imageGenerationConfirmation: 'always-allow',
      });
    });
  });

  it('shows "Service unreachable" pill when getImageEngineStatus rejects', async () => {
    vi.mocked(api.getImageEngineStatus).mockRejectedValue(new Error('econn-refused'));
    render(<ImageEngineSettings />);
    await waitFor(() => {
      expect(screen.getByText('Service unreachable')).toBeInTheDocument();
    });
    expect(screen.getByText(/econn-refused/)).toBeInTheDocument();
  });
});
