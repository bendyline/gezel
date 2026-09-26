import type { OfficeSetupStatusResponse } from '@bendyline/gezel';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getOfficeSetupStatus = vi.fn();
vi.mock('../api.js', () => ({ api: { officeIntegrations: { getOfficeSetupStatus } } }));
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

const { OfficeSetupCard } = await import('./OfficeSetupCard.js');

function status(overrides: Partial<OfficeSetupStatusResponse> = {}): OfficeSetupStatusResponse {
  return {
    state: 'not-configured',
    reasons: [],
    hostSupported: true,
    officeInstalled: true,
    apps: [
      { app: 'word', label: 'Word', detected: true, selected: false, registered: null },
      { app: 'excel', label: 'Excel', detected: true, selected: false, registered: null },
      {
        app: 'powerpoint',
        label: 'PowerPoint',
        detected: false,
        selected: false,
        registered: null,
      },
    ],
    listener: { state: 'stopped', port: 30000, origin: 'https://localhost:30000' },
    trust: { installed: null },
    canConfigure: true,
    canRemove: false,
    ...overrides,
  };
}

function installBridge(initial: OfficeSetupStatusResponse, after?: OfficeSetupStatusResponse) {
  const bridge = {
    verify: vi.fn(async () => ({ ok: true as const, status: initial })),
    enable: vi.fn(async () => ({ ok: true as const, status: after ?? initial })),
    repair: vi.fn(async () => ({ ok: true as const, status: after ?? initial })),
    disable: vi.fn(async () => ({ ok: true as const, status: status() })),
    clearCache: vi.fn(async () => ({ ok: true as const })),
  };
  window.__GEZEL__ = {
    ...(window.__GEZEL__ ?? {}),
    mode: 'local-adopt',
    officeHost: bridge,
  } as typeof window.__GEZEL__;
  return bridge;
}

beforeEach(() => {
  getOfficeSetupStatus.mockReset();
});
afterEach(() => {
  if (window.__GEZEL__) {
    delete window.__GEZEL__.officeHost;
    delete window.__GEZEL__.mode;
  }
});

describe('OfficeSetupCard', () => {
  it('preselects the Office apps found on this computer and sets them up', async () => {
    const configured = status({
      state: 'configured',
      apps: status().apps.map((a) =>
        a.app === 'powerpoint' ? a : { ...a, selected: true, registered: true },
      ),
      trust: { installed: true },
      canRemove: true,
    });
    const bridge = installBridge(status(), configured);
    render(<OfficeSetupCard />);
    await screen.findByText('Not configured');
    expect(screen.getByRole('checkbox', { name: /Word/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Excel/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /PowerPoint/ })).not.toBeChecked();

    fireEvent.click(screen.getByRole('button', { name: 'Set up Office…' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Add Gezel to Office?' });
    expect(dialog).toHaveTextContent(/trusted for your account only/);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Set up Office' }));
    await waitFor(() => expect(bridge.enable).toHaveBeenCalledWith(['word', 'excel']));
    await screen.findByText('Configured');
    expect(screen.getByText(/choose/)).toHaveTextContent(/Home tab/);
  });

  it('lists what is left and offers to finish setup', async () => {
    const pending = status({
      state: 'update-needed',
      reasons: ["Open the Gezel desktop app to trust Gezel's Office certificate."],
      apps: status().apps.map((a) => (a.app === 'word' ? { ...a, selected: true } : a)),
      canRemove: true,
    });
    const bridge = installBridge(pending);
    render(<OfficeSetupCard />);
    await screen.findByText(/trust Gezel's Office certificate/);
    fireEvent.click(screen.getByRole('button', { name: 'Finish setup' }));
    await waitFor(() => expect(bridge.repair).toHaveBeenCalled());
  });

  it('shows the bridge error with a retry', async () => {
    const bridge = installBridge(status());
    bridge.enable.mockResolvedValueOnce({
      ok: false,
      error: 'The authorization was cancelled by the user.',
    } as never);
    render(<OfficeSetupCard />);
    await screen.findByText('Not configured');
    fireEvent.click(screen.getByRole('button', { name: 'Set up Office…' }));
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Set up Office' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not set up Office: The authorization was cancelled by the user.',
    );
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('is read-only outside the desktop app', async () => {
    getOfficeSetupStatus.mockResolvedValue(status());
    render(<OfficeSetupCard />);
    await screen.findByText(/done from the Gezel desktop app/);
    expect(screen.getByRole('button', { name: 'Set up Office…' })).toBeDisabled();
  });

  it('explains when the platform has no Office add-ins', async () => {
    getOfficeSetupStatus.mockResolvedValue(
      status({
        state: 'unavailable',
        hostSupported: false,
        message: 'Word, Excel and PowerPoint add-ins are available on Windows and macOS.',
        canConfigure: false,
      }),
    );
    render(<OfficeSetupCard />);
    await screen.findByText(/available on Windows and macOS/);
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Set up Office…' })).toBeNull();
  });
});
