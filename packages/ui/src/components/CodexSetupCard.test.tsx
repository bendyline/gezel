import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { primitivesMock } from '../test-utils/primitivesMock.js';

const getCodexSetupStatus = vi.fn();
const configureCodex = vi.fn();
const removeCodexSetup = vi.fn();
const writeClipboard = vi.fn();

vi.mock('../api.js', () => ({
  api: {
    getCodexSetupStatus,
    configureCodex,
    removeCodexSetup,
  },
}));
vi.mock('../primitives/index.js', () => primitivesMock);
vi.mock('./ConfirmDialog.js', () => ({
  ConfirmDialog: ({
    open,
    title,
    message,
    confirmLabel,
    onConfirm,
    onCancel,
  }: {
    open: boolean;
    title: string;
    message?: React.ReactNode;
    confirmLabel?: string;
    onConfirm: () => void | Promise<void>;
    onCancel: () => void;
  }) =>
    open ? (
      <div role="alertdialog" aria-label={title}>
        <p>{message}</p>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" onClick={() => void onConfirm()}>
          {confirmLabel ?? 'Confirm'}
        </button>
      </div>
    ) : null,
}));

const { CodexSetupCard } = await import('./CodexSetupCard.js');

const MODELS = [
  {
    id: 'gezel:maya-id',
    label: 'Maya',
    description: 'Developer · Qwen 3 8B',
    kind: 'gezel' as const,
    provider: 'llama-cpp',
    gezelId: 'maya-id',
    role: 'Developer',
    modelLabel: 'Qwen 3 8B',
    supportsTools: true,
  },
  {
    id: 'gezel:theo-id',
    label: 'Theo',
    description: 'Reviewer · Qwen 3 14B',
    kind: 'gezel' as const,
    provider: 'mlx',
    gezelId: 'theo-id',
    role: 'Reviewer',
    modelLabel: 'Qwen 3 14B',
    supportsTools: true,
  },
  {
    id: 'llama-cpp:qwen3-8b',
    label: 'Qwen 3 8B',
    kind: 'model' as const,
    provider: 'llama-cpp',
    supportsTools: true,
  },
  {
    id: 'mlx:qwen3-14b',
    label: 'Qwen 3 14B',
    kind: 'model' as const,
    provider: 'mlx',
    supportsTools: true,
  },
];

function setupStatus(
  overrides: Partial<{
    state: 'not-configured' | 'configured' | 'update-needed' | 'conflict' | 'unavailable';
    models: typeof MODELS;
    configuredModel: string;
    recommendedModel: string;
    reasons: string[];
    message: string;
    codexInstalled: boolean;
    codexVersion: string;
    endpointsEnabled: boolean;
    launchCommand: string;
    canConfigure: boolean;
    canRemove: boolean;
  }> = {},
) {
  return {
    state: 'not-configured' as const,
    models: MODELS,
    recommendedModel: MODELS[0]!.id,
    reasons: [],
    codexInstalled: true,
    codexVersion: '0.147.0',
    endpointsEnabled: true,
    profileName: 'gezel',
    profilePath: '/Users/test/.codex/config.toml',
    launchCommand: 'codex --profile gezel',
    bridge: { baseUrl: 'https://127.0.0.1:6228/v1', listening: true, port: 6228 },
    canConfigure: true,
    canRemove:
      overrides.canRemove ??
      ['configured', 'update-needed', 'conflict'].includes(overrides.state ?? 'not-configured'),
    ...overrides,
  };
}

