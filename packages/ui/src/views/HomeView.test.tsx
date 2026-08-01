import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';
import { primitivesMock } from '../test-utils/primitivesMock.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));
vi.mock('../primitives/index.js', () => primitivesMock);

// Stub the streamAllChatEvents subscription so the chat surface doesn't try
// to open a real EventSource against jsdom's crippled fetch.
vi.mock('@bendyline/gezel-client', async () => {
  const actual =
    await vi.importActual<typeof import('@bendyline/gezel-client')>('@bendyline/gezel-client');
  return { ...actual, streamAllChatEvents: () => () => {} };
});

// Heavy chat + setup children are mocked to minimal stand-ins. These modules
// are pulled in by HomeWorkshop's conversation, not by HomeView directly —
// the module-level mocks apply regardless of the importer.
vi.mock('../components/ChatComposer.js', () => ({
  ChatComposer: () => <div data-testid="chat-composer">composer</div>,
}));
vi.mock('../components/ChatReferences.js', () => ({
  ChatReferences: ({
    children,
  }: {
    children: (cbs: {
      onToolActivity: () => void;
      onArtifactReference: () => void;
      onTaskReference: () => void;
    }) => React.ReactNode;
  }) => (
    <>
      {children({
        onToolActivity: () => {},
        onArtifactReference: () => {},
        onTaskReference: () => {},
      })}
    </>
  ),
}));
vi.mock('../components/CopilotLoginCommand.js', () => ({
  CopilotLoginCommand: () => null,
}));
vi.mock('../components/DeviceSummary.js', () => ({
  DeviceSummary: () => <div data-testid="device-summary">device</div>,
}));
vi.mock('../components/FirstRunInstallBanner.js', () => ({
  FirstRunInstallBanner: () => <div data-testid="first-run-install-banner" />,
}));
vi.mock('../components/GezelIcon.js', () => ({
  GezelIcon: ({ name, pulsing }: { name: string; pulsing?: boolean }) => (
    <span data-testid="gezel-icon" data-name={name} data-pulsing={pulsing ? 'true' : 'false'} />
  ),
}));
vi.mock('../components/GlobalTimeline.js', () => ({
  GlobalTimeline: () => <div data-testid="timeline" />,
}));
vi.mock('../components/HealthStrip.js', () => ({
  HealthStrip: () => null,
}));
vi.mock('../components/LlamaCppModelManager.js', () => ({
  LlamaCppModelManager: () => null,
}));
vi.mock('../components/MlxModelManager.js', () => ({
  MlxModelManager: () => null,
}));
vi.mock('../components/OllamaModelManager.js', () => ({
  OllamaModelManager: () => null,
}));
vi.mock('../components/SessionSwitcher.js', () => ({
  SessionSwitcher: () => null,
}));
// The embedded "What is gezel?" Handboek page pulls in the squisq doc
// renderers, which jsdom can't drive — it has its own test file.
vi.mock('./home/IntroHandboekArticle.js', () => ({
  IntroHandboekArticle: () => <div data-testid="home-intro-article">intro article</div>,
}));
// The standing meester figure renders a real Poppetje only when the meester
// has poppetje data; these tests leave it null (→ GezelIcon fallback), so we
// don't need to mock the Poppetje engine.

const { HomeView } = await import('./HomeView.js');
const { api } = await import('../api.js');
const { resetUpdateStateForTests } = await import('../update-state.js');

/** Configure a "warm + onboarded" state so HomeView renders the workshop. */
function onboard() {
  (window as unknown as { __GEZEL__: { mode?: string } }).__GEZEL__ = {
    ...(window as unknown as { __GEZEL__: Record<string, unknown> }).__GEZEL__,
    mode: 'remote',
  };
  vi.mocked(api.getConfig).mockResolvedValue({
    provider: 'copilot',
    hasGithubToken: true,
    meesterGezelId: 'gz-meester',
  } as never);
  vi.mocked(api.health).mockResolvedValue({
    ok: true,
    version: '0.1.0',
    platform: 'linux',
  } as never);
  vi.mocked(api.testProvider).mockResolvedValue({ ok: true, modelCount: 5 } as never);
  vi.mocked(api.listLlamaCppModels).mockResolvedValue({ models: [] } as never);
}

