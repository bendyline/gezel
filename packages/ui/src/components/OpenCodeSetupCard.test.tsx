import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { primitivesMock } from '../test-utils/primitivesMock.js';

const getOpenCodeSetupStatus = vi.fn();
const configureOpenCode = vi.fn();
const removeOpenCodeSetup = vi.fn();
const installOpenCodePlugin = vi.fn();
const removeOpenCodePlugin = vi.fn();
const writeClipboard = vi.fn();

vi.mock('../api.js', () => ({
  api: {
    getOpenCodeSetupStatus,
    configureOpenCode,
    removeOpenCodeSetup,
    installOpenCodePlugin,
    removeOpenCodePlugin,
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

const { OpenCodeSetupCard } = await import('./OpenCodeSetupCard.js');

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
];

const CONFIG_PATH = '/Users/test/.gezel/integrations/opencode/opencode.json';
const PLUGIN_PATH = '/Users/test/.config/opencode/plugins/gezel.js';

type PluginState = 'not-installed' | 'installed' | 'stale' | 'conflict' | 'unsupported';

function pluginStatus(state: PluginState = 'not-installed') {
  return {
    state,
    path: PLUGIN_PATH,
    canInstall: state === 'not-installed' || state === 'stale',
    canRemove: state === 'installed' || state === 'stale',
    canReplace: state === 'conflict',
    ...(state === 'conflict'
      ? { message: `${PLUGIN_PATH} was written by another Gezel installation or changed by hand.` }
      : {}),
  };
}

function setupStatus(
  overrides: Partial<{
    state: 'not-configured' | 'configured' | 'update-needed' | 'conflict' | 'unavailable';
    models: typeof MODELS;
    configuredModel: string;
    recommendedModel: string;
    reasons: string[];
    message: string;
    opencodeInstalled: boolean;
    opencodeVersion: string;
    endpointsEnabled: boolean;
    launchCommand: string;
    canConfigure: boolean;
    canRemove: boolean;
    canRepair: boolean;
    configBackupPath: string;
    plugin: ReturnType<typeof pluginStatus>;
    pluginBackupPath: string;
  }> = {},
) {
  return {
    state: 'not-configured' as const,
    plugin: pluginStatus(),
    models: MODELS,
    recommendedModel: MODELS[0]!.id,
    reasons: [],
    opencodeInstalled: true,
    opencodeVersion: '1.2.3',
    endpointsEnabled: true,
    providerId: 'gezel',
    configPath: CONFIG_PATH,
    launchCommand: `OPENCODE_CONFIG=${CONFIG_PATH} opencode`,
    bridge: { baseUrl: 'http://127.0.0.1:21435/v1', listening: true, port: 21435 },
    canConfigure: true,
    canRemove:
      overrides.canRemove ??
      ['configured', 'update-needed', 'conflict'].includes(overrides.state ?? 'not-configured'),
    canRepair: false,
    ...overrides,
  };
}

describe('OpenCodeSetupCard', () => {
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
    getOpenCodeSetupStatus.mockResolvedValue(setupStatus());
    configureOpenCode.mockResolvedValue(
      setupStatus({ state: 'configured', configuredModel: MODELS[1]!.id }),
    );
    const onChanged = vi.fn();

    render(<OpenCodeSetupCard endpointsEnabled onChanged={onChanged} />);

    expect(await screen.findByText('Not configured')).toBeInTheDocument();
    fireEvent.change(screen.getByTestId('mock-select'), { target: { value: MODELS[1]!.id } });
    fireEvent.click(screen.getByRole('button', { name: 'Set up OpenCode…' }));
    expect(configureOpenCode).not.toHaveBeenCalled();

    const dialog = screen.getByRole('alertdialog', { name: 'Set up OpenCode with Gezel?' });
    expect(within(dialog).getByText(/Theo/)).toBeInTheDocument();
    expect(within(dialog).getByText(/character, Qwen 3 14B, and tuning/)).toBeInTheDocument();
    // The promise the card makes about the user's own config must be on the
    // confirmation, not only in the intro paragraph.
    expect(within(dialog).getByText(/own OpenCode configuration/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Set up OpenCode' }));

    await waitFor(() => {
      expect(configureOpenCode).toHaveBeenCalledWith({ model: MODELS[1]!.id });
      expect(onChanged).toHaveBeenCalledOnce();
    });
    expect(await screen.findByText('Configured')).toBeInTheDocument();
  });

  it('groups gezels first while retaining raw models as a fallback', async () => {
    getOpenCodeSetupStatus.mockResolvedValue(setupStatus());

    render(<OpenCodeSetupCard endpointsEnabled />);

    const select = await screen.findByTestId('mock-select');
    expect(select).toHaveValue('gezel:maya-id');
    expect(
      within(select)
        .getAllByRole('option')
        .map((option) => option.getAttribute('value')),
    ).toEqual(['gezel:maya-id', 'gezel:theo-id', 'llama-cpp:qwen3-8b']);
  });

  it('shows the launch command with the managed config path and copies it', async () => {
    getOpenCodeSetupStatus.mockResolvedValue(
      setupStatus({ state: 'configured', configuredModel: MODELS[0]!.id }),
    );

    render(<OpenCodeSetupCard endpointsEnabled />);

    expect(await screen.findByText(`OPENCODE_CONFIG=${CONFIG_PATH} opencode`)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Copy command' }));

    await waitFor(() => {
      expect(writeClipboard).toHaveBeenCalledWith(`OPENCODE_CONFIG=${CONFIG_PATH} opencode`);
    });
  });

  it('offers repair on a conflict and passes the backup flag', async () => {
    getOpenCodeSetupStatus.mockResolvedValue(
      setupStatus({
        state: 'conflict',
        canRepair: true,
        message: 'It was changed outside this setup.',
      }),
    );
    configureOpenCode.mockResolvedValue(
      setupStatus({
        state: 'configured',
        configuredModel: MODELS[0]!.id,
        configBackupPath: `${CONFIG_PATH}.backup`,
      }),
    );

    render(<OpenCodeSetupCard endpointsEnabled />);

    expect(await screen.findByText('Needs attention')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Repair OpenCode setup…' }));
    fireEvent.click(
      within(screen.getByRole('alertdialog', { name: 'Repair the OpenCode setup?' })).getByRole(
        'button',
        { name: 'Repair setup' },
      ),
    );

    await waitFor(() => {
      expect(configureOpenCode).toHaveBeenCalledWith({
        model: MODELS[0]!.id,
        backupConflictingConfig: true,
      });
    });
    expect(
      await screen.findByText(`The previous file was saved as ${CONFIG_PATH}.backup.`),
    ).toBeInTheDocument();
  });

  it('shows an update failure inline beside the card', async () => {
    getOpenCodeSetupStatus.mockResolvedValue(
      setupStatus({
        state: 'update-needed',
        configuredModel: MODELS[0]!.id,
        reasons: ['The OpenCode inference bridge is not running.'],
      }),
    );
    configureOpenCode.mockRejectedValue({ details: { message: 'opencode.json is read-only' } });

    render(<OpenCodeSetupCard endpointsEnabled />);

    expect(await screen.findByText('Update needed')).toBeInTheDocument();
    expect(screen.getByText('The OpenCode inference bridge is not running.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Update OpenCode…' }));
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Update OpenCode' }),
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not update the OpenCode setup — opencode.json is read-only',
    );
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('blocks configuration while connected-app serving is off', async () => {
    getOpenCodeSetupStatus.mockResolvedValue(setupStatus());

    render(<OpenCodeSetupCard endpointsEnabled={false} />);

    expect(await screen.findByText(/Allow apps to connect/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Set up OpenCode…' })).toBeDisabled();
  });

  it('lets the user prepare the setup before OpenCode is installed', async () => {
    getOpenCodeSetupStatus.mockResolvedValue(setupStatus({ opencodeInstalled: false }));

    render(<OpenCodeSetupCard endpointsEnabled />);

    expect(await screen.findByText(/OpenCode was not found on this computer/)).toBeInTheDocument();
    // No version floor to enforce, so preparing ahead of install stays allowed.
    expect(screen.getByRole('button', { name: 'Set up OpenCode…' })).toBeEnabled();
  });

  it('adds the plugin only after confirming what lands in the user’s OpenCode', async () => {
    getOpenCodeSetupStatus.mockResolvedValue(
      setupStatus({ state: 'configured', configuredModel: MODELS[0]!.id }),
    );
    installOpenCodePlugin.mockResolvedValue(
      setupStatus({
        state: 'configured',
        configuredModel: MODELS[0]!.id,
        plugin: pluginStatus('installed'),
      }),
    );

    render(<OpenCodeSetupCard endpointsEnabled />);

    fireEvent.click(await screen.findByRole('button', { name: 'Add to OpenCode…' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Add Gezel to OpenCode?' });
    expect(dialog).toHaveTextContent(PLUGIN_PATH);
    // The promise that survives this feature is add-not-edit; keep it on the
    // confirmation, where the decision is actually made.
    expect(dialog).toHaveTextContent(/holds no password/);
    expect(dialog).toHaveTextContent(
      /own OpenCode configuration, sessions, and permissions stay untouched/,
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add to OpenCode' }));

    await waitFor(() => expect(installOpenCodePlugin).toHaveBeenCalledOnce());
    expect(installOpenCodePlugin).toHaveBeenCalledWith();
    expect(await screen.findByText(new RegExp(PLUGIN_PATH))).toBeInTheDocument();
  });

  it('removes the plugin behind its own confirmation', async () => {
    getOpenCodeSetupStatus.mockResolvedValue(
      setupStatus({
        state: 'configured',
        configuredModel: MODELS[0]!.id,
        plugin: pluginStatus('installed'),
      }),
    );
    removeOpenCodePlugin.mockResolvedValue(
      setupStatus({ state: 'configured', configuredModel: MODELS[0]!.id }),
    );

    render(<OpenCodeSetupCard endpointsEnabled />);

    fireEvent.click(await screen.findByRole('button', { name: 'Remove from OpenCode…' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Remove Gezel from OpenCode?' });
    expect(dialog).toHaveTextContent(PLUGIN_PATH);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove from OpenCode' }));

    await waitFor(() => expect(removeOpenCodePlugin).toHaveBeenCalledOnce());
    expect(removeOpenCodeSetup).not.toHaveBeenCalled();
  });

  it('never overwrites a plugin file it does not own', async () => {
    getOpenCodeSetupStatus.mockResolvedValue(
      setupStatus({
        state: 'configured',
        configuredModel: MODELS[0]!.id,
        plugin: pluginStatus('conflict'),
      }),
    );
    installOpenCodePlugin.mockResolvedValue(
      setupStatus({
        state: 'configured',
        configuredModel: MODELS[0]!.id,
        plugin: pluginStatus('installed'),
        pluginBackupPath: `${PLUGIN_PATH}.backup`,
      }),
    );

    render(<OpenCodeSetupCard endpointsEnabled />);

    expect(await screen.findByText(/written by another Gezel installation/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add to OpenCode…' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Replace OpenCode plugin…' }));
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Replace plugin' }),
    );

    await waitFor(() =>
      expect(installOpenCodePlugin).toHaveBeenCalledWith({ backupConflictingPlugin: true }),
    );
    expect(await screen.findByText(/saved as .*\.backup/)).toBeInTheDocument();
  });

  it('hides the plugin action when OpenCode cannot host it', async () => {
    getOpenCodeSetupStatus.mockResolvedValue(
      setupStatus({
        state: 'configured',
        configuredModel: MODELS[0]!.id,
        plugin: pluginStatus('unsupported'),
      }),
    );

    render(<OpenCodeSetupCard endpointsEnabled />);

    expect(await screen.findByText('Configured')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add to OpenCode…' })).not.toBeInTheDocument();
  });
});
