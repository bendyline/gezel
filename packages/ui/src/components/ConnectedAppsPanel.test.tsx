import type { CodexSetupStatusResponse } from '@bendyline/gezel';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const updateConfig = vi.fn(async (body: Record<string, unknown>) => ({
  openaiEndpoints: body.openaiEndpoints,
}));
const getConfig = vi.fn(async () => ({
  provider: 'copilot',
  meesterGezelId: 'mira',
  openaiEndpoints: { servingGezelId: 'mira' } as {
    enabled?: boolean;
    servingGezelId?: string;
  },
}));
const getCodexSetupStatus = vi.fn(
  async (): Promise<CodexSetupStatusResponse> => ({
    state: 'not-configured' as const,
    models: [],
    reasons: [],
    codexInstalled: false,
    endpointsEnabled: true,
    profileName: 'gezel',
    profilePath: '/tmp/gezel-codex/config.toml',
    launchCommand: 'codex --profile gezel',
    bridge: { baseUrl: 'https://127.0.0.1:3333/v1', listening: true, port: 3333 },
    canConfigure: false,
    canRemove: false,
  }),
);

vi.mock('../api.js', () => ({
  api: {
    getBaseUrl: () => 'http://127.0.0.1:3333',
    authHeader: () => ({ Authorization: 'Bearer test-token' }),
    getConfig,
    updateConfig: (body: Record<string, unknown>) => updateConfig(body),
    getCodexSetupStatus,
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
    vi.clearAllMocks();
    getConfig.mockResolvedValue({
      provider: 'copilot',
      meesterGezelId: 'mira',
      openaiEndpoints: { servingGezelId: 'mira' },
    });
    getCodexSetupStatus.mockResolvedValue({
      state: 'not-configured',
      models: [],
      reasons: [],
      codexInstalled: false,
      endpointsEnabled: true,
      profileName: 'gezel',
      profilePath: '/tmp/gezel-codex/config.toml',
      launchCommand: 'codex --profile gezel',
      bridge: { baseUrl: 'https://127.0.0.1:3333/v1', listening: true, port: 3333 },
      canConfigure: false,
      canRemove: false,
    });
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
    expect(await screen.findByText(/Mira answers/)).toBeInTheDocument();
    expect(screen.queryByText(/None — apps must name a model/)).not.toBeInTheDocument();
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
    render(<ConnectedAppsPanel />);
    const toggle = await screen.findByRole('checkbox', { name: 'Allow apps to connect' });
    await screen.findByText(/Mira answers/);
    fireEvent.click(toggle);
    expect(updateConfig).toHaveBeenCalledWith({
      openaiEndpoints: { enabled: false, servingGezelId: 'mira' },
    });
    expect(await screen.findByText(/Turned off/)).toBeInTheDocument();
  });

  it('reloads Codex setup status after successfully enabling app connections', async () => {
    getConfig.mockResolvedValueOnce({
      provider: 'copilot',
      meesterGezelId: 'mira',
      openaiEndpoints: { enabled: false, servingGezelId: 'mira' },
    });
    getCodexSetupStatus
      .mockResolvedValueOnce({
        state: 'not-configured',
        models: [
          {
            id: 'llama-cpp:coder.gguf',
            label: 'Local Coder',
            provider: 'llama-cpp',
            supportsTools: true,
          },
        ],
        recommendedModel: 'llama-cpp:coder.gguf',
        reasons: [],
        codexInstalled: true,
        codexVersion: '0.147.0',
        endpointsEnabled: false,
        profileName: 'gezel-local',
        profilePath: '/tmp/gezel-codex/gezel-local.config.toml',
        launchCommand: 'codex --profile gezel-local',
        bridge: { baseUrl: 'http://127.0.0.1:11435/v1', listening: false, port: 11_435 },
        canConfigure: false,
        canRemove: false,
      })
      .mockResolvedValue({
        state: 'not-configured',
        models: [
          {
            id: 'llama-cpp:coder.gguf',
            label: 'Local Coder',
            provider: 'llama-cpp',
            supportsTools: true,
          },
        ],
        recommendedModel: 'llama-cpp:coder.gguf',
        reasons: [],
        codexInstalled: true,
        codexVersion: '0.147.0',
        endpointsEnabled: true,
        profileName: 'gezel-local',
        profilePath: '/tmp/gezel-codex/gezel-local.config.toml',
        launchCommand: 'codex --profile gezel-local',
        bridge: { baseUrl: 'http://127.0.0.1:11435/v1', listening: false, port: 11_435 },
        canConfigure: true,
        canRemove: false,
      });

    render(<ConnectedAppsPanel />);

    const toggle = await screen.findByRole('checkbox', { name: 'Allow apps to connect' });
    expect(toggle).not.toBeChecked();
    expect(await screen.findByRole('button', { name: 'Set up Codex…' })).toBeDisabled();
    fireEvent.click(toggle);

    await waitFor(() => expect(getCodexSetupStatus).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('button', { name: 'Set up Codex…' })).toBeEnabled();
  });
});