describe('HomeView', () => {
  beforeEach(() => {
    onboard();
    vi.mocked(api.listProjects).mockResolvedValue({
      projects: [{ id: 'default', name: 'default' }],
    } as never);
    vi.mocked(api.listGezels).mockResolvedValue({
      gezels: [{ id: 'gz-meester', name: 'Brigitte', icon: null }],
    } as never);
    // Reset per-test data sources to empty — vitest's clearMocks only clears
    // call history, not mockResolvedValue, so otherwise data leaks across tests.
    vi.mocked(api.listProjectTasks).mockResolvedValue({ tasks: [] } as never);
    vi.mocked(api.listQuestions).mockResolvedValue({ questions: [] } as never);
  });

  it('renders the workshop conversation once the probe resolves ok', async () => {
    render(<HomeView />);
    await waitFor(() => {
      expect(screen.getByTestId('home-workshop')).toBeInTheDocument();
    });
    expect(screen.getByTestId('chat-composer')).toBeInTheDocument();
  });

  // Service health is an install-health notice now — a quiet line in the
  // navigation rail under Settings, explained in Settings → About. Home was
  // the wrong home for it: not urgent, not fixable from here, and it pushed
  // the meester conversation down the screen on every launch.
  it('never puts a degraded-service banner on the home screen', async () => {
    const g = window as unknown as { __GEZEL__: Record<string, unknown> };
    const before = { ...g.__GEZEL__ };
    g.__GEZEL__ = {
      ...before,
      fallbackReason: 'System service was unavailable: SCM stopped',
      fallbackCode: 'system-service-unhealthy',
    };
    try {
      render(<HomeView platform="darwin" />);
      await screen.findByTestId('home-workshop');

      expect(screen.queryByText(/Background work/)).not.toBeInTheDocument();
      expect(screen.queryByText(/SCM stopped/)).not.toBeInTheDocument();
    } finally {
      g.__GEZEL__ = before;
    }
  });

  describe('update banner', () => {
    function stubUpdateBridge(state: unknown, install = vi.fn().mockResolvedValue({ ok: true })) {
      const bridge = {
        state: vi.fn().mockResolvedValue(state),
        install,
        onStateChanged: vi.fn(),
      };
      (window as unknown as { __GEZEL__: Record<string, unknown> }).__GEZEL__ = {
        ...(window as unknown as { __GEZEL__: Record<string, unknown> }).__GEZEL__,
        update: bridge,
      };
      return bridge;
    }

    beforeEach(() => {
      // The update state is a module-level store shared by the rail, Settings,
      // and this banner — drop what a previous test cached before restubbing.
      resetUpdateStateForTests();
    });

    afterEach(() => {
      const g = window as unknown as { __GEZEL__: Record<string, unknown> };
      g.__GEZEL__ = { ...g.__GEZEL__, update: undefined };
      resetUpdateStateForTests();
    });

    it('says nothing while there is no update', async () => {
      stubUpdateBridge(null);
      render(<HomeView />);
      await screen.findByTestId('home-workshop');
      expect(screen.queryByRole('button', { name: /install now/i })).not.toBeInTheDocument();
    });

    // A download in flight is not actionable, so it stays out of the way.
    it('stays quiet while downloading', async () => {
      stubUpdateBridge({ kind: 'downloading', version: '1.26212.4' });
      render(<HomeView />);
      await screen.findByTestId('home-workshop');
      expect(screen.queryByRole('button', { name: /install now/i })).not.toBeInTheDocument();
    });

    // Assert on the banner's whole text rather than per-string queries: the
    // headline interpolates the version, so React splits it across text nodes
    // and getByText's element-level matching does not see it as one sentence.
    it('warns that macOS will ask for an administrator password', async () => {
      stubUpdateBridge({ kind: 'ready', version: '1.26212.4' });
      render(<HomeView platform="darwin" />);

      const banner = await screen.findByTestId('update-banner');
      expect(banner).toHaveTextContent('Gezel 1.26212.4 is ready to install.');
      expect(banner).toHaveTextContent('ask for an administrator password');
    });

    it('tells Windows and Linux users the app restarts instead', async () => {
      stubUpdateBridge({ kind: 'ready', version: '1.26212.4' });
      render(<HomeView platform="win32" />);

      const banner = await screen.findByTestId('update-banner');
      expect(banner).toHaveTextContent('Gezel will restart to finish installing.');
      expect(banner).not.toHaveTextContent('administrator password');
    });

    it('hands the install to the shell when asked', async () => {
      const install = vi.fn().mockResolvedValue({ ok: true });
      stubUpdateBridge({ kind: 'ready', version: '1.26212.4' }, install);
      render(<HomeView platform="darwin" />);

      fireEvent.click(await screen.findByRole('button', { name: /install now/i }));
      await waitFor(() => expect(install).toHaveBeenCalledTimes(1));
    });

    // Failures are install-health notices, not banners. A failed check is the
    // ordinary offline case and must never interrupt the home screen; a failed
    // install is real but still belongs in Settings → About.
    it('keeps update failures off the home screen', async () => {
      stubUpdateBridge({
        kind: 'error',
        stage: 'install',
        version: '1.26212.4',
        message: 'Gatekeeper rejected the package',
      });
      render(<HomeView platform="darwin" />);
      await screen.findByTestId('home-workshop');

      expect(screen.queryByTestId('update-banner')).not.toBeInTheDocument();
      expect(screen.queryByText(/Gatekeeper rejected the package/)).not.toBeInTheDocument();
    });
  });

  it('holds the loading splash while the probe is in flight — never flashes First run setup', async () => {
    // A probe that stays pending lets us inspect the intermediate state. The
    // regression this guards: a slow cold-boot probe used to drop the splash
    // early and render "First run setup" for seconds before flipping to chat.
    let resolveProbe!: (v: unknown) => void;
    vi.mocked(api.testProvider).mockReturnValue(
      new Promise((res) => {
        resolveProbe = res;
      }) as never,
    );
    vi.mocked(api.getConfig).mockResolvedValue({
      provider: 'llama-cpp',
      meesterGezelId: 'gz-meester',
    } as never);

    render(<HomeView />);

    // While the probe hasn't resolved: the loading splash, not the onboarding
    // form and not the workshop.
    await screen.findByText(/Loading/);
    expect(screen.queryByText('First run setup')).not.toBeInTheDocument();
    expect(screen.queryByTestId('home-workshop')).not.toBeInTheDocument();

    // Probe lands ok → straight to the workshop, with no first-run in between.
    resolveProbe({ ok: true, modelCount: 3 });
    await waitFor(() => {
      expect(screen.getByTestId('home-workshop')).toBeInTheDocument();
    });
    expect(screen.queryByText('First run setup')).not.toBeInTheDocument();
  });

  it.each(['mlx', 'llama-cpp'] as const)(
    'keeps a healthy %s engine with no installed models in first run',
    async (provider) => {
      vi.mocked(api.getConfig).mockResolvedValue({
        provider,
        meesterGezelId: 'gz-meester',
        defaultModel: { [provider]: 'recommended-model' },
      } as never);
      vi.mocked(api.testProvider).mockResolvedValue({ ok: true, modelCount: 0 } as never);

      render(<HomeView />);

      expect(await screen.findByText('First run setup')).toBeInTheDocument();
      expect(screen.getByTestId('first-run-install-banner')).toBeInTheDocument();
      expect(screen.queryByTestId('home-workshop')).not.toBeInTheDocument();
    },
  );

  it('does not require a locally installed model when a cloud provider is connected', async () => {
    vi.mocked(api.testProvider).mockResolvedValue({ ok: true, modelCount: 0 } as never);

    render(<HomeView />);

    expect(await screen.findByTestId('home-workshop')).toBeInTheDocument();
    expect(screen.queryByText('First run setup')).not.toBeInTheDocument();
  });

  it('first run is local-only: shows the on-device engine link, not the provider picker', async () => {
    // Not configured (probe fails) → the onboarding layout renders.
    vi.mocked(api.getConfig).mockResolvedValue({
      provider: 'copilot',
      hasGithubToken: false,
      meesterGezelId: 'gz-meester',
    } as never);
    vi.mocked(api.testProvider).mockResolvedValue({ ok: false, error: 'not signed in' } as never);
    vi.mocked(api.health).mockResolvedValue({
      ok: true,
      version: '0.1.0',
      platform: 'win32',
    } as never);

    render(<HomeView />);

    const link = await screen.findByRole('button', { name: /Manage Chat AI Models/ });
    expect(link).toBeInTheDocument();
    // The intro copy is the embedded Handboek article, not hardcoded prose.
    expect(screen.getByTestId('home-intro-article')).toBeInTheDocument();
    expect(screen.queryByText(/AI-powered teammate/)).not.toBeInTheDocument();
    // The removed model-picking experience: no "Connect an AI model provider"
    // section, no provider tabs.
    expect(screen.queryByText(/Connect an AI model provider/)).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /GitHub Copilot/ })).not.toBeInTheDocument();

    // Clicking deep-links to the on-device engine settings section
    // (llamaCpp on non-mac, mlx on mac).
    const events: CustomEvent[] = [];
    const handler = (e: Event) => events.push(e as CustomEvent);
    window.addEventListener('gezel:navigate', handler);
    fireEvent.click(link);
    window.removeEventListener('gezel:navigate', handler);
    expect(events.at(-1)?.detail).toEqual({ view: 'settings', section: 'llamaCpp' });
  });

  it('first run puts setup above the intro article', async () => {
    // The download affordance has to own the top of the screen; the "what is
    // gezel?" pitch is reading material for after.
    vi.mocked(api.getConfig).mockResolvedValue({
      provider: 'copilot',
      hasGithubToken: false,
      meesterGezelId: 'gz-meester',
    } as never);
    vi.mocked(api.testProvider).mockResolvedValue({ ok: false, error: 'not signed in' } as never);
    vi.mocked(api.health).mockResolvedValue({
      ok: true,
      version: '0.1.0',
      platform: 'win32',
    } as never);

    render(<HomeView />);

    const heading = await screen.findByText('First run setup');
    const intro = screen.getByTestId('home-intro-article');
    expect(heading.compareDocumentPosition(intro) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('first run offers "Boring mode" — one toggle over names + avatars', async () => {
    vi.mocked(api.getConfig).mockResolvedValue({
      provider: 'copilot',
      hasGithubToken: false,
      meesterGezelId: 'gz-meester',
    } as never);
    vi.mocked(api.testProvider).mockResolvedValue({ ok: false, error: 'not signed in' } as never);
    vi.mocked(api.updateConfig).mockResolvedValue({} as never);

    render(<HomeView />);

    const checkbox = await screen.findByRole('checkbox', { name: /Boring mode/ });
    expect(checkbox).not.toBeChecked();

    // Checking it disables names (role-based only) AND avatars in one write.
    fireEvent.click(checkbox);
    await waitFor(() => {
      expect(api.updateConfig).toHaveBeenCalledWith({
        roleBasedNameOnlyMode: true,
        showPoppetjes: false,
      });
    });
  });

  it('loads health, config, and projects on mount', async () => {
    render(<HomeView />);
    await waitFor(() => {
      expect(api.health).toHaveBeenCalled();
    });
    expect(api.getConfig).toHaveBeenCalled();
    expect(api.listProjects).toHaveBeenCalled();
  });

  it('greets with the time of day and no Meester heading', async () => {
    render(<HomeView />);
    await waitFor(() => {
      expect(screen.getByText(/^Good (morning|afternoon|evening)\.$/)).toBeInTheDocument();
    });
    // The old "Meester <name>" section heading is gone in the refresh.
    expect(screen.queryByRole('heading', { name: /Meester/i })).not.toBeInTheDocument();
  });

  it('runs the provider probe automatically for Copilot when configured', async () => {
    render(<HomeView />);
    await waitFor(() => {
      expect(api.testProvider).toHaveBeenCalledWith('copilot');
    });
  });

  it('skips the auto-probe when openai is selected without a key', async () => {
    vi.mocked(api.getConfig).mockResolvedValue({
      provider: 'openai',
      hasOpenaiApiKey: false,
    } as never);
    render(<HomeView />);
    await waitFor(() => {
      expect(api.getConfig).toHaveBeenCalled();
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(api.testProvider).not.toHaveBeenCalled();
  });

  it('does not render or poll the crew rail', async () => {
    render(<HomeView />);
    await waitFor(() => {
      expect(screen.getByTestId('home-workshop')).toBeInTheDocument();
    });
    expect(screen.queryByText('The crew today')).not.toBeInTheDocument();
    expect(api.getQueueStatus).not.toHaveBeenCalled();
  });

  it('tracks active-project jobs for status without rendering a jobs rail', async () => {
    vi.mocked(api.listProjects).mockResolvedValue({
      projects: [{ id: 'proj-1', name: 'Choplifter' }],
    } as never);
    const now = new Date().toISOString();
    vi.mocked(api.listProjectTasks).mockResolvedValue({
      tasks: [
        {
          ref: 'proj-1/1',
          projectId: 'proj-1',
          num: 1,
          title: 'Helicopter lift feels floaty',
          status: 'active',
          assignee: { kind: 'gezel', gezelId: 'gz-2' },
          createdAt: now,
        },
        {
          ref: 'proj-1/2',
          projectId: 'proj-1',
          num: 2,
          title: 'Rescued hostages do not board',
          status: 'paused',
          assignee: { kind: 'user' },
          createdAt: now,
        },
        {
          ref: 'proj-1/3',
          projectId: 'proj-1',
          num: 3,
          title: 'Add enemy tank fire',
          status: 'complete',
          assignee: { kind: 'user' },
          createdAt: now,
        },
      ],
    } as never);
    render(<HomeView />);
    await waitFor(() => {
      expect(api.listProjectTasks).toHaveBeenCalledWith('proj-1');
      expect(screen.getByText('1 waiting on you')).toBeInTheDocument();
    });
    expect(screen.queryByText(/^Jobs in /)).not.toBeInTheDocument();
    expect(screen.queryByText('Helicopter lift feels floaty')).not.toBeInTheDocument();
  });

  it('does not render the workshop side rail', async () => {
    vi.mocked(api.listProjects).mockResolvedValue({
      projects: [
        { id: 'default', name: 'default' },
        { id: 'proj-1', name: 'Choplifter' },
      ],
    } as never);
    render(<HomeView />);
    await waitFor(() => {
      expect(screen.getByTestId('home-workshop')).toBeInTheDocument();
    });
    expect(screen.queryByText('On your bench')).not.toBeInTheDocument();
    expect(screen.queryByText('The crew today')).not.toBeInTheDocument();
    expect(screen.queryByText(/^Jobs in /)).not.toBeInTheDocument();
    expect(document.querySelector('.home-workshop-rail')).not.toBeInTheDocument();
  });

  it('tracks pending questions without rendering an approval rail card', async () => {
    vi.mocked(api.listQuestions).mockResolvedValue({
      questions: [
        {
          id: 'q1',
          projectId: 'default',
          gezelId: 'gz-meester',
          sessionId: 's1',
          prompt: 'Run npx tsx to check the frame timing?',
          createdAt: new Date().toISOString(),
        },
      ],
    } as never);
    render(<HomeView />);
    await waitFor(() => {
      expect(screen.getByText('1 waiting on you')).toBeInTheDocument();
    });
    expect(screen.queryByText('Awaiting your nod')).not.toBeInTheDocument();
    expect(screen.queryByText('Run npx tsx to check the frame timing?')).not.toBeInTheDocument();
  });

  it('reflects status chips from projects and pending questions', async () => {
    vi.mocked(api.listProjects).mockResolvedValue({
      projects: [
        { id: 'default', name: 'default' },
        { id: 'proj-1', name: 'Choplifter' },
      ],
    } as never);
    vi.mocked(api.listQuestions).mockResolvedValue({
      questions: [
        {
          id: 'q1',
          projectId: 'proj-1',
          gezelId: 'gz-meester',
          sessionId: 's1',
          prompt: 'Approve?',
          createdAt: new Date().toISOString(),
        },
      ],
    } as never);
    render(<HomeView />);
    // Chips arrive from three independent async sources (config, projects,
    // questions). "Ready to work" lands as soon as the probe resolves —
    // before listQuestions necessarily settles — so the "1 waiting on you"
    // chip can race the synchronous reads below. Wait for the last-to-
    // arrive chip and assert the rest from the same settled DOM.
    await waitFor(() => {
      expect(screen.getByText('1 waiting on you')).toBeInTheDocument();
    });
    expect(screen.getByText('Ready to work')).toBeInTheDocument();
    expect(screen.getByText('Choplifter on the bench')).toBeInTheDocument();
    expect(screen.getByText('2 projects open')).toBeInTheDocument();
  });

  it('collapses and expands the greeting band, persisting the preference', async () => {
    render(<HomeView />);
    await waitFor(() => {
      expect(screen.getByText('Tip of the day')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Collapse the greeting' }));
    expect(screen.queryByText('Tip of the day')).not.toBeInTheDocument();
    // The collapse preference is written through to server config so it
    // survives a relaunch (localStorage strands across the port shuffle).
    expect(api.updateConfig).toHaveBeenCalledWith({ homeGreetingCollapsed: true });
    fireEvent.click(screen.getByRole('button', { name: 'Expand the greeting' }));
    expect(screen.getByText('Tip of the day')).toBeInTheDocument();
    expect(api.updateConfig).toHaveBeenCalledWith({ homeGreetingCollapsed: false });
  });

  it('starts collapsed when the saved preference says so', async () => {
    vi.mocked(api.getConfig).mockResolvedValue({
      provider: 'copilot',
      hasGithubToken: true,
      meesterGezelId: 'gz-meester',
      homeGreetingCollapsed: true,
    } as never);
    render(<HomeView />);
    // Once config loads, the band reconciles to collapsed — the tip is
    // hidden and the Expand affordance is shown.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Expand the greeting' })).toBeInTheDocument();
    });
    expect(screen.queryByText('Tip of the day')).not.toBeInTheDocument();
  });

  it('switches to the "what is gezel" tour tab', async () => {
    render(<HomeView />);
    const tourName = 'New here? What is gezel';
    await waitFor(() => {
      expect(screen.getByText('Tip of the day')).toBeInTheDocument();
    });
    const tourTab = screen.getByRole('tab', { name: tourName });
    expect(tourTab).toHaveAttribute('aria-selected', 'false');
    fireEvent.click(tourTab);
    // The tour content replaces the greeting + tip in the left column.
    expect(tourTab).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByText('Tip of the day')).not.toBeInTheDocument();
    expect(screen.getByTestId('home-intro-article')).toBeInTheDocument();
  });

  it('cycles the tip of the day', async () => {
    render(<HomeView />);
    await waitFor(() => {
      expect(screen.getByText(/Most of getting great work/)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Show another tip' }));
    expect(screen.getByText(/Teach a gezel once/)).toBeInTheDocument();
  });
});
