import { render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const updateConfig = vi.fn(async (body: Record<string, unknown>) => ({
  openaiEndpoints: body.openaiEndpoints,
}));

vi.mock('../api.js', () => ({
  api: {
    getBaseUrl: () => 'http://127.0.0.1:3333',
    authHeader: () => ({ Authorization: 'Bearer test-token' }),
    getConfig: async () => ({
      provider: 'copilot',
      openaiEndpoints: { servingGezelId: 'mira' },
    }),
    updateConfig: (body: Record<string, unknown>) => updateConfig(body),
    listGezels: async () => ({
      gezels: [
        // No per-gezel provider → resolves to the install default (copilot).
        { id: 'mira', name: 'Mira', role: 'Designer' },
        { id: 'joos', name: 'Joos', role: 'Builder', provider: 'llama-cpp' },
      ],
    }),
  },
}));

vi.mock('./ConfirmDialog.js', () => ({ ConfirmDialog: () => null }));

const { ConnectedAppsPanel } = await import('./ConnectedAppsPanel.js');

describe('ConnectedAppsPanel', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          apps: [
            {
              appId: 'desktop-client',
              appName: 'Gezel Desktop',
              scopes: ['ui', 'openai'],
              createdAt: Date.now() - 14 * 60_000,
              lastUsedAt: Date.now(),
            },
            {
              appId: 'vscode',
              appName: 'Visual Studio Code',
              scopes: ['product', 'openai'],
              createdAt: Date.now(),
              lastUsedAt: Date.now(),
            },
          ],
          grants: [
            {
              id: 'grant-cli',
              appId: 'gezel-cli',
              appName: 'Gezel CLI',
              scopes: ['cli'],
              status: 'pending',
              createdAt: Date.now(),
              verificationRequired: true,
            },
          ],
        }),
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders connected apps as one row per app with distinct permission columns', async () => {
    render(<ConnectedAppsPanel />);

    const table = await screen.findByRole('table', { name: 'Connected apps' });
    expect(within(table).getAllByRole('columnheader')).toHaveLength(4);
    expect(within(table).getAllByRole('row')).toHaveLength(3);

    const desktopRow = within(table).getByText('Gezel Desktop').closest('tr');
    expect(desktopRow).not.toBeNull();
    expect(within(desktopRow!).getByText('desktop-client')).toBeInTheDocument();
    expect(within(desktopRow!).getByText('ui')).toBeInTheDocument();
    expect(within(desktopRow!).getByText('openai')).toBeInTheDocument();
    expect(within(desktopRow!).getByLabelText('Revoke Gezel Desktop')).toBeInTheDocument();
  });

  it('describes a pending CLI grant as command-line control', async () => {
    render(<ConnectedAppsPanel />);
    expect(await screen.findByText(/wants command-line control/)).toBeInTheDocument();
    expect(screen.getByLabelText('Connection code for Gezel CLI')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Deny' })).toBeEnabled();
  });

  it('shows the endpoints toggle on (default), the base URL, and the serving gezel', async () => {
    render(<ConnectedAppsPanel />);
    const toggle = await screen.findByRole('checkbox', { name: 'Allow apps to connect' });
    expect(toggle).toBeChecked();
    expect(screen.getByText('http://127.0.0.1:3333/v1')).toBeInTheDocument();
    // getConfig scripts servingGezelId=mira — the explainer names her.
    expect(await screen.findByText(/answered by Mira/)).toBeInTheDocument();
  });

  it('shows the supporting-behaviors toggle on by default', async () => {
    render(<ConnectedAppsPanel />);
    const toggle = await screen.findByRole('checkbox', { name: 'Supporting behaviors' });
    expect(toggle).toBeChecked();
  });

  it('warns when the serving gezel resolves to a provider without app-tool support', async () => {
    render(<ConnectedAppsPanel />);
    // Mira has no provider override, so she resolves to the install
    // default (copilot) — an agent runtime that can't accept caller
    // tools, which the panel calls out at pick time.
    expect(await screen.findByText(/Mira runs on copilot/)).toBeInTheDocument();
    expect(screen.getByText(/can't accept tools/)).toBeInTheDocument();
  });

  it('persists a toggle-off without dropping the chosen serving gezel', async () => {
    const { fireEvent } = await import('@testing-library/react');
    render(<ConnectedAppsPanel />);
    const toggle = await screen.findByRole('checkbox', { name: 'Allow apps to connect' });
    await screen.findByText(/answered by Mira/);
    fireEvent.click(toggle);
    expect(updateConfig).toHaveBeenCalledWith({
      openaiEndpoints: { enabled: false, servingGezelId: 'mira' },
    });
    expect(await screen.findByText(/Turned off/)).toBeInTheDocument();
  });
});