describe('CodexSetupCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.__GEZEL__ = { token: 'test-token', mode: 'local-adopt' };
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: writeClipboard },
    });
    writeClipboard.mockResolvedValue(undefined);
  });

  it('requires confirmation before configuring the selected gezel', async () => {
    getCodexSetupStatus.mockResolvedValue(setupStatus());
    configureCodex.mockResolvedValue(
      setupStatus({
        state: 'configured',
        configuredModel: MODELS[1]!.id,
      }),
    );
    const onChanged = vi.fn();

    render(<CodexSetupCard endpointsEnabled onChanged={onChanged} />);

    expect(await screen.findByText('Not configured')).toBeInTheDocument();
    fireEvent.change(screen.getByTestId('mock-select'), {
      target: { value: MODELS[1]!.id },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Set up Codex…' }));
    expect(configureCodex).not.toHaveBeenCalled();

    const dialog = screen.getByRole('alertdialog', { name: 'Set up Codex with Gezel?' });
    expect(within(dialog).getByText(/Theo/)).toBeInTheDocument();
    expect(within(dialog).getByText(/character, Qwen 3 14B, and tuning/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Set up Codex' }));

    await waitFor(() => {
      expect(configureCodex).toHaveBeenCalledWith({ model: MODELS[1]!.id });
      expect(onChanged).toHaveBeenCalledOnce();
    });
    expect(await screen.findByText('Configured')).toBeInTheDocument();
  });

  it('groups gezels first while retaining raw models as a fallback', async () => {
    getCodexSetupStatus.mockResolvedValue(setupStatus());

    render(<CodexSetupCard endpointsEnabled />);

    const select = await screen.findByTestId('mock-select');
    expect(select).toHaveValue('gezel:maya-id');
    expect(
      within(select)
        .getAllByRole('option')
        .map((option) => option.getAttribute('value')),
    ).toEqual(['gezel:maya-id', 'gezel:theo-id', 'llama-cpp:qwen3-8b', 'mlx:qwen3-14b']);
  });

  it('shows an update failure inline beside the card', async () => {
    getCodexSetupStatus.mockResolvedValue(
      setupStatus({
        state: 'update-needed',
        configuredModel: MODELS[0]!.id,
        reasons: ['The local connection address changed.'],
      }),
    );
    configureCodex.mockRejectedValue({ details: { message: 'config.toml is read-only' } });

    render(<CodexSetupCard endpointsEnabled />);

    expect(await screen.findByText('Update needed')).toBeInTheDocument();
    expect(screen.getByText('The local connection address changed.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Update Codex…' }));
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Update Codex' }),
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not update the Codex setup — config.toml is read-only',
    );
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('keeps removal available when endpoints are off and confirms its limited scope', async () => {
    getCodexSetupStatus.mockResolvedValue(
      setupStatus({
        state: 'configured',
        configuredModel: MODELS[0]!.id,
      }),
    );
    removeCodexSetup.mockResolvedValue(setupStatus());

    render(<CodexSetupCard endpointsEnabled={false} />);

    expect(await screen.findByText('Configured')).toBeInTheDocument();
    expect(screen.getByText('Allow apps to connect')).toBeInTheDocument();
    const remove = screen.getByRole('button', { name: 'Remove setup…' });
    expect(remove).toBeEnabled();
    fireEvent.click(remove);
    expect(removeCodexSetup).not.toHaveBeenCalled();

    const dialog = screen.getByRole('alertdialog', { name: 'Remove Gezel setup from Codex?' });
    expect(within(dialog).getByText(/does not uninstall Codex/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove setup' }));

    await waitFor(() => expect(removeCodexSetup).toHaveBeenCalledOnce());
  });

  it('copies the isolated-profile launch command', async () => {
    getCodexSetupStatus.mockResolvedValue(
      setupStatus({
        state: 'configured',
        configuredModel: MODELS[0]!.id,
        launchCommand: 'codex --profile gezel',
      }),
    );

    render(<CodexSetupCard endpointsEnabled />);

    fireEvent.click(await screen.findByRole('button', { name: 'Copy command' }));

    await waitFor(() => {
      expect(writeClipboard).toHaveBeenCalledWith('codex --profile gezel');
      expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument();
    });
  });

  it('disables one-click setup when the desktop is connected to a remote service', async () => {
    window.__GEZEL__ = { token: 'test-token', mode: 'remote' };
    getCodexSetupStatus.mockResolvedValue(setupStatus());

    render(<CodexSetupCard endpointsEnabled />);

    expect(await screen.findByText(/connected to a remote Gezel service/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Set up Codex…' })).toBeDisabled();
  });

  it('offers safe cleanup for damaged Gezel state while preserving unmanaged profiles', async () => {
    getCodexSetupStatus.mockResolvedValue(
      setupStatus({
        state: 'conflict',
        models: [],
        message: 'Gezel found damaged Codex setup state.',
        canConfigure: false,
        canRemove: true,
      }),
    );
    removeCodexSetup.mockResolvedValue(setupStatus());

    render(<CodexSetupCard endpointsEnabled />);

    fireEvent.click(await screen.findByRole('button', { name: 'Clear Gezel setup…' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Clear Gezel setup for Codex?' });
    expect(within(dialog).getByText(/not managed by Gezel will be preserved/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Clear Gezel setup' }));

    await waitFor(() => expect(removeCodexSetup).toHaveBeenCalledOnce());
  });

  it('hides the launch command until a local setup is healthy', async () => {
    getCodexSetupStatus.mockResolvedValue(
      setupStatus({
        state: 'update-needed',
        configuredModel: MODELS[0]!.id,
        reasons: ['The bridge is not running.'],
      }),
    );
    const first = render(<CodexSetupCard endpointsEnabled />);

    expect(await screen.findByText('Update needed')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy command' })).not.toBeInTheDocument();
    first.unmount();

    window.__GEZEL__ = { token: 'test-token', mode: 'remote' };
    getCodexSetupStatus.mockResolvedValue(
      setupStatus({ state: 'configured', configuredModel: MODELS[0]!.id }),
    );
    render(<CodexSetupCard endpointsEnabled />);

    expect(await screen.findByText(/connected to a remote Gezel service/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy command' })).not.toBeInTheDocument();
  });
});
