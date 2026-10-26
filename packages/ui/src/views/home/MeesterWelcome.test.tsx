import { DESKTOP_RUNTIME_CAPABILITIES } from '@bendyline/gezel';
import type { ConfigResponse } from '@bendyline/gezel-client';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../../test-utils/mockApi.js';

vi.mock('../../api.js', () => ({ api: createMockApi() }));
vi.mock('../../components/useCopilotAvailability.js', () => ({
  useCopilotAvailability: () => null,
}));
// vi.mock is hoisted, so the spy has to be created inside the factory and
// read back through the mocked module rather than closed over here.
vi.mock('../../components/composer-prefill.js', () => ({ queueComposerPrefill: vi.fn() }));
vi.mock('../../components/GezelIcon.js', () => ({
  GezelIcon: ({ name }: { name: string }) => <span data-testid="icon" data-name={name} />,
}));
// The Handboek page pulls in the squisq renderers, which jsdom can't drive.
vi.mock('./IntroHandboekArticle.js', () => ({
  IntroHandboekArticle: ({ variant }: { variant?: string }) => (
    <div data-testid="home-intro-article" data-variant={variant ?? 'toggle'} />
  ),
}));

const { api } = await import('../../api.js');
const { queueComposerPrefill } = await import('../../components/composer-prefill.js');
const { useFirstRunModel } = await import('../../components/useFirstRunModel.js');
type FirstRunModel = import('../../components/useFirstRunModel.js').FirstRunModel;
const { MeesterWelcome, composerWaitingStatus } = await import('./MeesterWelcome.js');

const prefill = vi.mocked(queueComposerPrefill);
const GB = 1024 ** 3;

function config(over: Partial<ConfigResponse> = {}): ConfigResponse {
  return {
    provider: 'llama-cpp',
    defaultModel: { 'llama-cpp': 'qwen3.8-27b-q4' },
    ...over,
  } as ConfigResponse;
}

const figure = {
  meesterName: 'Florian',
  meesterIcon: null,
  meesterPoppetje: null,
  meesterIconOverride: false,
  projectId: 'default',
};

/** The welcome as Home renders it in first run: the real download hook behind it. */
function FirstRun({
  cfg,
  onConfigChanged = () => {},
  onModelInstalled,
}: {
  cfg: ConfigResponse;
  onConfigChanged?: (next: ConfigResponse) => void;
  onModelInstalled?: () => void;
}) {
  const model = useFirstRunModel({
    enabled: true,
    config: cfg,
    onConfigChanged,
    ...(onModelInstalled ? { onModelInstalled } : {}),
  });
  return <MeesterWelcome {...figure} setup={{ model }} />;
}

