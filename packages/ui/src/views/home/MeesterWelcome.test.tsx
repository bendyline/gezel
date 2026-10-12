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
  IntroHandboekArticle: () => <div data-testid="home-intro-article" />,
}));

const { api } = await import('../../api.js');
const { queueComposerPrefill } = await import('../../components/composer-prefill.js');
const { useFirstRunModel } = await import('../../components/useFirstRunModel.js');
type FirstRunModel = import('../../components/useFirstRunModel.js').FirstRunModel;
const { MeesterWelcome } = await import('./MeesterWelcome.js');

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
    vi.mocked(api.listLlamaCppModels).mockResolvedValue({ models: [] } as never);
    vi.mocked(api.listLlamaCppActiveInstalls).mockResolvedValue({ installs: [] } as never);
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
    });

    it('offers first projects that prefill the composer instead of sending', () => {
      render(<MeesterWelcome {...figure} projectId="alpha" />);
      const trip = screen.getByRole('button', { name: /Plan a trip/ });
      expect(trip).toHaveTextContent('on a trip board');
      expect(screen.getByRole('button', { name: /Plan a celebration/ })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Practise a language/ })).toBeInTheDocument();
      fireEvent.click(trip);
      // Prefill, not send — the person makes the sentence theirs first.
      expect(prefill).toHaveBeenCalledWith('alpha', expect.stringContaining('Plan a trip to'));
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
        name: 'Fetch my tools · 16.0 GB · about 20 minutes',
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
        screen.getByText(/While I wait — what would you like to get done/),
      ).toBeInTheDocument();
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
});
