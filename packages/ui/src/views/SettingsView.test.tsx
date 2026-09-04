import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';
import { primitivesMock } from '../test-utils/primitivesMock.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));
vi.mock('../primitives/index.js', () => primitivesMock);

// SettingsView pulls in basically everything — most kids aren't needed
// for a smoke + section-presence test.
const stub = (label: string) => () => <div data-testid={label}>{label}</div>;

vi.mock('./AudioEngineSettings.js', () => ({ AudioEngineSettings: stub('audio-settings') }));
vi.mock('./ChannelsSettings.js', () => ({ ChannelsSettings: stub('channels-settings') }));
vi.mock('./FoldersSettings.js', () => ({ FoldersSettings: stub('folders-settings') }));
vi.mock('./ImageEngineSettings.js', () => ({ ImageEngineSettings: stub('image-settings') }));
vi.mock('./LlamaCppSettings.js', () => ({ LlamaCppSettings: stub('llamacpp-settings') }));
vi.mock('./MlxSettings.js', () => ({ MlxSettings: stub('mlx-settings') }));
vi.mock('./MicrophoneSettings.js', () => ({
  MicrophoneSettings: stub('microphone-settings'),
}));
vi.mock('./OllamaSettings.js', () => ({
  OllamaSettings: stub('ollama-settings'),
  TimeoutRow: stub('timeout-row'),
}));

vi.mock('../components/CacheControlsPanel.js', () => ({ CacheControlsPanel: () => null }));
vi.mock('../components/CatalogBrowser.js', () => ({ CatalogBrowser: () => null }));
vi.mock('../components/ConfirmDialog.js', () => ({
  ConfirmDialog: ({
    open,
    confirmLabel = 'Confirm',
    onConfirm,
  }: {
    open: boolean;
    confirmLabel?: string;
    onConfirm: () => void | Promise<void>;
  }) =>
    open ? (
      <button type="button" onClick={() => void onConfirm()}>
        {confirmLabel}
      </button>
    ) : null,
}));
vi.mock('../components/CopilotLoginCommand.js', () => ({ CopilotLoginCommand: () => null }));
vi.mock('../components/DeviceSummary.js', () => ({ DeviceSummary: () => null }));
vi.mock('../components/GezelIcon.js', () => ({ GezelIcon: () => null }));
vi.mock('../components/GithubDeviceCodeModal.js', () => ({ GitHubDeviceCodeModal: () => null }));
vi.mock('../components/GithubSignInChip.js', () => ({ GitHubSignInChip: () => null }));
vi.mock('../components/HealthStrip.js', () => ({ HealthStrip: () => null }));
vi.mock('../components/InstallModelTuningEditor.js', () => ({
  InstallModelTuningEditor: () => null,
}));
vi.mock('../components/ModelPicker.js', async () => {
  const actual = await vi.importActual<typeof import('../components/ModelPicker.js')>(
    '../components/ModelPicker.js',
  );
  return {
    ...actual,
    ModelPicker: ({
      provider,
      onChange,
    }: {
      provider: string;
      onChange: (value: string | undefined) => void;
    }) => (
      <button
        type="button"
        data-testid={`model-picker-${provider}`}
        onClick={() => onChange(`${provider}-test-model`)}
      >
        Choose {provider} model
      </button>
    ),
  };
});
vi.mock('../components/ProviderModelSelect.js', () => ({ ProviderModelSelect: () => null }));

const { SettingsView } = await import('./SettingsView.js');
const { api } = await import('../api.js');
const { resetUpdateStateForTests } = await import('../update-state.js');
const { refreshCopilotAvailability } = await import('../components/useCopilotAvailability.js');

/** Copilot present in the manifest, absent from this device. */
const UNAVAILABLE = {
  available: false,
  source: null,
  managed: 'absent',
  pinnedVersion: '1.0.7',
  updateAvailable: false,
};

