import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { primitivesMock } from '../test-utils/primitivesMock.js';

const getVSCodeSetupStatus = vi.fn();
const configureVSCode = vi.fn();
const removeVSCodeSetup = vi.fn();

vi.mock('../api.js', () => ({
  api: { getVSCodeSetupStatus, configureVSCode, removeVSCodeSetup },
}));
vi.mock('../primitives/index.js', () => primitivesMock);
vi.mock('./ConfirmDialog.js', () => ({
  ConfirmDialog: ({
    open,
    title,
    message,
    confirmLabel,
    onConfirm,
  }: {
    open: boolean;
    title: string;
    message?: React.ReactNode;
    confirmLabel?: string;
    onConfirm: () => void | Promise<void>;
  }) =>
    open ? (
      <div role="alertdialog" aria-label={title}>
        <div>{message}</div>
        <button type="button" onClick={() => void onConfirm()}>
          {confirmLabel ?? 'Confirm'}
        </button>
      </div>
    ) : null,
}));

const { VSCodeSetupCard } = await import('./VSCodeSetupCard.js');

const MODELS = [
  {
    id: 'gezel:maya',
    label: 'Maya',
    kind: 'gezel' as const,
    provider: 'llama-cpp',
    supportsTools: true,
  },
];

function setupStatus(overrides: Record<string, unknown> = {}) {
  return {
    state: 'not-configured' as const,
    models: MODELS,
    reasons: [],
    vscodeInstalled: true,
    vscodeVersion: '1.100.0',
    endpointsEnabled: true,
    providerId: 'customendpoint',
    profiles: [
      {
        id: 'code:default',
        label: 'Default profile',
        product: 'code',
        configPath: '/Users/test/Code/User/chatLanguageModels.json',
      },
      {
        id: 'code:work',
        label: 'Work',
        product: 'code',
        configPath: '/Users/test/Code/User/profiles/work/chatLanguageModels.json',
      },
    ],
    configPath: '/Users/test/Code/User/chatLanguageModels.json',
    launchCommand: 'code',
    bridge: { baseUrl: 'http://127.0.0.1:24567/v1', listening: true, port: 24567 },
    canConfigure: true,
    canRemove: false,
    canRepair: false,
    ...overrides,
  };
}

describe('VSCodeSetupCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.__GEZEL__ = { token: 'test-token', mode: 'local-adopt' };
  });

  it('selects a profile and confirms the plaintext scoped-credential tradeoff', async () => {
    getVSCodeSetupStatus.mockResolvedValue(setupStatus());
    configureVSCode.mockResolvedValue(
      setupStatus({
        state: 'configured',
        configuredProfileId: 'code:work',
        canRemove: true,
      }),
    );

    render(<VSCodeSetupCard endpointsEnabled />);

    expect(await screen.findByText('Not configured')).toBeInTheDocument();
    expect(screen.getByText(/Developer: Reload Window/)).toBeInTheDocument();
    fireEvent.change(screen.getByTestId('mock-select'), { target: { value: 'code:work' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set up VS Code…' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Set up VS Code with Gezel?' });
    expect(within(dialog).getByText(/plain text/)).toBeInTheDocument();
    expect(within(dialog).getByText(/inference-only/)).toBeInTheDocument();
    expect(within(dialog).getByText(/reload its window or restart it/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Set up VS Code' }));

    await waitFor(() => expect(configureVSCode).toHaveBeenCalledWith({ profileId: 'code:work' }));
  });

  it('requires repair confirmation and reports the backup path', async () => {
    getVSCodeSetupStatus.mockResolvedValue(
      setupStatus({
        state: 'conflict',
        message: 'The Gezel provider was changed.',
        canConfigure: false,
        canRepair: true,
      }),
    );
    configureVSCode.mockResolvedValue(
      setupStatus({
        state: 'configured',
        configuredProfileId: 'code:default',
        canRemove: true,
        configBackupPath: '/Users/test/Code/User/chatLanguageModels.json.backup',
      }),
    );

    render(<VSCodeSetupCard endpointsEnabled />);
    const repair = await screen.findByRole('button', { name: 'Repair VS Code setup…' });
    await waitFor(() => expect(repair).toBeEnabled());
    fireEvent.click(repair);
    const dialog = screen.getByRole('alertdialog', { name: 'Repair the VS Code setup?' });
    expect(
      within(dialog).getByText(/Providers that are not named Gezel remain untouched/),
    ).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Repair setup' }));

    await waitFor(() =>
      expect(configureVSCode).toHaveBeenCalledWith({
        profileId: 'code:default',
        backupConflictingConfig: true,
      }),
    );
    expect(await screen.findByText(/was saved as/)).toHaveTextContent('.backup');
  });

  it('keeps removal available when connected-app serving is off', async () => {
    getVSCodeSetupStatus.mockResolvedValue(
      setupStatus({
        state: 'configured',
        configuredProfileId: 'code:default',
        canRemove: true,
      }),
    );
    removeVSCodeSetup.mockResolvedValue(setupStatus());

    render(<VSCodeSetupCard endpointsEnabled={false} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove setup…' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Remove Gezel setup from VS Code?' });
    expect(within(dialog).getByText(/does not uninstall VS Code/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove setup' }));

    await waitFor(() => expect(removeVSCodeSetup).toHaveBeenCalledOnce());
  });
});
