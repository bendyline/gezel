import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { primitivesMock } from '../test-utils/primitivesMock.js';

const getPiSetupStatus = vi.fn();
const configurePi = vi.fn();
const removePiSetup = vi.fn();
const installPiExtension = vi.fn();
const removePiExtension = vi.fn();
const writeClipboard = vi.fn();

vi.mock('../api.js', () => ({
  api: {
    getPiSetupStatus,
    configurePi,
    removePiSetup,
    installPiExtension,
    removePiExtension,
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

const { PiSetupCard } = await import('./PiSetupCard.js');

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

const CONFIG_PATH = '/Users/test/.gezel/integrations/pi/models.json';
const EXTENSION_PATH = '/Users/test/.pi/agent/extensions/gezel.js';
const OWNED_EXTENSION_PATH = '/Users/test/.gezel/integrations/pi/gezel.js';

type ExtensionState = 'not-installed' | 'installed' | 'stale' | 'conflict' | 'unsupported';

function extensionStatus(state: ExtensionState = 'not-installed') {
  return {
    state,
    path: EXTENSION_PATH,
    canInstall: state === 'not-installed' || state === 'stale',
    canRemove: state === 'installed' || state === 'stale',
    canReplace: state === 'conflict',
    agentDir: '/Users/test/.pi/agent',
    agentDirSource: 'override' as const,
    ...(state === 'conflict'
      ? {
          message: `${EXTENSION_PATH} was written by another Gezel installation or changed by hand.`,
        }
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
    piInstalled: boolean;
    piVersion: string;
    endpointsEnabled: boolean;
    launchCommand: string;
    canConfigure: boolean;
    canRemove: boolean;
    canRepair: boolean;
    configBackupPath: string;
    extension: ReturnType<typeof extensionStatus>;
    extensionBackupPath: string;
  }> = {},
) {
  return {
    state: 'not-configured' as const,
    extension: extensionStatus(),
    models: MODELS,
    recommendedModel: MODELS[0]!.id,
    reasons: [],
    piInstalled: true,
    piVersion: '1.2.3',
    endpointsEnabled: true,
    providerId: 'gezel',
    configPath: CONFIG_PATH,
    extensionPath: OWNED_EXTENSION_PATH,
    launchCommand: `pi -e ${OWNED_EXTENSION_PATH}`,
    bridge: { baseUrl: 'http://127.0.0.1:21435/v1', listening: true, port: 21435 },
    canConfigure: true,
    canRemove:
      overrides.canRemove ??
      ['configured', 'update-needed', 'conflict'].includes(overrides.state ?? 'not-configured'),
    canRepair: false,
    ...overrides,
  };
}

describe('PiSetupCard', () => {
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
    getPiSetupStatus.mockResolvedValue(setupStatus());
    configurePi.mockResolvedValue(
      setupStatus({ state: 'configured', configuredModel: MODELS[1]!.id }),
    );
    const onChanged = vi.fn();

    render(<PiSetupCard endpointsEnabled onChanged={onChanged} />);

    expect(await screen.findByText('Not configured')).toBeInTheDocument();
    fireEvent.change(screen.getByTestId('mock-select'), { target: { value: MODELS[1]!.id } });
    fireEvent.click(screen.getByRole('button', { name: 'Set up pi…' }));
    expect(configurePi).not.toHaveBeenCalled();

    const dialog = screen.getByRole('alertdialog', { name: 'Set up pi with Gezel?' });
    expect(within(dialog).getByText(/Theo/)).toBeInTheDocument();
    expect(within(dialog).getByText(/character, Qwen 3 14B, and tuning/)).toBeInTheDocument();
    // The promise the card makes about the user's own config must be on the
    // confirmation, not only in the intro paragraph.
    expect(
      within(dialog).getByText(/own pi settings, sessions, and models stay untouched/),
    ).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Set up pi' }));

    await waitFor(() => {
      expect(configurePi).toHaveBeenCalledWith({ model: MODELS[1]!.id });
      expect(onChanged).toHaveBeenCalledOnce();
    });
    expect(await screen.findByText('Configured')).toBeInTheDocument();
  });

  it('groups gezels first while retaining raw models as a fallback', async () => {
    getPiSetupStatus.mockResolvedValue(setupStatus());

    render(<PiSetupCard endpointsEnabled />);

    const select = await screen.findByTestId('mock-select');
    expect(select).toHaveValue('gezel:maya-id');
    expect(
      within(select)
        .getAllByRole('option')
        .map((option) => option.getAttribute('value')),
    ).toEqual(['gezel:maya-id', 'gezel:theo-id', 'llama-cpp:qwen3-8b']);
  });

  it('shows the launch command with the managed config path and copies it', async () => {
    getPiSetupStatus.mockResolvedValue(
      setupStatus({ state: 'configured', configuredModel: MODELS[0]!.id }),
    );

    render(<PiSetupCard endpointsEnabled />);

    expect(await screen.findByText(`pi -e ${OWNED_EXTENSION_PATH}`)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Copy command' }));

    await waitFor(() => {
      expect(writeClipboard).toHaveBeenCalledWith(`pi -e ${OWNED_EXTENSION_PATH}`);
    });
  });

  it('offers repair on a conflict and passes the backup flag', async () => {
    getPiSetupStatus.mockResolvedValue(
      setupStatus({
        state: 'conflict',
        canRepair: true,
        message: 'It was changed outside this setup.',
      }),
    );
    configurePi.mockResolvedValue(
      setupStatus({
        state: 'configured',
        configuredModel: MODELS[0]!.id,
        configBackupPath: `${CONFIG_PATH}.backup`,
      }),
    );

    render(<PiSetupCard endpointsEnabled />);

    expect(await screen.findByText('Needs attention')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Repair pi setup…' }));
    fireEvent.click(
      within(screen.getByRole('alertdialog', { name: 'Repair the pi setup?' })).getByRole(
        'button',
        { name: 'Repair setup' },
      ),
    );

    await waitFor(() => {
      expect(configurePi).toHaveBeenCalledWith({
        model: MODELS[0]!.id,
        backupConflictingConfig: true,
      });
    });
    expect(
      await screen.findByText(`The previous file was saved as ${CONFIG_PATH}.backup.`),
    ).toBeInTheDocument();
  });

  it('shows an update failure inline beside the card', async () => {
    getPiSetupStatus.mockResolvedValue(
      setupStatus({
        state: 'update-needed',
        configuredModel: MODELS[0]!.id,
        reasons: ['The pi inference bridge is not running.'],
      }),
    );
    configurePi.mockRejectedValue({ details: { message: 'pi.json is read-only' } });

    render(<PiSetupCard endpointsEnabled />);

    expect(await screen.findByText('Update needed')).toBeInTheDocument();
    expect(screen.getByText('The pi inference bridge is not running.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Update pi…' }));
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Update pi' }),
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not update the pi setup — pi.json is read-only',
    );
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('blocks configuration while connected-app serving is off', async () => {
    getPiSetupStatus.mockResolvedValue(setupStatus());

    render(<PiSetupCard endpointsEnabled={false} />);

    expect(await screen.findByText(/Allow apps to connect/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Set up pi…' })).toBeDisabled();
  });

  it('lets the user prepare the setup before pi is installed', async () => {
    getPiSetupStatus.mockResolvedValue(setupStatus({ piInstalled: false }));

    render(<PiSetupCard endpointsEnabled />);

    expect(await screen.findByText(/pi was not found on this computer/)).toBeInTheDocument();
    // No version floor to enforce, so preparing ahead of install stays allowed.
    expect(screen.getByRole('button', { name: 'Set up pi…' })).toBeEnabled();
  });

  it('adds the extension only after confirming what lands in the user’s pi', async () => {
    getPiSetupStatus.mockResolvedValue(
      setupStatus({ state: 'configured', configuredModel: MODELS[0]!.id }),
    );
    installPiExtension.mockResolvedValue(
      setupStatus({
        state: 'configured',
        configuredModel: MODELS[0]!.id,
        extension: extensionStatus('installed'),
      }),
    );

    render(<PiSetupCard endpointsEnabled />);

    fireEvent.click(await screen.findByRole('button', { name: 'Add to pi…' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Add Gezel to pi?' });
    expect(dialog).toHaveTextContent(EXTENSION_PATH);
    // The promise that survives this feature is add-not-edit; keep it on the
    // confirmation, where the decision is actually made.
    expect(dialog).toHaveTextContent(/holds no password/);
    expect(dialog).toHaveTextContent(/own pi settings, sessions, and models stay untouched/);
    // The escape hatch belongs on the decision, not buried in docs.
    expect(dialog).toHaveTextContent(/pi -ne/);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add to pi' }));

    await waitFor(() => expect(installPiExtension).toHaveBeenCalledOnce());
    expect(installPiExtension).toHaveBeenCalledWith();
    expect(await screen.findByText(new RegExp(EXTENSION_PATH))).toBeInTheDocument();
  });

  it('removes the extension behind its own confirmation', async () => {
    getPiSetupStatus.mockResolvedValue(
      setupStatus({
        state: 'configured',
        configuredModel: MODELS[0]!.id,
        extension: extensionStatus('installed'),
      }),
    );
    removePiExtension.mockResolvedValue(
      setupStatus({ state: 'configured', configuredModel: MODELS[0]!.id }),
    );

    render(<PiSetupCard endpointsEnabled />);

    fireEvent.click(await screen.findByRole('button', { name: 'Remove from pi…' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Remove Gezel from pi?' });
    expect(dialog).toHaveTextContent(EXTENSION_PATH);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove from pi' }));

    await waitFor(() => expect(removePiExtension).toHaveBeenCalledOnce());
    expect(removePiSetup).not.toHaveBeenCalled();
  });

  it('never overwrites an extension file it does not own', async () => {
    getPiSetupStatus.mockResolvedValue(
      setupStatus({
        state: 'configured',
        configuredModel: MODELS[0]!.id,
        extension: extensionStatus('conflict'),
      }),
    );
    installPiExtension.mockResolvedValue(
      setupStatus({
        state: 'configured',
        configuredModel: MODELS[0]!.id,
        extension: extensionStatus('installed'),
        extensionBackupPath: `${EXTENSION_PATH}.backup`,
      }),
    );

    render(<PiSetupCard endpointsEnabled />);

    expect(await screen.findByText(/written by another Gezel installation/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add to pi…' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Replace pi extension…' }));
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Replace extension' }),
    );

    await waitFor(() =>
      expect(installPiExtension).toHaveBeenCalledWith({ backupConflictingExtension: true }),
    );
    expect(await screen.findByText(/saved as .*\.backup/)).toBeInTheDocument();
  });

  it('hides the extension action when pi cannot host it', async () => {
    getPiSetupStatus.mockResolvedValue(
      setupStatus({
        state: 'configured',
        configuredModel: MODELS[0]!.id,
        extension: extensionStatus('unsupported'),
      }),
    );

    render(<PiSetupCard endpointsEnabled />);

    expect(await screen.findByText('Configured')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add to pi…' })).not.toBeInTheDocument();
  });
});