describe('SettingsView', () => {
  beforeEach(() => {
    // The availability hook memoizes module-wide so the several gates that
    // read it don't each fetch. That cache outlives a test, so drop it or the
    // first case's answer decides every later one.
    refreshCopilotAvailability();
    window.__GEZEL__ = {
      ...window.__GEZEL__,
      token: window.__GEZEL__?.token ?? 'test-token',
      platform: 'linux',
    };
    vi.mocked(api.getConfig).mockResolvedValue({
      provider: 'mock',
      meesterGezelId: 'gz-meester',
      boekwachterGezelId: 'noor',
      hasGithubToken: true,
    } as never);
    vi.mocked(api.health).mockResolvedValue({
      ok: true,
      version: '0.1.0',
      platform: 'linux',
    } as never);
    vi.mocked(api.listGezels).mockResolvedValue({
      gezels: [
        { id: 'gz-meester', name: 'Brigitte' },
        { id: 'noor', name: 'Noor', role: 'Boekwachter' },
      ],
    } as never);
    vi.mocked(api.getUsage).mockResolvedValue({ providers: {} } as never);
    vi.mocked(api.getQueueStatus).mockResolvedValue({ queues: [] } as never);
    vi.mocked(api.testProvider).mockResolvedValue({ ok: true, modelCount: 1 } as never);
    vi.mocked(api.getCatalogItem).mockResolvedValue(null as never);
  });

  it('mounts and loads config + health on mount', async () => {
    render(<SettingsView />);
    await waitFor(() => {
      expect(api.getConfig).toHaveBeenCalled();
    });
    expect(api.health).toHaveBeenCalled();
  });

  it('renders without crashing and shows section navigation', async () => {
    render(<SettingsView />);
    await waitFor(() => {
      expect(api.getConfig).toHaveBeenCalled();
    });
    // SettingsView builds nav links for each section — at least one
    // recognizable label should be present.
    await waitFor(() => {
      const headings = screen.getAllByRole('heading');
      expect(headings.length).toBeGreaterThan(0);
    });
  });

  it('hosts microphone settings under Device Integration', async () => {
    render(<SettingsView />);
    fireEvent.click(await screen.findByTestId('settings-nav-deviceIntegration'));

    expect(await screen.findByTestId('microphone-settings')).toBeInTheDocument();
  });

  it('persists the automatic update-check preference from About settings', async () => {
    vi.mocked(api.getConfig).mockResolvedValue({
      provider: 'mock',
      meesterGezelId: 'gz-meester',
      hasGithubToken: true,
      autoUpdateChecks: true,
    } as never);
    vi.mocked(api.updateConfig).mockResolvedValue({
      provider: 'mock',
      meesterGezelId: 'gz-meester',
      hasGithubToken: true,
      autoUpdateChecks: false,
    } as never);

    render(<SettingsView />);
    fireEvent.click(await screen.findByTestId('settings-nav-about'));
    const checkbox = await screen.findByRole('checkbox', {
      name: 'Check for updates automatically when Gezel starts',
    });
    expect(checkbox).toBeChecked();

    fireEvent.click(checkbox);

    await waitFor(() => expect(api.updateConfig).toHaveBeenCalledWith({ autoUpdateChecks: false }));
  });

  it('offers one "Show gezel names and poppetjes" toggle driving both display flags', async () => {
    // Formerly two checkboxes under a "Boring mode" heading; the single
    // positive switch matches first run (2026-09-02 UX review).
    vi.mocked(api.updateConfig).mockResolvedValue({
      provider: 'mock',
      meesterGezelId: 'gz-meester',
      roleBasedNameOnlyMode: true,
      showPoppetjes: false,
    } as never);

    render(<SettingsView />);
    const checkbox = await screen.findByRole('checkbox', {
      name: 'Show gezel names and poppetjes',
    });
    expect(checkbox).toBeChecked();
    expect(screen.queryByText('Boring mode')).toBeNull();
    expect(screen.queryByRole('checkbox', { name: /role-based names only/ })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: /Hide poppetjes/ })).toBeNull();

    fireEvent.click(checkbox);
    await waitFor(() =>
      expect(api.updateConfig).toHaveBeenCalledWith({
        roleBasedNameOnlyMode: true,
        showPoppetjes: false,
      }),
    );
  });

  it('labels the role-assignment pickers by role-based name in boring mode', async () => {
    vi.mocked(api.getConfig).mockResolvedValue({
      provider: 'mock',
      meesterGezelId: 'gz-meester',
      boekwachterGezelId: 'noor',
      roleBasedNameOnlyMode: true,
    } as never);
    vi.mocked(api.listGezels).mockResolvedValue({
      gezels: [
        { id: 'gz-meester', name: 'Brigitte', role: 'Meester', roleBasedName: 'meester' },
        { id: 'noor', name: 'Noor', role: 'Boekwachter', roleBasedName: 'boekwachter' },
      ],
    } as never);

    render(<SettingsView />);
    fireEvent.click(await screen.findByTestId('settings-nav-team'));

    // The card above each picker and the picker's own options both name the
    // gezel — neither may leak the friendly name while boring mode is on.
    await waitFor(() => expect(screen.getAllByText('meester').length).toBeGreaterThan(0));
    expect(screen.getAllByText('boekwachter').length).toBeGreaterThan(0);
    expect(screen.queryByText(/Brigitte/)).toBeNull();
    expect(screen.queryByText(/Noor/)).toBeNull();
  });

  it('defaults very early work-in-progress features off and persists the toggle', async () => {
    vi.mocked(api.updateConfig).mockResolvedValue({
      provider: 'mock',
      showWorkInProgressFeatures: true,
    } as never);

    render(<SettingsView />);
    fireEvent.click(await screen.findByTestId('settings-nav-about'));
    const checkbox = await screen.findByRole('checkbox', {
      name: 'Show very early work-in-progress features',
    });
    expect(checkbox).not.toBeChecked();

    fireEvent.click(checkbox);

    await waitFor(() =>
      expect(api.updateConfig).toHaveBeenCalledWith({ showWorkInProgressFeatures: true }),
    );
  });

  it('defaults both inline checking toggles on and persists a change', async () => {
    vi.mocked(api.updateConfig).mockResolvedValue({
      provider: 'mock',
      inlineGrammarChecking: false,
    } as never);

    render(<SettingsView />);
    await waitFor(() => expect(api.getConfig).toHaveBeenCalled());

    const spelling = await screen.findByRole('checkbox', { name: 'Show inline spell checking' });
    const grammar = await screen.findByRole('checkbox', { name: 'Show inline grammar checking' });
    expect(spelling).toBeChecked();
    expect(grammar).toBeChecked();
    expect(
      screen.getByText('(Grammar checking is currently only available for English)'),
    ).toBeInTheDocument();

    fireEvent.click(grammar);

    await waitFor(() =>
      expect(api.updateConfig).toHaveBeenCalledWith({ inlineGrammarChecking: false }),
    );
  });

  it('hides the Channels section until work-in-progress features are on', async () => {
    render(<SettingsView />);
    await waitFor(() => expect(api.getConfig).toHaveBeenCalled());
    await screen.findByTestId('settings-nav-about');
    expect(screen.queryByTestId('settings-nav-channels')).toBeNull();
  });

  it('shows the Channels section when work-in-progress features are on', async () => {
    vi.mocked(api.getConfig).mockResolvedValue({
      provider: 'mock',
      meesterGezelId: 'gz-meester',
      hasGithubToken: true,
      showWorkInProgressFeatures: true,
    } as never);

    render(<SettingsView />);
    fireEvent.click(await screen.findByTestId('settings-nav-channels'));

    expect(await screen.findByTestId('channels-settings')).toBeInTheDocument();
  });

  it('offers the installed macOS uninstaller from About settings', async () => {
    window.__GEZEL__ = {
      ...window.__GEZEL__,
      token: 'test-token',
      platform: 'darwin',
      uninstall: {
        start: vi.fn(),
        onShowRequested: vi.fn(() => () => undefined),
      },
    };

    render(<SettingsView />);
    fireEvent.click(await screen.findByTestId('settings-nav-about'));

    expect(await screen.findByRole('button', { name: 'Uninstall Gezel…' })).toBeInTheDocument();
  });

  it('About labels the live local engine processes and their granted context windows', async () => {
    const base = await api.getSystemDiagnostics();
    vi.mocked(api.getSystemDiagnostics).mockResolvedValue({
      ...base,
      localEngines: [
        {
          provider: 'llama-cpp',
          model: 'qwen3.6-27b-q4',
          pid: 4242,
          contextPerSlot: 65_536,
          slots: 1,
          kvCacheType: 'q8_0',
          backend: 'metal',
        },
        {
          provider: 'ds4',
          model: 'deepseek-v4-q4',
          pid: 4343,
          contextPerSlot: 32_768,
          slots: 1,
          backend: 'cuda',
        },
        {
          provider: 'mlx',
          model: 'gemma4-e4b-q8',
          pid: 4444,
          contextPerSlot: 16_384,
          slots: 1,
          backend: 'metal',
        },
      ],
    });

    render(<SettingsView />);
    fireEvent.click(await screen.findByTestId('settings-nav-about'));
    expect(await screen.findByText('Local engine processes')).toBeInTheDocument();
    const llama = screen.getByText('gezel-llama-server:').parentElement;
    expect(llama).not.toBeNull();
    expect(llama?.textContent).toContain('qwen3.6-27b-q4');
    expect(llama?.textContent).toContain('65,536-token context window');
    expect(llama?.textContent).toContain('q8_0 KV');
    expect(llama?.textContent).toContain('pid 4242');
    expect(screen.getByText('gezel-ds4-server:').parentElement?.textContent).toContain(
      'deepseek-v4-q4',
    );
    expect(screen.getByText('gezel_mlx_server.py:').parentElement?.textContent).toContain(
      'gemma4-e4b-q8',
    );
    expect(screen.getByRole('button', { name: 'Hard Stop' })).toBeInTheDocument();
  });

  it('About hard-stops chats, unloads the engine status, and reports the result', async () => {
    const base = await api.getSystemDiagnostics();
    vi.mocked(api.getSystemDiagnostics).mockResolvedValue({
      ...base,
      localEngines: [{ provider: 'llama-cpp', model: 'qwen3.6-27b-q4', pid: 4242 }],
    });
    vi.mocked(api.emergencyStopChats).mockResolvedValue({
      ok: true,
      engagementMode: 'reactive',
      persisted: true,
      cancelledTurns: 2,
      clearedQueuedMessages: 1,
      clearedDeferredActions: 0,
    });

    render(<SettingsView />);
    fireEvent.click(await screen.findByTestId('settings-nav-about'));
    fireEvent.click(await screen.findByRole('button', { name: 'Hard Stop' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Hard stop' }));

    await waitFor(() => expect(api.emergencyStopChats).toHaveBeenCalledOnce());
    expect(
      await screen.findByText(
        'Stopped 2 chats and discarded 1 queued message. Local engines unloaded. Gezel is Reactive.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText('Local engine processes')).not.toBeInTheDocument();
  });

  // About is the only full home for install-health notices — the rail just
  // points here. See system-notices.ts.
  describe('install-health notices in About', () => {
    beforeEach(() => {
      resetUpdateStateForTests();
      window.__GEZEL__ = {
        ...window.__GEZEL__,
        token: 'test-token',
        platform: 'darwin',
        fallbackReason: null,
        fallbackCode: null,
        update: undefined,
      };
    });

    it('reports a healthy service plainly', async () => {
      render(<SettingsView />);
      fireEvent.click(await screen.findByTestId('settings-nav-about'));
      expect(
        await screen.findByText('The background service is running normally.'),
      ).toBeInTheDocument();
    });

    it('explains a service that did not start, without promising it returns', async () => {
      window.__GEZEL__ = {
        ...window.__GEZEL__,
        token: window.__GEZEL__?.token ?? 'test-token',
        fallbackReason: 'System service was unavailable: SCM stopped',
        fallbackCode: 'system-service-unhealthy',
      };

      render(<SettingsView />);
      fireEvent.click(await screen.findByTestId('settings-nav-about'));

      const notice = await screen.findByTestId('settings-notice-service-unavailable');
      expect(notice).toHaveTextContent('Background work is off.');
      expect(notice).toHaveTextContent('will not start again by itself');
      expect(notice).toHaveTextContent('Run the Gezel PKG again');
      expect(notice).toHaveTextContent('System service was unavailable: SCM stopped');
      expect(notice).not.toHaveTextContent('temporarily');
    });

    // The reported bug: a failed *check* was shown on Home as "Gezel could
    // not install an update", which is a different (and alarming) claim.
    it('calls a failed update check what it is, here and nowhere else', async () => {
      window.__GEZEL__ = {
        ...window.__GEZEL__,
        update: {
          state: vi.fn().mockResolvedValue({
            kind: 'error',
            stage: 'check',
            message: 'net::ERR_INTERNET_DISCONNECTED',
          }),
          install: vi.fn(),
          onStateChanged: vi.fn(),
        },
      } as never;

      render(<SettingsView />);
      fireEvent.click(await screen.findByTestId('settings-nav-about'));

      const notice = await screen.findByTestId('settings-notice-update-check-failed');
      expect(notice).toHaveTextContent('Gezel could not check for updates.');
      expect(notice).not.toHaveTextContent('could not install');
      expect(notice).toHaveTextContent('net::ERR_INTERNET_DISCONNECTED');
    });

    it('shows byte progress and offers the Windows install handoff when ready', async () => {
      window.__GEZEL__ = {
        ...window.__GEZEL__,
        platform: 'win32',
        update: {
          state: vi.fn().mockResolvedValue({
            kind: 'downloading',
            version: '1.26224.48',
            percent: 64,
            transferred: 64 * 1024 * 1024,
            total: 100 * 1024 * 1024,
            bytesPerSecond: 8 * 1024 * 1024,
          }),
          install: vi.fn(),
          onStateChanged: vi.fn(),
        },
      } as never;

      const downloading = render(<SettingsView />);
      fireEvent.click(await screen.findByTestId('settings-nav-about'));
      const progress = await screen.findByTestId('update-status-downloading');
      expect(progress).toHaveTextContent('64%');
      expect(progress).toHaveTextContent('64 MB of 100 MB · 8.0 MB/s');
      expect(screen.getByRole('progressbar')).toHaveAttribute('value', '64');
      downloading.unmount();

      resetUpdateStateForTests();
      const install = vi.fn().mockResolvedValue({ ok: true });
      window.__GEZEL__ = {
        token: 'test-token',
        platform: 'win32',
        update: {
          state: vi.fn().mockResolvedValue({ kind: 'ready', version: '1.26224.48' }),
          install,
          onStateChanged: vi.fn(),
        },
      } as never;

      render(<SettingsView />);
      fireEvent.click(await screen.findByTestId('settings-nav-about'));
      const ready = await screen.findByTestId('update-status-ready');
      expect(ready).toHaveTextContent('install automatically after you quit Gezel completely');
      fireEvent.click(screen.getByRole('button', { name: 'Install and restart' }));
      await waitFor(() => expect(install).toHaveBeenCalledOnce());
    });

    it('offers only the release page for a Linux update', async () => {
      const install = vi.fn().mockResolvedValue({ ok: true });
      window.__GEZEL__ = {
        ...window.__GEZEL__,
        platform: 'linux',
        update: {
          state: vi.fn().mockResolvedValue({ kind: 'available', version: '1.26224.48' }),
          install,
          onStateChanged: vi.fn(),
        },
      } as never;

      render(<SettingsView />);
      fireEvent.click(await screen.findByTestId('settings-nav-about'));

      const available = await screen.findByTestId('settings-notice-update-available');
      expect(available).toHaveTextContent('Linux updates are notification-only');
      expect(available).toHaveTextContent('verify its SLSA build provenance');
      expect(screen.queryByRole('button', { name: /install/i })).not.toBeInTheDocument();
      expect(install).not.toHaveBeenCalled();
      expect(
        screen.getByRole('link', { name: /open release and verification steps/i }),
      ).toHaveAttribute('href', 'https://github.com/bendyline/gezel/releases/tag/v1.26224.48');
    });
  });

  it('shows all local engine tabs with Mac-specific labels by default', async () => {
    window.__GEZEL__ = { ...window.__GEZEL__, token: 'test-token', platform: 'darwin' };
    vi.mocked(api.getConfig).mockResolvedValue({
      provider: 'mock',
      ds4BaseUrl: 'http://127.0.0.1:58585',
      meesterGezelId: 'gz-meester',
      hasGithubToken: true,
    } as never);

    render(<SettingsView />);

    expect(await screen.findByRole('button', { name: 'This Mac (Apple MLX)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'This Mac (llama)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'This Mac (DwarfStar - DS4)' })).toBeInTheDocument();
  });

  it('uses the same Mac engine names in the default and Night Shift provider trays', async () => {
    window.__GEZEL__ = { ...window.__GEZEL__, token: 'test-token', platform: 'darwin' };
    vi.mocked(api.getConfig).mockResolvedValue({
      provider: 'mlx',
      ds4BaseUrl: 'http://127.0.0.1:58585',
      meesterGezelId: 'gz-meester',
      hasGithubToken: true,
      nightShift: {
        modelOverride: { enabled: true, provider: 'ds4', model: 'deepseek-v4-flash' },
      },
    } as never);

    render(<SettingsView />);
    fireEvent.click(await screen.findByRole('button', { name: /^Artificial Intelligence/ }));

    const expected = ['This Mac (Apple MLX)', 'This Mac (llama)', 'This Mac (DwarfStar - DS4)'];
    const defaultTray = within(await screen.findByTestId('default-provider-switch'));
    const nightShiftTray = within(
      await screen.findByRole('radiogroup', { name: 'Night Shift provider' }),
    );
    for (const label of expected) {
      expect(defaultTray.getByRole('button', { name: label })).toBeInTheDocument();
      expect(nightShiftTray.getByRole('radio', { name: label })).toBeInTheDocument();
    }
  });

  it('names the default engine and model under the Artificial Intelligence header', async () => {
    window.__GEZEL__ = { ...window.__GEZEL__, token: 'test-token', platform: 'darwin' };
    vi.mocked(api.getConfig).mockResolvedValue({
      provider: 'mlx',
      defaultModel: { mlx: 'qwen3.8-27b-q4' },
      meesterGezelId: 'gz-meester',
      hasGithubToken: true,
    } as never);
    vi.mocked(api.listMlxModels).mockResolvedValue({
      models: [
        { id: 'gemma4-26b-q4', name: 'Gemma 4 (26B, Q4)' },
        { id: 'qwen3.8-27b-q4', name: 'Qwen 3.8 (27B, Q4)' },
      ],
    } as never);

    render(<SettingsView />);

    const header = await screen.findByTestId('settings-nav-defaults');
    await waitFor(() => expect(header).toHaveTextContent('Default: This Mac · Qwen 3.8'));
  });

  it('falls back to the first installed model when no default is configured', async () => {
    window.__GEZEL__ = { ...window.__GEZEL__, token: 'test-token', platform: 'darwin' };
    vi.mocked(api.getConfig).mockResolvedValue({
      provider: 'mlx',
      meesterGezelId: 'gz-meester',
      hasGithubToken: true,
    } as never);
    vi.mocked(api.listMlxModels).mockResolvedValue({
      models: [{ id: 'gemma4-26b-q4', name: 'Gemma 4 (26B, Q4)' }],
    } as never);

    render(<SettingsView />);

    const header = await screen.findByTestId('settings-nav-defaults');
    await waitFor(() => expect(header).toHaveTextContent('Default: This Mac · Gemma 4'));
  });

  it('shows the default-model picker when llama.cpp is the default provider', async () => {
    const config = {
      provider: 'llama-cpp',
      defaultModel: { 'llama-cpp': 'qwen3.6-27b-q4' },
      meesterGezelId: 'gz-meester',
      hasGithubToken: true,
    };
    vi.mocked(api.getConfig).mockResolvedValue(config as never);
    vi.mocked(api.updateConfig).mockResolvedValue({
      ...config,
      defaultModel: { 'llama-cpp': 'llama-cpp-test-model' },
    } as never);

    render(<SettingsView />);
    fireEvent.click(await screen.findByRole('button', { name: /^Artificial Intelligence/ }));

    const picker = await screen.findByTestId('model-picker-llama-cpp');
    expect(picker).toBeInTheDocument();
    fireEvent.click(picker);

    await waitFor(() =>
      expect(api.updateConfig).toHaveBeenCalledWith({
        defaultModel: { 'llama-cpp': 'llama-cpp-test-model' },
      }),
    );
  });

  it('hides DwarfStar on Windows unless it has an external server or is selected', async () => {
    vi.mocked(api.getConfig).mockResolvedValue({
      provider: 'mock',
      ds4BaseUrl: 'http://127.0.0.1:58585',
      meesterGezelId: 'gz-meester',
      hasGithubToken: true,
    } as never);
    const { unmount } = render(<SettingsView />);
    expect(
      await screen.findByRole('button', { name: 'This PC (DwarfStar - DS4)' }),
    ).toBeInTheDocument();
    unmount();

    vi.mocked(api.getConfig).mockResolvedValue({
      provider: 'mock',
      meesterGezelId: 'gz-meester',
      hasGithubToken: true,
    } as never);
    window.__GEZEL__ = { ...window.__GEZEL__, token: 'test-token', platform: 'win32' };
    const windowsView = render(<SettingsView />);
    await waitFor(() => expect(api.getConfig).toHaveBeenCalled());
    expect(
      screen.queryByRole('button', { name: 'This PC (DwarfStar - DS4)' }),
    ).not.toBeInTheDocument();
    windowsView.unmount();

    vi.mocked(api.getConfig).mockResolvedValue({
      provider: 'ds4',
      meesterGezelId: 'gz-meester',
      hasGithubToken: true,
    } as never);
    render(<SettingsView />);
    expect(
      await screen.findByRole('button', { name: 'This PC (DwarfStar - DS4)' }),
    ).toBeInTheDocument();
  });

  it('only shows the night-shift wake option on macOS', async () => {
    const { unmount } = render(<SettingsView />);
    await waitFor(() => expect(api.getConfig).toHaveBeenCalled());
    expect(
      screen.queryByRole('checkbox', { name: 'Wake this machine when the window opens' }),
    ).not.toBeInTheDocument();
    unmount();

    window.__GEZEL__ = { ...window.__GEZEL__, token: 'test-token', platform: 'darwin' };
    render(<SettingsView />);
    expect(
      await screen.findByRole('checkbox', { name: 'Wake this machine when the window opens' }),
    ).toBeInTheDocument();
  });

  it('defaults the quota reserve to overall-on at 20% with per-day opt-in', async () => {
    render(<SettingsView />);
    const overallToggle = await screen.findByRole('checkbox', {
      name: 'Stop night work near my overall quota',
    });
    // Absent config = the protective default is already on.
    expect(overallToggle).toBeChecked();
    const overallPercent = screen.getByRole('spinbutton', { name: 'Overall quota floor percent' });
    expect(overallPercent).toHaveValue(20);
    expect(overallPercent).toBeEnabled();

    const perDayToggle = screen.getByRole('checkbox', {
      name: 'Reserve a share of my quota per day until reset',
    });
    expect(perDayToggle).not.toBeChecked();
    expect(screen.getByRole('spinbutton', { name: 'Daily quota reserve percent' })).toBeDisabled();
  });

  it('saves quota-reserve edits with the sibling rule intact', async () => {
    vi.mocked(api.getConfig).mockResolvedValue({
      provider: 'mock',
      meesterGezelId: 'gz-meester',
      hasGithubToken: true,
      nightShift: {
        quotaReserve: { perDay: { enabled: true, percent: 15 } },
      },
    } as never);
    render(<SettingsView />);

    const overallToggle = await screen.findByRole('checkbox', {
      name: 'Stop night work near my overall quota',
    });
    fireEvent.click(overallToggle); // on-by-default → unchecking writes enabled: false
    await waitFor(() =>
      expect(api.updateConfig).toHaveBeenCalledWith({
        nightShift: {
          quotaReserve: {
            perDay: { enabled: true, percent: 15 },
            overall: { enabled: false },
          },
        },
      }),
    );
  });

  it('clamps a quota percent typed past 100', async () => {
    render(<SettingsView />);
    const overallPercent = await screen.findByRole('spinbutton', {
      name: 'Overall quota floor percent',
    });
    fireEvent.change(overallPercent, { target: { value: '150' } });
    await waitFor(() =>
      expect(api.updateConfig).toHaveBeenCalledWith({
        nightShift: { quotaReserve: { overall: { percent: 100 } } },
      }),
    );
  });

  it('inherits the default AI model until the Night Shift override is enabled', async () => {
    const inheritedConfig = {
      provider: 'openai',
      defaultModel: { openai: 'gpt-day' },
      meesterGezelId: 'gz-meester',
      hasGithubToken: true,
    };
    vi.mocked(api.getConfig).mockResolvedValue(inheritedConfig as never);
    vi.mocked(api.updateConfig).mockResolvedValue({
      ...inheritedConfig,
      nightShift: {
        modelOverride: { enabled: true, provider: 'openai', model: 'gpt-day' },
      },
    } as never);
    const inherited = render(<SettingsView />);
    fireEvent.click(await screen.findByRole('button', { name: /^Artificial Intelligence/ }));
    const checkbox = await screen.findByRole('checkbox', {
      name: 'Use a specific model by default during Night Shift',
    });
    expect(checkbox).not.toBeChecked();
    expect(screen.queryByRole('radiogroup', { name: 'Night Shift provider' })).toBeNull();

    fireEvent.click(checkbox);
    await waitFor(() =>
      expect(api.updateConfig).toHaveBeenCalledWith({
        nightShift: {
          modelOverride: { enabled: true, provider: 'openai', model: 'gpt-day' },
        },
      }),
    );
    expect(
      await screen.findByRole('radiogroup', { name: 'Night Shift provider' }),
    ).toBeInTheDocument();
    inherited.unmount();

    vi.mocked(api.getConfig).mockResolvedValue({
      provider: 'copilot',
      meesterGezelId: 'gz-meester',
      hasGithubToken: true,
      nightShift: {
        modelOverride: { enabled: true, provider: 'openai', model: 'gpt-night' },
      },
    } as never);
    render(<SettingsView />);
    fireEvent.click(await screen.findByRole('button', { name: /^Artificial Intelligence/ }));

    expect(
      await screen.findByRole('checkbox', {
        name: 'Use a specific model by default during Night Shift',
      }),
    ).toBeChecked();
    expect(screen.getByRole('radiogroup', { name: 'Night Shift provider' })).toBeInTheDocument();
    expect(screen.getByTestId('model-picker-openai')).toBeInTheDocument();
  });

  /** The default-provider pill row, scoped so Night Shift's row can't match. */
  async function defaultProviderSwitch() {
    fireEvent.click(await screen.findByRole('button', { name: /^Artificial Intelligence/ }));
    return within(await screen.findByTestId('default-provider-switch'));
  }

  // Copilot's runtime is an opt-in download. Offering it as a default
  // provider before it exists on disk sets the user up to fail on their first
  // message, so the pill is gated on the availability probe.
  it('hides the GitHub Copilot provider pill when Copilot is not installed', async () => {
    vi.mocked(api.getCopilotStatus).mockResolvedValue(UNAVAILABLE as never);
    render(<SettingsView />);
    const pills = await defaultProviderSwitch();

    // Codex CLI proves the row rendered at all.
    expect(await pills.findByRole('button', { name: 'OpenAI Codex CLI' })).toBeInTheDocument();
    await waitFor(() => expect(pills.queryByRole('button', { name: 'GitHub Copilot' })).toBeNull());
  });

  // The API-key OpenAI and Anthropic surfaces are hidden until they've been
  // tested; the CLI-driven variants are untouched.
  it('hides the API-key OpenAI and Anthropic pills but keeps the CLI ones', async () => {
    render(<SettingsView />);
    const pills = await defaultProviderSwitch();

    expect(await pills.findByRole('button', { name: 'OpenAI Codex CLI' })).toBeInTheDocument();
    expect(pills.getByRole('button', { name: 'Anthropic Claude CLI' })).toBeInTheDocument();
    expect(pills.queryByRole('button', { name: 'OpenAI' })).toBeNull();
    expect(pills.queryByRole('button', { name: 'Anthropic Claude' })).toBeNull();
  });

  it('keeps the Anthropic pill when a key is already on file', async () => {
    vi.mocked(api.getConfig).mockResolvedValue({
      provider: 'mlx',
      meesterGezelId: 'gz-meester',
      hasAnthropicApiKey: true,
    } as never);
    render(<SettingsView />);
    const pills = await defaultProviderSwitch();

    // Never strand a configured user without the control to change it.
    expect(await pills.findByRole('button', { name: 'Anthropic Claude' })).toBeInTheDocument();
  });

  it('keeps the Copilot pill when Copilot is already the configured provider', async () => {
    vi.mocked(api.getConfig).mockResolvedValue({
      provider: 'copilot',
      meesterGezelId: 'gz-meester',
      hasGithubToken: true,
    } as never);
    vi.mocked(api.getCopilotStatus).mockResolvedValue(UNAVAILABLE as never);
    render(<SettingsView />);
    const pills = await defaultProviderSwitch();

    // Never strand a configured user without the control to change it.
    expect(await pills.findByRole('button', { name: 'GitHub Copilot' })).toBeInTheDocument();
  });

  it('offers the Copilot pill while availability is still unknown', async () => {
    // `null` means "not answered yet", not "unavailable" — treating it as the
    // latter makes the pill blink out on every mount.
    vi.mocked(api.getCopilotStatus).mockRejectedValue(new Error('older daemon'));
    render(<SettingsView />);
    const pills = await defaultProviderSwitch();

    expect(await pills.findByRole('button', { name: 'GitHub Copilot' })).toBeInTheDocument();
  });

  it('uses the compact settings text size for the Copilot sandbox checkbox', async () => {
    render(<SettingsView />);
    fireEvent.click(await screen.findByTestId('settings-nav-copilot'));

    const checkbox = await screen.findByRole('checkbox', {
      name: 'Sandbox Copilot to gezel tools only',
    });
    expect(checkbox.closest('label')).toHaveClass('muted');
    expect(checkbox.closest('label')).toHaveStyle({ fontSize: '0.9rem' });
  });

  it('describes Copilot PAT authentication as a GitHub token with Copilot scope', async () => {
    vi.mocked(api.getConfig).mockResolvedValue({
      provider: 'mock',
      meesterGezelId: 'gz-meester',
      hasGithubToken: true,
      githubToken: '********KzTe',
    } as never);

    render(<SettingsView />);
    fireEvent.click(await screen.findByTestId('settings-nav-copilot'));

    const heading = await screen.findByRole('heading', {
      name: /Alternative sign-in: GitHub token/,
    });
    const card = heading.closest('section');
    expect(card).not.toBeNull();
    expect(card).toHaveTextContent(
      'Use a classic GitHub personal access token with the copilot scope.',
    );
    expect(card).toHaveTextContent('<Stored GitHub token>');
    expect(card).not.toHaveTextContent('KzTe');
    expect(within(card as HTMLElement).getByPlaceholderText('Replace GitHub token…')).toBeVisible();
  });

  it('offers the expanded Codex CLI reasoning levels', async () => {
    vi.mocked(api.getConfig).mockResolvedValue({
      provider: 'codex-cli',
      meesterGezelId: 'gz-meester',
      hasGithubToken: true,
      defaultModel: { 'codex-cli': 'gpt-5.6-sol' },
      codexCli: { defaultReasoningEffort: 'max' },
      codexCliStatus: { installed: true, path: '/usr/local/bin/codex', version: '0.145.0' },
    } as never);
    vi.mocked(api.listProviderModels).mockResolvedValue({
      models: [
        {
          id: 'gpt-5.6-sol',
          name: 'gpt-5.6-sol — GPT-5.6 Sol',
          supportsReasoning: true,
          reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
          defaultReasoningEffort: 'low',
        },
        {
          id: 'gpt-5.5',
          name: 'gpt-5.5 — GPT-5.5',
          supportsReasoning: true,
          reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
          defaultReasoningEffort: 'medium',
        },
      ],
    } as never);

    render(<SettingsView />);
    fireEvent.click(await screen.findByTestId('settings-nav-codexCli'));

    expect(await screen.findByTestId('model-picker-codex-cli')).toBeInTheDocument();
    const effortTray = await screen.findByRole('radiogroup', { name: 'Reasoning effort' });
    expect(
      within(effortTray).getByRole('radio', { name: 'Model default (Low)' }),
    ).toBeInTheDocument();
    expect(within(effortTray).queryByRole('radio', { name: 'Minimal' })).toBeNull();
    expect(within(effortTray).getByRole('radio', { name: 'Extra high' })).toBeInTheDocument();
    expect(within(effortTray).getByRole('radio', { name: 'Maximum' })).toBeChecked();
    expect(within(effortTray).getByRole('radio', { name: 'Ultra' })).toBeInTheDocument();
    expect(screen.queryByText(/model_reasoning_effort/)).toBeNull();
    expect(screen.getByText('Gezel tools')).toBeInTheDocument();
    expect(
      screen.getByRole('checkbox', {
        name: 'Add Gezel tools like search, memories, tasks, and team coordination to Codex',
      }),
    ).toBeChecked();
    expect(
      screen.getByText('Disable to run Codex with only its built-in tools.'),
    ).toBeInTheDocument();
  });

  it('shows the Codex effort tray when the model uses Gezel’s default', async () => {
    vi.mocked(api.getConfig).mockResolvedValue({
      provider: 'codex-cli',
      meesterGezelId: 'gz-meester',
      hasGithubToken: true,
      codexCliStatus: { installed: true, path: '/usr/local/bin/codex', version: '0.145.0' },
    } as never);
    vi.mocked(api.listProviderModels).mockResolvedValue({
      models: [
        {
          id: 'gpt-5.5',
          name: 'gpt-5.5 — GPT-5.5',
          supportsReasoning: true,
          reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
          defaultReasoningEffort: 'medium',
        },
      ],
    } as never);

    render(<SettingsView />);
    fireEvent.click(await screen.findByTestId('settings-nav-codexCli'));

    const effortTray = await screen.findByRole('radiogroup', { name: 'Reasoning effort' });
    expect(within(effortTray).getByRole('radio', { name: 'Model default (Medium)' })).toBeChecked();
    expect(within(effortTray).getByRole('radio', { name: 'Low' })).toBeInTheDocument();
    expect(within(effortTray).getByRole('radio', { name: 'Extra high' })).toBeInTheDocument();
  });

  it('offers model-specific Claude CLI reasoning levels', async () => {
    vi.mocked(api.getConfig).mockResolvedValue({
      provider: 'anthropic-cli',
      meesterGezelId: 'gz-meester',
      hasGithubToken: true,
      defaultModel: { 'anthropic-cli': 'opus' },
      defaultReasoningEffort: { 'anthropic-cli': 'xhigh' },
      anthropicCliStatus: { installed: true, path: '/usr/local/bin/claude', version: '2.1.144' },
    } as never);
    vi.mocked(api.listProviderModels).mockResolvedValue({
      models: [
        {
          id: 'opus',
          name: 'opus — Latest Claude Opus',
          supportsReasoning: true,
          reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
          defaultReasoningEffort: 'xhigh',
        },
      ],
    } as never);

    render(<SettingsView />);
    fireEvent.click(await screen.findByTestId('settings-nav-anthropicCli'));

    expect(await screen.findByTestId('model-picker-anthropic-cli')).toBeInTheDocument();
    const effortSelect = await screen.findByDisplayValue('xhigh');
    expect(
      within(effortSelect).getByRole('option', { name: 'Default (xhigh)' }),
    ).toBeInTheDocument();
    expect(within(effortSelect).getByRole('option', { name: 'low' })).toBeInTheDocument();
    expect(within(effortSelect).getByRole('option', { name: 'max' })).toBeInTheDocument();
    expect(within(effortSelect).queryByRole('option', { name: 'ultra' })).toBeNull();
  });

  it('offers human-readable Claude permission choices in a tray', async () => {
    vi.mocked(api.getConfig).mockResolvedValue({
      provider: 'anthropic-cli',
      meesterGezelId: 'gz-meester',
      hasGithubToken: true,
      anthropicCli: { defaultPermissionMode: 'acceptEdits' },
    } as never);
    vi.mocked(api.updateConfig).mockResolvedValue({
      provider: 'anthropic-cli',
      meesterGezelId: 'gz-meester',
      anthropicCli: { defaultPermissionMode: 'bypassPermissions' },
    } as never);

    render(<SettingsView />);
    fireEvent.click(await screen.findByTestId('settings-nav-anthropicCli'));

    const tray = await screen.findByRole('radiogroup', { name: 'Default permission' });
    expect(within(tray).getByRole('radio', { name: /Accept edits/i })).toBeChecked();
    expect(within(tray).getByText('Read and review without making changes.')).toBeInTheDocument();
    expect(within(tray).queryByText('bypassPermissions')).toBeNull();
    expect(screen.getByText('Gezel tools')).toBeInTheDocument();
    expect(
      screen.getByRole('checkbox', {
        name: 'Add Gezel tools like search, memories, tasks, and team coordination to Claude',
      }),
    ).toBeChecked();
    expect(
      screen.getByText('Disable to run Claude with only its built-in tools.'),
    ).toBeInTheDocument();

    fireEvent.click(within(tray).getByRole('radio', { name: /Full access/i }));

    await waitFor(() =>
      expect(api.updateConfig).toHaveBeenCalledWith({
        anthropicCli: { defaultPermissionMode: 'bypassPermissions' },
      }),
    );
  });

  it('lists gezellen for the Meester picker', async () => {
    render(<SettingsView />);
    await waitFor(() => {
      expect(api.listGezels).toHaveBeenCalled();
    });
  });

  it('shows the designated Boekwachter and explains project-level opt-in', async () => {
    render(<SettingsView />);
    fireEvent.click(await screen.findByTestId('settings-nav-team'));

    expect(await screen.findByTestId('boekwachter-settings')).toHaveTextContent(
      'A project with a Boekwachter on its assigned crew',
    );
    expect(screen.getByTestId('boekwachter-settings')).toHaveTextContent('Noor');
  });
});
