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
vi.mock('./OllamaSettings.js', () => ({ OllamaSettings: stub('ollama-settings') }));

vi.mock('../components/CacheControlsPanel.js', () => ({ CacheControlsPanel: () => null }));
vi.mock('../components/CatalogBrowser.js', () => ({ CatalogBrowser: () => null }));
vi.mock('../components/ConfirmDialog.js', () => ({ ConfirmDialog: () => null }));
vi.mock('../components/CopilotLoginCommand.js', () => ({ CopilotLoginCommand: () => null }));
vi.mock('../components/DeviceSummary.js', () => ({ DeviceSummary: () => null }));
vi.mock('../components/GezelIcon.js', () => ({ GezelIcon: () => null }));
vi.mock('../components/GithubDeviceCodeModal.js', () => ({ GitHubDeviceCodeModal: () => null }));
vi.mock('../components/GithubSignInChip.js', () => ({ GitHubSignInChip: () => null }));
vi.mock('../components/HealthStrip.js', () => ({ HealthStrip: () => null }));
vi.mock('../components/InstallModelTuningEditor.js', () => ({
  InstallModelTuningEditor: () => null,
}));
vi.mock('../components/ModelPicker.js', () => ({
  ModelPicker: ({ provider }: { provider: string }) => (
    <div data-testid={`model-picker-${provider}`} />
  ),
  EffortPicker: () => null,
}));
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
  });

  it('uses llama as the user-facing engine name on Mac', async () => {
    window.__GEZEL__ = { ...window.__GEZEL__, token: 'test-token', platform: 'darwin' };
    vi.mocked(api.getConfig).mockResolvedValue({
      provider: 'llama-cpp',
      meesterGezelId: 'gz-meester',
      hasGithubToken: true,
    } as never);

    render(<SettingsView />);

    expect(
      (await screen.findAllByRole('button', { name: 'On-device (llama)' })).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText('On-device (llama.cpp)')).not.toBeInTheDocument();
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
      await screen.findByRole('button', { name: 'On-device (DwarfStar - DS4)' }),
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
      screen.queryByRole('button', { name: 'On-device (DwarfStar - DS4)' }),
    ).not.toBeInTheDocument();
    windowsView.unmount();

    vi.mocked(api.getConfig).mockResolvedValue({
      provider: 'ds4',
      meesterGezelId: 'gz-meester',
      hasGithubToken: true,
    } as never);
    render(<SettingsView />);
    expect(
      await screen.findByRole('button', { name: 'On-device (DwarfStar - DS4)' }),
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
    fireEvent.click(await screen.findByRole('button', { name: 'Artificial Intelligence' }));
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
    fireEvent.click(await screen.findByRole('button', { name: 'Artificial Intelligence' }));

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
    fireEvent.click(await screen.findByRole('button', { name: 'Artificial Intelligence' }));
    return within(await screen.findByTestId('default-provider-switch'));
  }

  // Copilot's runtime is an opt-in download. Offering it as a default
  // provider before it exists on disk sets the user up to fail on their first
  // message, so the pill is gated on the availability probe.
  it('hides the GitHub Copilot provider pill when Copilot is not installed', async () => {
    vi.mocked(api.getCopilotStatus).mockResolvedValue(UNAVAILABLE as never);
    render(<SettingsView />);
    const pills = await defaultProviderSwitch();

    // OpenAI proves the row rendered at all.
    expect(await pills.findByRole('button', { name: 'OpenAI' })).toBeInTheDocument();
    await waitFor(() => expect(pills.queryByRole('button', { name: 'GitHub Copilot' })).toBeNull());
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
