import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';
import { primitivesMock } from '../test-utils/primitivesMock.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));
vi.mock('../primitives/index.js', () => primitivesMock);

// A pushable stand-in for the global SSE stream, so tests can fire the
// envelopes Home listens to (question/task lifecycle) without a network.
const events = vi.hoisted(() => {
  interface Consumer {
    pending: unknown[];
    wake: (() => void) | null;
  }
  const consumers = new Set<Consumer>();
  return {
    push(envelope: unknown) {
      for (const c of consumers) {
        c.pending.push(envelope);
        c.wake?.();
        c.wake = null;
      }
    },
    async *consume(): AsyncGenerator<unknown> {
      const self: Consumer = { pending: [], wake: null };
      consumers.add(self);
      try {
        while (true) {
          while (self.pending.length > 0) yield self.pending.shift();
          await new Promise<void>((resolve) => {
            self.wake = resolve;
          });
        }
      } finally {
        consumers.delete(self);
      }
    },
  };
});
vi.mock('../shared-chat-events.js', () => ({
  streamSharedAllChatEvents: () => events.consume(),
}));

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
  ChatComposer: ({
    onTurnStateChange,
  }: {
    onTurnStateChange?: (state: 'idle' | 'streaming') => void;
  }) => (
    <div data-testid="chat-composer">
      composer
      <button type="button" onClick={() => onTurnStateChange?.('streaming')}>
        mock send
      </button>
    </div>
  ),
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
// Most tests want a conversation that is not empty, so the meester's
// introduction stays out of them unless a test asks for it.
const timeline = vi.hoisted(() => ({ empty: false }));
vi.mock('../components/GlobalTimeline.js', () => ({
  GlobalTimeline: ({ emptyContent }: { emptyContent?: import('react').ReactNode }) => (
    <div data-testid="timeline">{timeline.empty ? emptyContent : null}</div>
  ),
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
const { HomeWorkshop } = await import('./home/HomeWorkshop.js');
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
      expect(
        screen.queryByRole('button', { name: /install|open installer/i }),
      ).not.toBeInTheDocument();
    });

    // A download in flight is not actionable, so it stays out of the way.
    it('stays quiet while downloading', async () => {
      stubUpdateBridge({ kind: 'downloading', version: '1.26212.4' });
      render(<HomeView />);
      await screen.findByTestId('home-workshop');
      expect(
        screen.queryByRole('button', { name: /install|open installer/i }),
      ).not.toBeInTheDocument();
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

    it('tells Windows users that a complete quit applies the signed update', async () => {
      stubUpdateBridge({ kind: 'ready', version: '1.26212.4' });
      render(<HomeView platform="win32" />);

      const banner = await screen.findByTestId('update-banner');
      expect(banner).toHaveTextContent('install automatically after you quit Gezel completely');
      expect(banner).toHaveTextContent('system tray');
      expect(banner).not.toHaveTextContent('administrator password');
      expect(screen.getByRole('button', { name: /install and restart/i })).toBeInTheDocument();
    });

    it('keeps Linux notification-only and links to the exact release', async () => {
      const install = vi.fn().mockResolvedValue({ ok: true });
      stubUpdateBridge({ kind: 'available', version: '1.26212.4' }, install);
      render(<HomeView platform="linux" />);

      const banner = await screen.findByTestId('update-banner');
      expect(banner).toHaveTextContent('Gezel 1.26212.4 is available.');
      expect(banner).toHaveTextContent('Linux updates are installed manually');
      expect(banner).toHaveTextContent('verify its SLSA build provenance');
      expect(screen.queryByRole('button', { name: /install/i })).not.toBeInTheDocument();
      expect(install).not.toHaveBeenCalled();
      expect(
        screen.getByRole('link', { name: /open release and verification steps/i }),
      ).toHaveAttribute('href', 'https://github.com/bendyline/gezel/releases/tag/v1.26212.4');
    });

    it('hands the install to the shell when asked', async () => {
      const install = vi.fn().mockResolvedValue({ ok: true });
      stubUpdateBridge({ kind: 'ready', version: '1.26212.4' }, install);
      render(<HomeView platform="darwin" />);

      fireEvent.click(await screen.findByRole('button', { name: /open installer/i }));
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
    // …and nothing first-run-flavoured either. The splash used to render the
    // full intro plus the "What is gezel?" article, which flashed past on
    // every boot of a configured install before the workshop took over.
    expect(screen.queryByTestId('home-intro-article')).not.toBeInTheDocument();

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

  it('uses the shared first-run page for native models and leaves setup when a selected model is ready', async () => {
    const bridge = window.__GEZEL__;
    const renderModelSettings = vi.fn(() => <div>Native model download controls</div>);
    window.__GEZEL__ = { ...bridge!, renderModelSettings };
    vi.mocked(api.getConfig).mockResolvedValue({
      provider: 'llama-cpp',
      meesterGezelId: 'gz-meester',
    } as never);
    vi.mocked(api.testProvider).mockResolvedValue({
      ok: false,
      error: 'Choose a chat model',
    } as never);
    try {
      render(<HomeView platform="mobile" />);
      expect(await screen.findByText('First run setup')).toBeVisible();
      expect(screen.getByText('Native model download controls')).toBeVisible();
      expect(renderModelSettings).toHaveBeenCalledWith({ setup: true });
      expect(screen.queryByTestId('home-intro-article')).not.toBeInTheDocument();
      expect(screen.getByText('Preferences')).toBeVisible();
      expect(screen.queryByTestId('chat-composer')).not.toBeInTheDocument();
      vi.mocked(api.testProvider).mockResolvedValue({ ok: true, modelCount: 1 } as never);
      fireEvent(window, new CustomEvent('gezel:config-updated'));
      expect(await screen.findByTestId('home-workshop')).toBeInTheDocument();
      expect(screen.queryByText('First run setup')).not.toBeInTheDocument();
    } finally {
      window.__GEZEL__ = bridge;
    }
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

    const link = await screen.findByRole('button', { name: /Manage AI models in Settings/ });
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

  it('first run offers "Show gezel names and poppetjes" below the security posture', async () => {
    vi.mocked(api.getConfig).mockResolvedValue({
      provider: 'copilot',
      hasGithubToken: false,
      meesterGezelId: 'gz-meester',
    } as never);
    vi.mocked(api.testProvider).mockResolvedValue({ ok: false, error: 'not signed in' } as never);
    vi.mocked(api.updateConfig).mockResolvedValue({} as never);

    render(<HomeView />);

    // Positive framing, on by default — the old "Boring mode" in-joke led the
    // section and sat above the security posture (2026-09-02 UX review).
    const checkbox = await screen.findByRole('checkbox', {
      name: /Show gezel names and poppetjes/,
    });
    expect(checkbox).toBeChecked();

    // The consequential choice (security posture) comes first on the page.
    const security = screen.getByRole('radiogroup', { name: 'Security posture' });
    expect(
      security.compareDocumentPosition(checkbox) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    // Unchecking flips to role-based names AND letter avatars in one write.
    fireEvent.click(checkbox);
    await waitFor(() => {
      expect(api.updateConfig).toHaveBeenCalledWith({
        roleBasedNameOnlyMode: true,
        showPoppetjes: false,
      });
    });
  });

  it('first run shows the relevance check as on for a new install and lets the person turn it off', async () => {
    vi.mocked(api.getConfig).mockResolvedValue({
      provider: 'copilot',
      hasGithubToken: false,
      meesterGezelId: 'gz-meester',
      relevanceModel: { enabled: true },
    } as never);
    vi.mocked(api.testProvider).mockResolvedValue({ ok: false, error: 'not signed in' } as never);
    vi.mocked(api.updateConfig).mockResolvedValue({} as never);

    render(<HomeView />);

    const checkbox = await screen.findByRole('checkbox', {
      name: /Check that reference material is on topic/,
    });
    expect(checkbox).toBeChecked();
    fireEvent.click(checkbox);
    await waitFor(() => {
      expect(api.updateConfig).toHaveBeenCalledWith({ relevanceModel: { enabled: false } });
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

  it('does not count the shared library indexing job on a new Home', async () => {
    vi.mocked(api.listProjects).mockResolvedValue({
      projects: [
        { id: 'default', name: 'Default' },
        {
          id: 'shared',
          name: 'Shared Library',
          properties: { 'gezel.sharedLibrary': '1' },
        },
      ],
    } as never);
    vi.mocked(api.listProjectTasks).mockImplementation(
      async (projectId) =>
        ({
          tasks:
            projectId === 'shared'
              ? [
                  {
                    ref: 'shared/1',
                    projectId: 'shared',
                    status: 'active',
                    assignee: { kind: 'user' },
                    origin: { kind: 'system-job', jobId: 'boekwachter-indexing' },
                  },
                ]
              : [],
        }) as never,
    );

    render(<HomeView />);
    await waitFor(() => expect(api.listProjectTasks).toHaveBeenCalledWith('default'));
    expect(api.listProjectTasks).not.toHaveBeenCalledWith('shared');
    expect(screen.queryByText('1 waiting on you')).not.toBeInTheDocument();
  });

  it('does not count a legacy system job kept in Default as pending user work', async () => {
    vi.mocked(api.listProjectTasks).mockResolvedValue({
      tasks: [
        {
          ref: 'default/1',
          projectId: 'default',
          status: 'active',
          assignee: { kind: 'user' },
          origin: { kind: 'system-job', jobId: 'boekwachter-indexing' },
        },
        {
          ref: 'default/2',
          projectId: 'default',
          status: 'active',
          assignee: { kind: 'user' },
        },
      ],
    } as never);

    render(<HomeView />);
    await waitFor(() => expect(screen.getByText('1 waiting on you')).toBeInTheDocument());
    expect(screen.queryByText('2 waiting on you')).not.toBeInTheDocument();
  });

  it('recognizes the shared library by marker when its ID collides with a user project', async () => {
    vi.mocked(api.getConfig).mockResolvedValue({
      provider: 'copilot',
      hasGithubToken: true,
      meesterGezelId: 'gz-meester',
      recentTabs: [{ kind: 'project', id: 'shared-library', at: Date.now() }],
    } as never);
    vi.mocked(api.listProjects).mockResolvedValue({
      projects: [
        { id: 'default', name: 'Default' },
        { id: 'shared', name: 'My shared project' },
        {
          id: 'shared-library',
          name: 'Shared Library',
          properties: { 'gezel.sharedLibrary': '1' },
        },
      ],
    } as never);

    render(<HomeView />);
    await waitFor(() => expect(api.listProjectTasks).toHaveBeenCalledWith('shared'));
    expect(api.listProjectTasks).not.toHaveBeenCalledWith('shared-library');
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

  // The chip looked like a button and did nothing; the only way to the
  // question was the titlebar or scrolling the thread.
  it('opens the Updates drawer from the chip when a question waits', async () => {
    vi.mocked(api.listQuestions).mockResolvedValue({
      questions: [
        {
          id: 'q1',
          projectId: 'default',
          gezelId: 'gz-meester',
          sessionId: 's1',
          prompt: 'Approve?',
          createdAt: new Date().toISOString(),
        },
      ],
    } as never);
    const opened = vi.fn();
    window.addEventListener('gezel:open-updates', opened);
    try {
      render(<HomeView />);
      const chip = await screen.findByRole('button', { name: /1 waiting on you/ });
      fireEvent.click(chip);
      expect(opened).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('gezel:open-updates', opened);
    }
  });

  // Finished work used to leave nothing to click once Updates emptied.
  it('shows finished work as ready, not as waiting, and opens Updates', async () => {
    vi.mocked(api.listQuestions).mockResolvedValue({
      questions: [
        {
          id: 'q-ready',
          projectId: 'default',
          gezelId: 'gz-meester',
          sessionId: 's1',
          prompt: '**Weekly posts** is finished.',
          taskRef: 'default/2',
          intent: { kind: 'task-finished', taskRef: 'default/2' },
          createdAt: new Date().toISOString(),
        },
      ],
    } as never);
    const opened = vi.fn();
    window.addEventListener('gezel:open-updates', opened);
    try {
      render(<HomeView />);
      fireEvent.click(await screen.findByRole('button', { name: /1 ready for you/ }));
      expect(opened).toHaveBeenCalledTimes(1);
      expect(screen.queryByText('1 waiting on you')).not.toBeInTheDocument();
    } finally {
      window.removeEventListener('gezel:open-updates', opened);
    }
  });

  it('opens the owner task from the chip when only a task waits', async () => {
    vi.mocked(api.listProjectTasks).mockResolvedValue({
      tasks: [
        {
          ref: 'default/4',
          projectId: 'default',
          num: 4,
          title: 'Sign the lease',
          status: 'active',
          assignee: { kind: 'user' },
          createdAt: new Date().toISOString(),
        },
      ],
    } as never);
    const tabs: unknown[] = [];
    const onTab = (e: Event) => tabs.push((e as CustomEvent).detail);
    window.addEventListener('gezel:open-tab', onTab);
    try {
      render(<HomeView />);
      fireEvent.click(await screen.findByRole('button', { name: /1 waiting on you/ }));
      expect(tabs).toContainEqual({ kind: 'task', ref: 'default/4' });
    } finally {
      window.removeEventListener('gezel:open-tab', onTab);
    }
  });

  // The chip counted questions fetched once at mount. Dismissing them from
  // the titlebar Updates drawer left the greeting insisting two things were
  // still waiting, minutes after the user had cleared both.
  it('drops the chip when the pending questions are answered elsewhere', async () => {
    const question = {
      id: 'q1',
      projectId: 'default',
      gezelId: 'gz-meester',
      sessionId: 's1',
      prompt: 'Approve?',
      createdAt: new Date().toISOString(),
    };
    vi.mocked(api.listQuestions).mockResolvedValue({ questions: [question] } as never);
    render(<HomeView />);
    await waitFor(() => {
      expect(screen.getByText('1 waiting on you')).toBeInTheDocument();
    });

    vi.mocked(api.listQuestions).mockResolvedValue({ questions: [] } as never);
    events.push({
      sessionId: 's1',
      gezelId: 'gz-meester',
      projectId: 'default',
      event: { type: 'question_answered', question: { ...question, answer: { at: 'now' } } },
    });

    await waitFor(() => {
      expect(screen.queryByText('1 waiting on you')).not.toBeInTheDocument();
    });
  });

  it('shows only the actionable chip — never ambient status about projects', async () => {
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
    await waitFor(() => {
      expect(screen.getByText('1 waiting on you')).toBeInTheDocument();
    });
    expect(screen.queryByText('Ready to work')).not.toBeInTheDocument();
    expect(screen.queryByText('Choplifter on the bench')).not.toBeInTheDocument();
    expect(screen.queryByText('2 projects open')).not.toBeInTheDocument();
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

  // At full height the band squeezed the conversation to a third of the
  // window until the owner found the collapse control.
  it('steps the greeting aside once the owner starts talking, without saving it', async () => {
    render(<HomeView />);
    await waitFor(() => {
      expect(screen.getByText('Tip of the day')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: 'mock send' }));
    await waitFor(() => {
      expect(screen.queryByText('Tip of the day')).not.toBeInTheDocument();
    });
    expect(api.updateConfig).not.toHaveBeenCalledWith({ homeGreetingCollapsed: true });

    // Reopened by hand, it stays open through the next message.
    fireEvent.click(screen.getByRole('button', { name: 'Expand the greeting' }));
    fireEvent.click(screen.getByRole('button', { name: 'mock send' }));
    expect(screen.getByText('Tip of the day')).toBeInTheDocument();
  });

  // On a phone's first run the band pushed the introduction below the fold.
  it('steps the greeting aside while the meester introduces themselves, without saving it', async () => {
    timeline.empty = true;
    try {
      render(<HomeView />);
      await screen.findByText(/your meester\./);
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Expand the greeting' })).toBeInTheDocument();
      });
      expect(api.updateConfig).not.toHaveBeenCalledWith({ homeGreetingCollapsed: true });

      // Reopened by hand, it stays open.
      fireEvent.click(screen.getByRole('button', { name: 'Expand the greeting' }));
      expect(screen.getByText('Tip of the day')).toBeInTheDocument();
    } finally {
      timeline.empty = false;
    }
  });

  // The saved preference is applied by an effect, and on a slow runner the
  // first message in the test above landed before that effect had run — which
  // then reopened the band. Arriving config must not undo a conversation's
  // collapse.
  it('keeps the greeting stepped aside when the saved preference arrives after the first message', async () => {
    const props = {
      projects: [],
      meesterGezelId: 'gz-meester',
      meesterName: 'Brigitte',
      meesterIcon: null,
      meesterPoppetje: null,
      meesterIconOverride: false,
    };
    const { rerender } = render(<HomeWorkshop config={null} {...props} />);
    fireEvent.click(await screen.findByRole('button', { name: 'mock send' }));
    expect(screen.queryByText('Tip of the day')).not.toBeInTheDocument();

    rerender(
      <HomeWorkshop
        config={{ provider: 'copilot', homeGreetingCollapsed: false } as never}
        {...props}
      />,
    );
    expect(screen.queryByText('Tip of the day')).not.toBeInTheDocument();
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
    const tourTab = screen.getByRole('button', { name: tourName });
    expect(tourTab).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(tourTab);
    // The tour content replaces the greeting + tip in the left column.
    expect(tourTab).toHaveAttribute('aria-pressed', 'true');
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