describe('MeesterWelcome', () => {
  beforeEach(() => {
    prefill.mockClear();
    // An established install by default, so a test that asks never leaks the picker into the next.
    vi.mocked(api.getConfig).mockResolvedValue(config());
    vi.mocked(api.listLlamaCppModels).mockResolvedValue({ models: [] } as never);
    vi.mocked(api.listLlamaCppActiveInstalls).mockResolvedValue({ installs: [] } as never);
    // No engine to fetch unless a test says so; a missing one holds first run.
    vi.mocked(api.getNativeEngineStatus).mockResolvedValue({} as never);
    vi.mocked(api.getCatalogItem).mockResolvedValue({
      manifest: { kind: 'chat-model', llamaCpp: { approxSizeBytes: 16 * GB } },
    } as never);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('once a model can answer', () => {
    it('introduces the meester by name, with no download offer', () => {
      render(<MeesterWelcome {...figure} />);
      expect(
        screen.getByRole('heading', { name: /I'm Florian — I run this workshop/ }),
      ).toBeInTheDocument();
      expect(screen.getByText(/bring on the gezellen it needs/)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Fetch my tools/ })).not.toBeInTheDocument();
      expect(screen.queryByText(/Change what I'm allowed to do/)).not.toBeInTheDocument();
      // Past first run the intro waits behind the tour link.
      expect(screen.queryByTestId('home-intro-article')).toBeNull();
      expect(screen.getByRole('button', { name: 'Take the 1-minute tour' })).toBeInTheDocument();
    });

    it('offers first projects that prefill the composer instead of sending', () => {
      render(<MeesterWelcome {...figure} projectId="alpha" />);
      const trip = screen.getByRole('button', { name: /Plan a trip/ });
      expect(trip).toHaveTextContent('on a trip board');
      expect(
        screen.getByRole('button', { name: /Turn meeting notes into actions/ }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: /Make sense of a spreadsheet/ }),
      ).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Practice a language/ })).toBeInTheDocument();
      fireEvent.click(trip);
      // Prefill, not send — the person makes the sentence theirs first.
      // A pick replaces the draft, so a second pick never sends both sentences.
      expect(prefill).toHaveBeenCalledWith(
        'alpha',
        expect.stringContaining('Plan a trip to'),
        undefined,
        { replace: true },
      );
    });

    it('asks a new install what it wants help with, and saves each box ticked', async () => {
      vi.mocked(api.getConfig).mockResolvedValue(
        config({ firstUseAt: new Date().toISOString() } as Partial<ConfigResponse>),
      );
      vi.mocked(api.updateConfig).mockResolvedValue({} as never);
      render(<MeesterWelcome {...figure} />);
      const data = await screen.findByRole('checkbox', { name: 'Data and spreadsheets' });
      fireEvent.click(data);
      await waitFor(() =>
        expect(api.updateConfig).toHaveBeenCalledWith({
          interests: { areas: ['data'], askedAt: expect.any(String) },
        }),
      );
      // The picker stays for the visit, ticked, rather than vanishing on the first choice.
      expect(screen.getByRole('checkbox', { name: 'Data and spreadsheets' })).toBeChecked();
    });

    // Picking Data left the trip, language and party cards. Data's first
    // projects are craftbooks, so a host that cannot launch one from chat
    // still serves nothing for it and points at New Task's For you shelf.
    it('offers plans for a pick no first project serves', async () => {
      window.__GEZEL__ = {
        capabilities: { ...DESKTOP_RUNTIME_CAPABILITIES, chatTaskLaunch: false },
      } as never;
      try {
        vi.mocked(api.getConfig).mockResolvedValue(
          config({ interests: { areas: ['data'], askedAt: 'x' } } as Partial<ConfigResponse>),
        );
        const onBrowseForYou = vi.fn();
        render(<MeesterWelcome {...figure} onBrowseForYou={onBrowseForYou} />);
        fireEvent.click(
          await screen.findByRole('button', { name: 'Browse plans for data and spreadsheets' }),
        );
        expect(onBrowseForYou).toHaveBeenCalled();
      } finally {
        delete window.__GEZEL__;
      }
    });

    it('offers no browse link when the cards already serve the pick', async () => {
      vi.mocked(api.getConfig).mockResolvedValue(
        config({ interests: { areas: ['home'], askedAt: 'x' } } as Partial<ConfigResponse>),
      );
      render(<MeesterWelcome {...figure} onBrowseForYou={vi.fn()} />);
      await screen.findByRole('button', { name: /Plan a trip/ });
      expect(screen.queryByRole('button', { name: /Browse plans/ })).toBeNull();
    });

    it('never asks an established install', async () => {
      vi.mocked(api.getConfig).mockResolvedValue(config());
      render(<MeesterWelcome {...figure} />);
      await waitFor(() => expect(api.getConfig).toHaveBeenCalled());
      expect(screen.queryByRole('group', { name: 'What you would like help with' })).toBeNull();
    });

    it('puts the chosen area first among the first projects', async () => {
      vi.mocked(api.getConfig).mockResolvedValue(
        config({ interests: { areas: ['learning'], askedAt: 'x' } } as Partial<ConfigResponse>),
      );
      render(<MeesterWelcome {...figure} />);
      await waitFor(() =>
        expect(screen.getAllByRole('button', { name: /Plan a|Practice/ })[0]).toHaveTextContent(
          'Practice a language',
        ),
      );
    });

    it('re-chooses the first projects from the area ticked in the picker', async () => {
      vi.mocked(api.getConfig).mockResolvedValue(
        config({ firstUseAt: new Date().toISOString() } as Partial<ConfigResponse>),
      );
      vi.mocked(api.updateConfig).mockResolvedValue({} as never);
      render(<MeesterWelcome {...figure} />);
      fireEvent.click(await screen.findByRole('checkbox', { name: 'Writing software' }));
      const openers = screen.getByRole('group', { name: 'Something to start with' });
      await waitFor(() => {
        const titles = [...openers.querySelectorAll('.gz-key-label')].map((el) => el.textContent);
        expect(titles.slice(0, 2)).toEqual(['Explain a code folder', 'Review a code folder']);
      });
    });

    it('says it is ready when the model landed during this visit', () => {
      render(<MeesterWelcome {...figure} justReady />);
      expect(screen.getByText("I'm ready. What shall we make?")).toBeInTheDocument();
      expect(screen.getByTestId('meester-welcome')).toHaveAttribute(
        'data-welcome-state',
        'just-ready',
      );
    });

    it('never says "I\'m meester" when names are hidden', () => {
      render(<MeesterWelcome {...figure} meesterName="Meester" />);
      expect(
        screen.getByRole('heading', { name: /I'm your meester — I run this workshop/ }),
      ).toBeInTheDocument();
    });

    it('introduces the helpers that already work here', () => {
      render(
        <MeesterWelcome
          {...figure}
          helpers={[
            {
              gezel: { id: 'k', name: 'Bram' } as never,
              does: 'handles the paperwork — titles and summaries',
            },
            { gezel: { id: 'b', name: 'Armando' } as never, does: 'keeps track of your files' },
          ]}
        />,
      );
      expect(screen.getByText('Two helpers already work here:')).toBeInTheDocument();
      expect(screen.getByText('Bram')).toBeInTheDocument();
      expect(screen.getByText('Armando')).toBeInTheDocument();
    });

    it('opens the tour in place rather than leaving Home', () => {
      render(<MeesterWelcome {...figure} />);
      fireEvent.click(screen.getByRole('button', { name: 'Take the 1-minute tour' }));
      expect(screen.getByTestId('home-intro-article')).toBeInTheDocument();
    });
  });

  describe('in first run', () => {
    // The first inventory answer can take minutes while shared models are
    // hashed; rendering nothing meanwhile left setup with no way forward.
    it('says it is looking while the model inventory is still loading', () => {
      vi.mocked(api.listLlamaCppModels).mockReturnValue(new Promise(() => {}) as never);
      render(<FirstRun cfg={config()} />);
      expect(screen.getByText(/Let me see what is already on this computer/)).toBeInTheDocument();
    });

    it('keeps one inventory request in flight instead of stacking a new one every poll', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      vi.mocked(api.listLlamaCppModels).mockReturnValue(new Promise(() => {}) as never);
      render(<FirstRun cfg={config()} />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(api.listLlamaCppModels).toHaveBeenCalledTimes(1);
    });

    it('asks for the download with one key, in the meester’s voice, and fetches nothing until pressed', async () => {
      vi.mocked(api.installLlamaCppModel).mockReturnValue(new Promise(() => {}) as never);
      render(<FirstRun cfg={config()} />);

      const key = await screen.findByRole('button', {
        name: 'Fetch my tools · 16.0 GB · about 30 minutes',
      });
      expect(screen.getByText(/I need my tools/)).toBeInTheDocument();
      expect(screen.getByText(/Change what I'm allowed to do/)).toBeInTheDocument();
      // No posture tray or preference switches: those are defaults now.
      expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
      expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
      expect(api.installLlamaCppModel).not.toHaveBeenCalled();

      fireEvent.click(key);
      await waitFor(() => expect(api.installLlamaCppModel).toHaveBeenCalled());
      expect(vi.mocked(api.installLlamaCppModel).mock.calls[0]?.[0]).toBe('qwen3.8-27b-q4');
      expect(await screen.findByText('Fetching my tools')).toBeInTheDocument();
      expect(
        screen.getByText(/While tools are downloading, let's get ready for our first conversation/),
      ).toBeInTheDocument();
    });

    it('puts the ideas line under the interest picker, and leads with it once the picker is put away', async () => {
      vi.mocked(api.getConfig).mockResolvedValue(
        config({ firstUseAt: new Date().toISOString() } as Partial<ConfigResponse>),
      );
      vi.mocked(api.updateConfig).mockResolvedValue({} as never);
      vi.mocked(api.installLlamaCppModel).mockReturnValue(new Promise(() => {}) as never);
      render(<FirstRun cfg={config()} />);
      fireEvent.click(await screen.findByRole('button', { name: /Fetch my tools/ }));
      expect(await screen.findByText('Fetching my tools')).toBeInTheDocument();

      const picker = await screen.findByRole('group', { name: 'What you would like help with' });
      const ideas = screen.getByText(/Here are some ideas for things the crew can help you with/);
      const openers = screen.getByRole('group', { name: 'Something to start with' });
      expect(picker.compareDocumentPosition(ideas) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(
        ideas.compareDocumentPosition(openers) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();

      fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
      expect(screen.queryByRole('group', { name: 'What you would like help with' })).toBeNull();
      expect(
        screen.getAllByText(/Here are some ideas for things the crew can help you with/),
      ).toHaveLength(1);
      expect(screen.queryByText(/what would you like help with/i)).toBeNull();
    });

    // The daemon fetches the engine lazily, so the first message after
    // "I'm ready" started the download and failed on it.
    it('stays in first run while the engine that runs the model arrives', async () => {
      vi.mocked(api.listLlamaCppModels).mockResolvedValue({
        models: [{ id: 'qwen3.8-27b-q4', name: 'Qwen 3.8 (27B)' }],
      } as never);
      vi.mocked(api.getNativeEngineStatus).mockResolvedValue({
        release: 'native-v1',
        pinned: true,
        platformKey: 'win32-x64',
        llamaBackend: 'cuda',
        engines: [{ name: 'llama-server', installed: false }],
      } as never);
      vi.mocked(api.ensureNativeEngine).mockImplementation((async (
        _engine: string,
        onEvent: (ev: unknown) => void,
      ) => {
        onEvent({ type: 'progress', bytesWritten: 40, totalBytes: 100 });
        await new Promise(() => {});
      }) as never);
      const onModelInstalled = vi.fn();
      render(<FirstRun cfg={config()} onModelInstalled={onModelInstalled} />);

      expect(await screen.findByText('Setting up my workbench · 40%')).toBeInTheDocument();
      expect(vi.mocked(api.ensureNativeEngine).mock.calls[0]?.[0]).toBe('llama-server');
      expect(vi.mocked(api.ensureNativeEngine).mock.calls[0]?.[2]).toBe('cuda');
      expect(screen.getByTestId('meester-welcome')).toHaveAttribute('data-welcome-state', 'engine');
      // Not ready yet: Home keeps the person in first run, Send held.
      expect(onModelInstalled).not.toHaveBeenCalled();
    });

    it('shows a failed engine fetch and waits for the person instead of retrying', async () => {
      vi.mocked(api.listLlamaCppModels).mockResolvedValue({
        models: [{ id: 'qwen3.8-27b-q4', name: 'Qwen 3.8 (27B)' }],
      } as never);
      vi.mocked(api.getNativeEngineStatus).mockResolvedValue({
        release: 'native-v1',
        pinned: true,
        platformKey: 'win32-x64',
        engines: [{ name: 'llama-server', installed: false }],
      } as never);
      // The daemon reports a failed fetch as an event on a stream that ends normally.
      vi.mocked(api.ensureNativeEngine).mockImplementation((async (
        _engine: string,
        onEvent: (ev: unknown) => void,
      ) => {
        onEvent({ type: 'error', error: 'GitHub API rate limit exceeded' });
      }) as never);
      render(<FirstRun cfg={config()} />);

      expect(await screen.findByText(/GitHub API rate limit exceeded/)).toBeInTheDocument();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(api.ensureNativeEngine).toHaveBeenCalledTimes(1);
      expect(screen.getByText(/GitHub API rate limit exceeded/)).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
      await waitFor(() => expect(api.ensureNativeEngine).toHaveBeenCalledTimes(2));
    });

    // "6.3 GB" counted the model alone; the engine came down beside it.
    it('counts the engine in the key when it still has to come down', async () => {
      vi.mocked(api.getNativeEngineStatus).mockResolvedValue({
        release: 'native-v1',
        pinned: true,
        platformKey: 'win32-x64',
        llamaBackend: 'cuda',
        engines: [{ name: 'llama-server', installed: false, downloadBytes: 2 * 1024 ** 3 }],
      } as never);
      render(<FirstRun cfg={config()} />);
      expect(
        await screen.findByRole('button', {
          name: 'Fetch my tools · 18.0 GB · about 30 minutes',
        }),
      ).toBeInTheDocument();
    });

    it('fetches the engine beside the model when the person taps', async () => {
      vi.mocked(api.getNativeEngineStatus).mockResolvedValue({
        release: 'native-v1',
        pinned: true,
        platformKey: 'win32-x64',
        engines: [{ name: 'llama-server', installed: false }],
      } as never);
      vi.mocked(api.installLlamaCppModel).mockReturnValue(new Promise(() => {}) as never);
      vi.mocked(api.ensureNativeEngine).mockReturnValue(new Promise(() => {}) as never);
      render(<FirstRun cfg={config()} />);
      fireEvent.click(await screen.findByRole('button', { name: /^Fetch my tools/ }));
      await waitFor(() => expect(api.ensureNativeEngine).toHaveBeenCalled());
      expect(api.installLlamaCppModel).toHaveBeenCalled();
    });

    it('offers models already on the computer beside the recommended download', async () => {
      vi.mocked(api.listLlamaCppModels).mockResolvedValue({
        models: [{ id: 'gemma4-31b-q4', name: 'Gemma 4 (31B, Q4)' }],
      } as never);
      const next = config({ defaultModel: { 'llama-cpp': 'gemma4-31b-q4' } });
      vi.mocked(api.updateConfig).mockResolvedValue(next as never);
      const onConfigChanged = vi.fn();
      const onModelInstalled = vi.fn();
      render(
        <FirstRun
          cfg={config()}
          onConfigChanged={onConfigChanged}
          onModelInstalled={onModelInstalled}
        />,
      );

      fireEvent.click(
        await screen.findByRole('button', { name: 'Use one already on this computer' }),
      );
      fireEvent.click(screen.getByRole('button', { name: 'Gemma 4 (31B, Q4)' }));

      await waitFor(() => expect(onModelInstalled).toHaveBeenCalled());
      expect(api.updateConfig).toHaveBeenCalledWith({
        defaultModel: { 'llama-cpp': 'gemma4-31b-q4' },
      });
      expect(onConfigChanged).toHaveBeenCalledWith(next);
    });

    // The first-run pin is written in the background at daemon start, so Home
    // can hold a config from before it landed.
    it('re-reads the config when the recommended model has not been pinned yet', async () => {
      const pinned = config();
      vi.mocked(api.getConfig).mockResolvedValue(pinned as never);
      const onConfigChanged = vi.fn();
      render(<FirstRun cfg={config({ defaultModel: {} })} onConfigChanged={onConfigChanged} />);
      await waitFor(() => expect(onConfigChanged).toHaveBeenCalledWith(pinned));
      expect(screen.getByText(/Let me see what is already on this computer/)).toBeInTheDocument();
    });

    it('shows how far along the tools are, and the time left once measured', () => {
      const model = {
        state: {
          kind: 'installing',
          provider: 'llama-cpp',
          modelId: 'qwen3.8-27b-q4',
          sizeBytes: 16 * GB,
          progress: { bytesWritten: 4 * GB, totalBytes: 16 * GB, phase: 'downloading' },
        },
        rate: { samples: [], bytesPerSecond: 20 * 1024 ** 2, lastMovedAt: Date.now() },
        now: Date.now(),
        busy: false,
        copilotAvailable: null,
      } as unknown as FirstRunModel;
      const { rerender } = render(<MeesterWelcome {...figure} setup={{ model }} />);
      expect(screen.getByText(/^Fetching my tools · 25% · about 10 min left$/)).toBeInTheDocument();

      // Before a rate is measured, the line says only how far along it is.
      rerender(
        <MeesterWelcome
          {...figure}
          setup={{
            model: { ...model, rate: { samples: [], bytesPerSecond: null, lastMovedAt: null } },
          }}
        />,
      );
      expect(screen.getByText(/^Fetching my tools · 25%$/)).toBeInTheDocument();
    });

    it('plays the intro under the first projects while the tools download, and keeps it once they land', () => {
      const model = {
        state: {
          kind: 'installing',
          provider: 'llama-cpp',
          modelId: 'qwen3.8-27b-q4',
          sizeBytes: 16 * GB,
          progress: null,
        },
        rate: { samples: [], bytesPerSecond: null, lastMovedAt: null },
        now: Date.now(),
        busy: false,
        copilotAvailable: null,
      } as unknown as FirstRunModel;
      const { rerender } = render(<MeesterWelcome {...figure} setup={{ model }} />);
      const lead = screen.getByText('Also, while we wait, here is a bit more info about gezel:');
      const intro = screen.getByTestId('home-intro-article');
      expect(intro).toHaveAttribute('data-variant', 'player');
      const openers = screen.getByRole('group', { name: 'Something to start with' });
      expect(openers.compareDocumentPosition(lead) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

      // The download finishing must not pull the video from under a viewer,
      // and the tour link would only open a second copy of it.
      rerender(<MeesterWelcome {...figure} justReady />);
      expect(screen.getByTestId('home-intro-article')).toHaveAttribute('data-variant', 'player');
      expect(screen.queryByRole('button', { name: 'Take the 1-minute tour' })).toBeNull();
    });

    // Keyed to a running download, it was missing whenever the tools were
    // already on disk or the page reloaded after they landed.
    it('plays the intro in every first-run state, not only while downloading', async () => {
      render(<FirstRun cfg={config()} />);
      await screen.findByRole('button', { name: /Fetch my tools/ });
      expect(
        screen.getByText('Also, while we wait, here is a bit more info about gezel:'),
      ).toBeInTheDocument();
      expect(screen.getByTestId('home-intro-article')).toHaveAttribute('data-variant', 'player');

      const ready = {
        state: { kind: 'ready' },
        rate: { samples: [], bytesPerSecond: null, lastMovedAt: null },
        now: Date.now(),
        busy: false,
        copilotAvailable: null,
      } as unknown as FirstRunModel;
      const { unmount } = render(<MeesterWelcome {...figure} setup={{ model: ready }} />);
      expect(screen.getAllByTestId('home-intro-article')).toHaveLength(2);
      unmount();
    });

    it('offers to fetch anyway when Hugging Face republished the file', async () => {
      vi.mocked(api.installLlamaCppModel).mockImplementation((async (
        _id: string,
        onEvent: (ev: unknown) => void,
      ) => {
        onEvent({
          type: 'error',
          error: 'sha256 mismatch',
          mismatch: { file: 'model.gguf', expected: 'a', actual: 'b' },
        });
      }) as never);
      render(<FirstRun cfg={config()} />);

      fireEvent.click(await screen.findByRole('button', { name: /^Fetch my tools/ }));

      expect(await screen.findByRole('button', { name: 'Fetch them anyway' })).toBeInTheDocument();
      expect(screen.getByText(/can't vouch for the new copy/)).toBeInTheDocument();
      // A republished file is not a bug in Gezel, so there is nothing to report.
      expect(screen.queryByRole('button', { name: /report/i })).not.toBeInTheDocument();
    });

    it('sends a cloud provider to Settings to connect, rather than offering a download', () => {
      const events: CustomEvent[] = [];
      const record = (e: Event) => events.push(e as CustomEvent);
      window.addEventListener('gezel:navigate', record);
      try {
        render(<FirstRun cfg={config({ provider: 'copilot' })} />);
        fireEvent.click(screen.getByRole('button', { name: 'Connect an AI' }));
      } finally {
        window.removeEventListener('gezel:navigate', record);
      }
      expect(events.at(-1)?.detail).toEqual({ view: 'settings', section: 'defaults' });
      expect(screen.queryByText(/run on this computer/)).not.toBeInTheDocument();
    });

    it('lets a phone host draw its own model list in the welcome', () => {
      const hostModels = vi.fn(() => <div>Native model list</div>);
      function Phone() {
        const model = useFirstRunModel({
          enabled: false,
          config: null,
          onConfigChanged: () => {},
        });
        return <MeesterWelcome {...figure} setup={{ model, hostModels }} />;
      }
      render(<Phone />);
      expect(screen.getByText('Native model list')).toBeInTheDocument();
      expect(hostModels).toHaveBeenCalledWith({ setup: true });
    });
  });

  describe('composerWaitingStatus', () => {
    const withState = (state: unknown) =>
      composerWaitingStatus({ model: { state } as unknown as FirstRunModel });

    it('names where setup stands for the composer warning', () => {
      expect(withState({ kind: 'off' })).toBe('connect an AI first');
      expect(withState({ kind: 'needs-download', alternatives: [] })).toBe(
        'download tools (an AI model) first',
      );
      expect(
        withState({
          kind: 'installing',
          progress: { bytesWritten: 4 * GB, totalBytes: 16 * GB, phase: 'downloading' },
        }),
      ).toBe('downloading the AI model · 25%');
      expect(withState({ kind: 'engine', progress: null })).toBe('setting up the AI model');
      expect(withState({ kind: 'failed', error: 'offline' })).toBe("the AI model didn't download");
      expect(
        composerWaitingStatus({
          model: { state: { kind: 'off' } } as unknown as FirstRunModel,
          hostModels: () => null,
        }),
      ).toBe('choose an AI model first');
    });
  });
});
