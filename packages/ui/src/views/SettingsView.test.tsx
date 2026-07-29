import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
vi.mock('../components/GithubDeviceCodeModal.js', () => ({ GithubDeviceCodeModal: () => null }));
vi.mock('../components/GithubSignInChip.js', () => ({ GithubSignInChip: () => null }));
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

describe('SettingsView', () => {
  beforeEach(() => {
    window.__GEZEL__ = {
      ...window.__GEZEL__,
      token: window.__GEZEL__?.token ?? 'test-token',
      platform: 'linux',
    };
    vi.mocked(api.getConfig).mockResolvedValue({
      provider: 'mock',
      meesterGezelId: 'gz-meester',
      hasGithubToken: true,
    } as never);
    vi.mocked(api.health).mockResolvedValue({
      ok: true,
      version: '0.1.0',
      platform: 'linux',
    } as never);
    vi.mocked(api.listGezels).mockResolvedValue({
      gezels: [{ id: 'gz-meester', name: 'Brigitte' }],
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

  it('lists gezels for the Meester picker', async () => {
    render(<SettingsView />);
    await waitFor(() => {
      expect(api.listGezels).toHaveBeenCalled();
    });
  });
});
