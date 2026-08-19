import { poppetjeFromSeed } from '@bendyline/gezel';
import type { ConfigResponse, QueueStatusResponse } from '@bendyline/gezel-client';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';
import type { LiveTurnState } from './useOnDeviceLiveTurns.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));

// Mock the live-turns hook so the test can drive the preparing-window
// state directly without standing up an SSE stream. The component's
// own visibility/render logic is what's under test here; the hook's
// `enabled` gating is exercised separately by its own consumers.
let mockLiveTurns = new Map<string, LiveTurnState>();
vi.mock('./useOnDeviceLiveTurns.js', () => ({
  useOnDeviceLiveTurns: () => mockLiveTurns,
}));

const { QueueMeter } = await import('./QueueMeter.js');
const { api } = await import('../api.js');

/** A snapshot where the on-device provider hasn't registered yet — the
 *  "Preparing" window, when `/api/queues` omits it entirely. */
const PREPARING_STATUS: QueueStatusResponse = {
  providers: {},
  taskRunner: { pendingCount: 0, pendingByGezel: {}, pendingByProject: {} },
  sessions: [],
  cache: [],
  at: '',
};

const ALEJANDRO = {
  id: 'gez-1',
  name: 'Alejandro',
  role: 'Language Trainer',
  roleBasedName: 'researcher',
  poppetje: poppetjeFromSeed(7, { key: 'gez-1', name: 'Alejandro' }),
  updatedAt: '',
};

const ACTIVE_STATUS: QueueStatusResponse = {
  providers: {
    'llama-cpp': {
      running: 1,
      queuedInteractive: 0,
      queuedBackground: 0,
      concurrency: 4,
      interactiveConcurrency: 4,
      backgroundConcurrency: 1,
      active: [
        {
          sessionId: 'sess-1',
          gezelId: 'gez-1',
          projectId: 'project-7',
          job: 'project-7',
          runningForMs: 12_000,
        },
      ],
      pending: [],
    },
  },
  taskRunner: { pendingCount: 0, pendingByGezel: {}, pendingByProject: {} },
  sessions: [],
  cache: [],
  at: '',
};

function liveTurn(overrides: Partial<LiveTurnState> = {}): LiveTurnState {
  return {
    phase: 'prefill',
    label: 'Preparing',
    startedAt: Date.now(),
    lastEventAt: Date.now(),
    ...overrides,
  };
}

type QueueProviderName = keyof QueueStatusResponse['providers'];

const CLOUD_AND_CLI_QUEUE_CASES = [
  { provider: 'copilot', label: 'Copilot' },
  { provider: 'openai', label: 'OpenAI' },
  { provider: 'anthropic', label: 'Claude' },
  { provider: 'anthropic-cli', label: 'Claude CLI' },
  { provider: 'codex-cli', label: 'Codex CLI' },
] as const satisfies ReadonlyArray<{ provider: QueueProviderName; label: string }>;

function busyProviderStatus(provider: QueueProviderName): QueueStatusResponse {
  return {
    providers: {
      [provider]: {
        running: 1,
        queuedInteractive: 1,
        queuedBackground: 0,
        concurrency: 4,
        active: [
          {
            sessionId: `${provider}-active`,
            gezelId: 'gez-1',
            projectId: 'project-7',
            runningForMs: 12_000,
          },
        ],
        pending: [
          {
            id: 71,
            lane: 'interactive',
            sessionId: `${provider}-queued`,
            gezelId: 'gez-1',
            projectId: 'project-7',
            waitedMs: 4_000,
          },
        ],
      },
    },
    taskRunner: { pendingCount: 0, pendingByGezel: {}, pendingByProject: {} },
    sessions: [],
    cache: [],
    at: '',
  };
}

describe('QueueMeter — preparing window', () => {
  beforeEach(() => {
    mockLiveTurns = new Map();
    vi.mocked(api.getConfig).mockResolvedValue({ provider: 'llama-cpp' } as ConfigResponse);
    vi.mocked(api.getQueueStatus).mockResolvedValue(PREPARING_STATUS);
    vi.mocked(api.listGezels).mockResolvedValue({
      gezels: [ALEJANDRO],
    } as never);
    vi.mocked(api.listProjects).mockResolvedValue({
      projects: [{ id: 'project-7', name: 'Spanish lessons' }],
    } as never);
  });

  it('shows the active gezel identity, role, and project in the pill hover and queue row', async () => {
    vi.mocked(api.getConfig).mockResolvedValue({
      provider: 'llama-cpp',
      roleBasedNameOnlyMode: false,
      showPoppetjes: true,
    } as ConfigResponse);
    vi.mocked(api.getQueueStatus).mockResolvedValue(ACTIVE_STATUS);

    const { container } = render(<QueueMeter />);
    const button = await screen.findByRole('button', {
      name: 'AI chat queue — click for details',
    });

    await waitFor(() => {
      expect(container.querySelector('.queue-meter-chip .gezel-icon-poppetje')).not.toBeNull();
      expect(button).toHaveAttribute('title', expect.stringContaining('Role: Language Trainer'));
      expect(button).toHaveAttribute('title', expect.stringContaining('Project: Spanish lessons'));
    });
    expect(button).toHaveTextContent('Alejandro');
    expect(button).not.toHaveTextContent('On-device');

    await userEvent.click(button);
    await waitFor(() => {
      expect(
        container.querySelector('.queue-meter-panel-item .gezel-icon-poppetje'),
      ).not.toBeNull();
    });
    const panel = await screen.findByLabelText('AI chat queue');
    expect(panel).toHaveStyle({ position: 'fixed' });
    expect(within(panel).getByText('Alejandro')).toBeInTheDocument();
    expect(within(panel).getByText('Language Trainer · Spanish lessons')).toBeInTheDocument();
    expect(within(panel).queryByText(/project-7/)).not.toBeInTheDocument();
  });

  it('stops an active chat from its in-flight row', async () => {
    vi.mocked(api.getQueueStatus).mockResolvedValue(ACTIVE_STATUS);
    vi.mocked(api.cancelChatSessionTurn).mockResolvedValue({ cancelled: true });

    render(<QueueMeter />);
    await userEvent.click(
      await screen.findByRole('button', { name: 'AI chat queue — click for details' }),
    );

    const stop = await screen.findByRole('button', { name: 'Stop active chat with Alejandro' });
    expect(stop).toBeVisible();
    expect(stop).toHaveTextContent('■ Stop');
    await userEvent.click(stop);

    expect(api.cancelChatSessionTurn).toHaveBeenCalledWith('sess-1');
    expect(stop).toBeDisabled();
    expect(stop).toHaveTextContent('Stopping…');
  });

  it('names the connected app that owns an in-flight request without a Gezel stop target', async () => {
    vi.mocked(api.getQueueStatus).mockResolvedValue({
      ...ACTIVE_STATUS,
      providers: {
        'llama-cpp': {
          ...ACTIVE_STATUS.providers['llama-cpp']!,
          active: [
            {
              gezelId: 'gez-1',
              actorLabel: 'pi (Gezel local models)',
              job: 'pi (Gezel local models)',
              runningForMs: 12_000,
            },
          ],
        },
      },
    });

    render(<QueueMeter />);
    await userEvent.click(
      await screen.findByRole('button', { name: 'AI chat queue — click for details' }),
    );

    const status = await screen.findByText('In flight via pi');
    expect(status).toHaveAttribute('title', 'pi controls this request. Stop it from pi.');
    expect(screen.queryByRole('button', { name: /Stop active chat/ })).not.toBeInTheDocument();
  });

  it('keeps provider labels and plain status markers in boring mode', async () => {
    vi.mocked(api.getConfig).mockResolvedValue({
      provider: 'llama-cpp',
      roleBasedNameOnlyMode: true,
      showPoppetjes: true,
    } as ConfigResponse);
    vi.mocked(api.getQueueStatus).mockResolvedValue(ACTIVE_STATUS);

    const { container } = render(<QueueMeter />);
    const button = await screen.findByRole('button', {
      name: 'AI chat queue — click for details',
    });

    await waitFor(() => {
      expect(button.querySelector('.queue-meter-chip-label')).not.toBeNull();
      expect(container.querySelector('.queue-meter-chip .gezel-icon')).toBeNull();
    });
    expect(button).not.toHaveTextContent('Alejandro');

    await userEvent.click(button);
    expect(await screen.findByText(/researcher/)).toBeInTheDocument();
    expect(container.querySelector('.queue-meter-panel-item .gezel-icon')).toBeNull();
    expect(container.querySelector('.queue-meter-panel-status-dot')).not.toBeNull();
  });

  it('attributes built-in queue work to its named system actor', async () => {
    vi.mocked(api.getConfig).mockResolvedValue({
      provider: 'llama-cpp',
      roleBasedNameOnlyMode: false,
      showPoppetjes: true,
    } as ConfigResponse);
    vi.mocked(api.getQueueStatus).mockResolvedValue({
      ...ACTIVE_STATUS,
      providers: {
        'llama-cpp': {
          ...ACTIVE_STATUS.providers['llama-cpp']!,
          active: [
            {
              sessionId: 'index-enrichment',
              actorLabel: 'Boekwachter',
              projectId: 'project-7',
              job: 'Indexing src/app.ts',
              runningForMs: 16_000,
            },
          ],
        },
      },
    });

    const { container } = render(<QueueMeter />);
    const button = await screen.findByRole('button', {
      name: 'AI chat queue — click for details',
    });

    await waitFor(() => expect(button).toHaveTextContent('Boekwachter'));
    expect(button).toHaveTextContent('Indexing src/app.ts');
    expect(button).toHaveTextContent('Spanish lessons');
    expect(button).toHaveAttribute(
      'title',
      expect.stringContaining('Activity: Indexing src/app.ts'),
    );
    expect(button).not.toHaveTextContent(/This (Windows|Linux|Mac)/);
    expect(button.querySelector('.queue-meter-chip .gezel-icon-fallback')).not.toBeNull();
    expect(screen.queryByText(/Unknown/i)).not.toBeInTheDocument();

    await userEvent.click(button);
    const panel = await screen.findByLabelText('AI chat queue');
    expect(within(panel).getByText('Boekwachter')).toBeInTheDocument();
    expect(within(panel).getByText(/Indexing src\/app\.ts/)).toBeInTheDocument();
  });

  it('uses System as the final fallback for unattributed service work', async () => {
    vi.mocked(api.getConfig).mockResolvedValue({
      provider: 'llama-cpp',
      roleBasedNameOnlyMode: false,
      showPoppetjes: true,
    } as ConfigResponse);
    vi.mocked(api.getQueueStatus).mockResolvedValue({
      ...ACTIVE_STATUS,
      providers: {
        'llama-cpp': {
          ...ACTIVE_STATUS.providers['llama-cpp']!,
          active: [{ job: 'maintenance', runningForMs: 1_000 }],
        },
      },
    });

    const { container } = render(<QueueMeter />);
    const button = await screen.findByRole('button', {
      name: 'AI chat queue — click for details',
    });

    await waitFor(() => expect(button).toHaveTextContent('System'));
    const chipAvatar = button.querySelector<HTMLElement>('.gezel-icon-fallback');
    expect(chipAvatar?.style.background).toBe('var(--accent)');
    expect(chipAvatar?.style.color).toBe('var(--accent-selection-ink)');

    await userEvent.click(button);
    const panel = await screen.findByLabelText('AI chat queue');
    const panelAvatar = panel.querySelector<HTMLElement>('.gezel-icon-fallback');
    expect(panelAvatar?.style.background).toBe('var(--accent)');
    expect(panelAvatar?.style.color).toBe('var(--accent-selection-ink)');
    expect(container.querySelectorAll('.gezel-icon-fallback')).toHaveLength(2);
    expect(screen.queryByText(/Unknown/i)).not.toBeInTheDocument();
    expect(
      within(panel).queryByRole('button', { name: /Stop active chat/ }),
    ).not.toBeInTheDocument();
  });

  it('refreshes a newly recruited gezel instead of mislabeling their turn as System', async () => {
    vi.mocked(api.getConfig).mockResolvedValue({
      provider: 'llama-cpp',
      roleBasedNameOnlyMode: false,
      showPoppetjes: true,
    } as ConfigResponse);
    vi.mocked(api.getQueueStatus).mockResolvedValue(ACTIVE_STATUS);
    vi.mocked(api.listGezels)
      .mockResolvedValueOnce({ gezels: [] } as never)
      .mockResolvedValue({ gezels: [ALEJANDRO] } as never);

    render(<QueueMeter />);
    const button = await screen.findByRole('button', {
      name: 'AI chat queue — click for details',
    });

    await waitFor(() => expect(button).toHaveTextContent('gez-1'));
    expect(button).not.toHaveTextContent('System');

    window.dispatchEvent(
      new CustomEvent('gezel:gezel-updated', { detail: { id: 'gez-1', name: 'Alejandro' } }),
    );

    await waitFor(() => expect(button).toHaveTextContent('Alejandro'));
    expect(api.listGezels).toHaveBeenCalledTimes(2);
  });

  it('stays visible while the on-device engine is still loading', async () => {
    // A turn is in flight on the not-yet-registered provider.
    mockLiveTurns.set('sess-1', liveTurn({ gezelId: 'gez-1' }));

    render(<QueueMeter />);

    // The chip surfaces even though `status.providers['llama-cpp']` is
    // absent — the regression was that this went dark during preparing.
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: 'AI chat queue — click for details' }),
      ).toBeInTheDocument();
    });
  });

  it('lists the waiting turn with its gezel + phase and a cancel control', async () => {
    mockLiveTurns.set(
      'sess-1',
      liveTurn({ gezelId: 'gez-1', projectId: 'project-7', label: 'Loading model' }),
    );

    render(<QueueMeter />);
    const button = await screen.findByRole('button', {
      name: 'AI chat queue — click for details',
    });
    await userEvent.click(button);

    // Gezel name resolved from the listGezels map, plus the live phase.
    const panel = await screen.findByLabelText('AI chat queue');
    expect(within(panel).getByText('Alejandro')).toBeInTheDocument();
    expect(
      within(panel).getByText('Language Trainer · Spanish lessons · Loading model'),
    ).toBeInTheDocument();

    // Cancel targets the session id, not a provider-queue entry id —
    // there's no provider queue yet during preparing.
    await userEvent.click(screen.getByRole('button', { name: 'Cancel queued turn' }));
    expect(api.cancelChatSessionTurn).toHaveBeenCalledWith('sess-1');
  });

  it('opens the exact queued chat, including its project', async () => {
    mockLiveTurns.set('sess-1', liveTurn({ gezelId: 'gez-1', label: 'Loading model' }));
    vi.mocked(api.getChatSession).mockResolvedValue({
      version: 1,
      id: 'sess-1',
      gezelId: 'gez-1',
      projectId: 'project-7',
      providerName: 'llama-cpp',
      title: 'Queued work',
      createdAt: '2026-07-28T00:00:00.000Z',
      lastActivityAt: '2026-07-28T00:00:00.000Z',
      messages: [],
      providerState: {},
    } as never);
    const dispatch = vi.spyOn(window, 'dispatchEvent');

    render(<QueueMeter />);
    await userEvent.click(
      await screen.findByRole('button', { name: 'AI chat queue — click for details' }),
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Open chat with Alejandro' }));

    await waitFor(() => expect(api.getChatSession).toHaveBeenCalledWith('sess-1'));
    const events = dispatch.mock.calls
      .map(([event]) => event)
      .filter((event): event is CustomEvent => event instanceof CustomEvent);
    expect(events.find((event) => event.type === 'gezel:open-tab')?.detail).toEqual({
      kind: 'gezel',
      id: 'gez-1',
    });
    expect(events.find((event) => event.type === 'gezel:open-session')?.detail).toEqual({
      gezelId: 'gez-1',
      sessionId: 'sess-1',
      projectId: 'project-7',
    });
  });

  it('renders nothing when the active provider is cloud (no on-device turns)', async () => {
    vi.mocked(api.getConfig).mockResolvedValue({ provider: 'copilot' } as ConfigResponse);
    // Cloud provider → hook stays disabled → empty map (mocked here).
    mockLiveTurns = new Map();

    const { container } = render(<QueueMeter />);
    // Let the config + status polls settle.
    await waitFor(() => expect(api.getConfig).toHaveBeenCalled());
    await waitFor(() => expect(api.getQueueStatus).toHaveBeenCalled());

    expect(container.querySelector('.queue-meter')).toBeNull();
  });

  it('labels ambient queue work as deferred until idle', async () => {
    vi.mocked(api.getQueueStatus).mockResolvedValue({
      providers: {
        'llama-cpp': {
          running: 0,
          queuedInteractive: 0,
          queuedBackground: 2,
          ambientHeld: 2,
          concurrency: 1,
          interactiveConcurrency: 1,
          backgroundConcurrency: 1,
          active: [],
          pending: [
            {
              id: 1,
              lane: 'background',
              gezelId: 'gez-1',
              job: 'memory · abc12345',
              ambient: true,
              waitedMs: 30_000,
            },
            {
              id: 2,
              lane: 'background',
              gezelId: 'gez-1',
              job: 'summary · def67890',
              ambient: true,
              waitedMs: 20_000,
            },
          ],
        },
      },
      taskRunner: { pendingCount: 0, pendingByGezel: {}, pendingByProject: {} },
      sessions: [],
      cache: [],
      at: '',
    });

    render(<QueueMeter />);
    await userEvent.click(
      await screen.findByRole('button', { name: 'AI chat queue — click for details' }),
    );

    const providerSummary = await screen.findByText(/0 \/ 1 in flight/);
    expect(providerSummary).toHaveTextContent('0 / 1 in flight · 2 deferred until idle');
    expect(screen.queryByText(/2 queued/)).not.toBeInTheDocument();
    expect(screen.getAllByText(/deferred until idle/)).toHaveLength(3);
  });

  it('uses the live interactive width when a stale broker batch fallback says 1', async () => {
    vi.mocked(api.getQueueStatus).mockResolvedValue({
      providers: {
        'llama-cpp': {
          running: 1,
          runningInteractive: 1,
          queuedInteractive: 0,
          queuedBackground: 1,
          concurrency: 5,
          interactiveConcurrency: 4,
          backgroundConcurrency: 3,
          maxConcurrency: 1,
          active: [{ gezelId: 'gez-1', runningForMs: 5000 }],
          pending: [{ id: 2, lane: 'background', waitedMs: 1000 }],
        },
      },
      taskRunner: { pendingCount: 0, pendingByGezel: {}, pendingByProject: {} },
      sessions: [],
      cache: [],
      at: '',
    });

    render(<QueueMeter />);
    await userEvent.click(
      await screen.findByRole('button', { name: 'AI chat queue — click for details' }),
    );

    expect(await screen.findByText('1 / 4 in flight · 1 queued')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Chats can use all 4 slots. Background work takes at most 3, so a chat can always start.',
      ),
    ).toBeInTheDocument();
  });

  it('shows only the active count when every known item is in flight', async () => {
    vi.mocked(api.getQueueStatus).mockResolvedValue({
      providers: {
        'llama-cpp': {
          running: 2,
          queuedInteractive: 0,
          queuedBackground: 0,
          concurrency: 1,
          maxConcurrency: 1,
          active: [
            { gezelId: 'gez-1', runningForMs: 5000 },
            { gezelId: 'gez-1', runningForMs: 3000 },
          ],
          pending: [],
        },
      },
      taskRunner: { pendingCount: 0, pendingByGezel: {}, pendingByProject: {} },
      sessions: [],
      cache: [],
      at: '',
    });

    render(<QueueMeter />);
    await userEvent.click(
      await screen.findByRole('button', { name: 'AI chat queue — click for details' }),
    );

    expect(await screen.findByText('2 in flight')).toBeInTheDocument();
    expect(screen.queryByText('2 / 1 in flight')).not.toBeInTheDocument();
  });
});

describe('QueueMeter — cloud and CLI providers', () => {
  beforeEach(() => {
    mockLiveTurns = new Map();
    vi.mocked(api.listGezels).mockResolvedValue({ gezels: [ALEJANDRO] } as never);
    vi.mocked(api.listProjects).mockResolvedValue({
      projects: [{ id: 'project-7', name: 'Spanish lessons' }],
    } as never);
    vi.mocked(api.cancelProviderQueueItem).mockResolvedValue({ cancelled: true });
  });

  it.each(CLOUD_AND_CLI_QUEUE_CASES)(
    'shows running and queued work for $label',
    async ({ provider, label }) => {
      vi.mocked(api.getConfig).mockResolvedValue({
        provider,
        roleBasedNameOnlyMode: true,
      } as ConfigResponse);
      vi.mocked(api.getQueueStatus).mockResolvedValue(busyProviderStatus(provider));

      const { container } = render(<QueueMeter />);
      const button = await screen.findByRole('button', {
        name: 'AI chat queue — click for details',
      });

      await waitFor(() => {
        expect(container.querySelector('.queue-meter-chip')).not.toBeNull();
      });
      const chip = container.querySelector('.queue-meter-chip');
      expect(chip).toHaveAttribute('title', label);
      expect(chip?.querySelector('.queue-meter-chip-label-full')).toHaveTextContent(label);
      expect(chip?.querySelector('.queue-meter-chip-counts')).toHaveTextContent('1+1');

      await userEvent.click(button);
      const panel = await screen.findByLabelText('AI chat queue');
      expect(within(panel).getByText(label)).toBeInTheDocument();
      expect(within(panel).getByText('1 / 4 in flight · 1 queued')).toBeInTheDocument();

      await userEvent.click(within(panel).getByRole('button', { name: 'Cancel queued turn' }));
      expect(api.cancelProviderQueueItem).toHaveBeenLastCalledWith(provider, 71);
    },
  );
});

describe('QueueMeter — running vs waiting rows', () => {
  beforeEach(() => {
    mockLiveTurns = new Map();
    vi.mocked(api.listGezels).mockResolvedValue({ gezels: [ALEJANDRO] } as never);
    vi.mocked(api.listProjects).mockResolvedValue({
      projects: [{ id: 'project-7', name: 'Spanish lessons' }],
    } as never);
    vi.mocked(api.getConfig).mockResolvedValue({ provider: 'openai' } as ConfigResponse);
  });

  it('names both groups and marks the waiting rows when work is running and queued', async () => {
    vi.mocked(api.getQueueStatus).mockResolvedValue(busyProviderStatus('openai'));

    const { container } = render(<QueueMeter />);
    await userEvent.click(
      await screen.findByRole('button', { name: 'AI chat queue — click for details' }),
    );

    const panel = await screen.findByLabelText('AI chat queue');
    expect(within(panel).getByText('Running')).toBeInTheDocument();
    expect(within(panel).getByText('Waiting')).toBeInTheDocument();
    expect(container.querySelectorAll('.queue-meter-panel-item-waiting')).toHaveLength(1);
    expect(within(panel).getByTitle('Running for 12s')).toHaveTextContent('12s');
    expect(within(panel).getByTitle('Waiting 4s for a free slot')).toHaveTextContent('4s');
  });

  it('leaves the headings off when nothing is waiting', async () => {
    vi.mocked(api.getConfig).mockResolvedValue({ provider: 'llama-cpp' } as ConfigResponse);
    vi.mocked(api.getQueueStatus).mockResolvedValue(ACTIVE_STATUS);

    render(<QueueMeter />);
    await userEvent.click(
      await screen.findByRole('button', { name: 'AI chat queue — click for details' }),
    );

    const panel = await screen.findByLabelText('AI chat queue');
    expect(within(panel).getByText('1 in flight')).toBeInTheDocument();
    expect(within(panel).queryByText('Running')).not.toBeInTheDocument();
    expect(within(panel).queryByText('Waiting')).not.toBeInTheDocument();
  });
});

describe('QueueMeter — night-shift handoffs', () => {
  /** Four handoffs parked for tonight's window, engine idle. */
  const SCHEDULED_ONLY: QueueStatusResponse = {
    providers: {},
    taskRunner: {
      pendingCount: 4,
      pendingByGezel: { 'gez-1': 4 },
      pendingByProject: { 'project-7': 4 },
      dispatchable: { count: 0, byGezel: {} },
      scheduled: { count: 4, byGezel: { 'gez-1': 4 } },
      nightShift: { active: false, opensAt: '2026-08-02T22:00:00.000Z' },
    },
    sessions: [],
    cache: [],
    at: '',
  };

  beforeEach(() => {
    mockLiveTurns = new Map();
    vi.mocked(api.getConfig).mockResolvedValue({ provider: 'llama-cpp' } as ConfigResponse);
    vi.mocked(api.listGezels).mockResolvedValue({ gezels: [ALEJANDRO] } as never);
    vi.mocked(api.listProjects).mockResolvedValue({
      projects: [{ id: 'project-7', name: 'Spanish lessons' }],
    } as never);
  });

  // The bug this guards: a "Tasks 4" chip sat in the header all day for
  // work that was never stuck — it was waiting for 22:00 by design.
  it('stays hidden when the only queued work is scheduled for the night shift', async () => {
    vi.mocked(api.getQueueStatus).mockResolvedValue(SCHEDULED_ONLY);

    const { container } = render(<QueueMeter />);
    await waitFor(() => expect(api.getQueueStatus).toHaveBeenCalled());
    expect(container.querySelector('.queue-meter-button')).toBeNull();
  });

  it('counts only dispatchable work in the chip and explains the rest', async () => {
    vi.mocked(api.getQueueStatus).mockResolvedValue({
      ...SCHEDULED_ONLY,
      taskRunner: {
        ...SCHEDULED_ONLY.taskRunner,
        pendingCount: 5,
        dispatchable: { count: 1, byGezel: { 'gez-1': 1 } },
        holdReason: 'provider-busy',
      },
    });

    render(<QueueMeter />);
    const button = await screen.findByRole('button', {
      name: 'AI chat queue — click for details',
    });
    expect(button).toHaveTextContent('Tasks1');
    expect(button).not.toHaveTextContent('Tasks5');

    await userEvent.click(button);
    const panel = await screen.findByLabelText('AI chat queue');
    expect(within(panel).getByText('1 pending dispatch')).toBeInTheDocument();
    expect(within(panel).getByText('Waiting for a free slot.')).toBeInTheDocument();
    expect(within(panel).getByText('4 scheduled')).toBeInTheDocument();
    expect(within(panel).getByText(/Nothing to do\./)).toBeInTheDocument();
  });

  it('names the quota reserve instead of the window clock while it holds work', async () => {
    vi.mocked(api.getQueueStatus).mockResolvedValue({
      ...SCHEDULED_ONLY,
      taskRunner: {
        ...SCHEDULED_ONLY.taskRunner,
        pendingCount: 5,
        dispatchable: { count: 1, byGezel: { 'gez-1': 1 } },
        nightShift: { active: true, opensAt: '2026-08-02T22:00:00.000Z', quotaHold: true },
      },
    });

    render(<QueueMeter />);
    const button = await screen.findByRole('button', {
      name: 'AI chat queue — click for details',
    });
    await userEvent.click(button);
    const panel = await screen.findByLabelText('AI chat queue');
    expect(
      within(panel).getByText('Holding to protect your subscription quota.'),
    ).toBeInTheDocument();
    expect(within(panel).queryByText(/Starts/)).not.toBeInTheDocument();
  });

  it('names the sticky reason when AI engagement is switched off', async () => {
    vi.mocked(api.getQueueStatus).mockResolvedValue({
      ...SCHEDULED_ONLY,
      taskRunner: {
        pendingCount: 1,
        pendingByGezel: { 'gez-1': 1 },
        pendingByProject: { 'project-7': 1 },
        dispatchable: { count: 1, byGezel: { 'gez-1': 1 } },
        scheduled: { count: 0, byGezel: {} },
        holdReason: 'engagement-off',
      },
    });

    render(<QueueMeter />);
    await userEvent.click(
      await screen.findByRole('button', { name: 'AI chat queue — click for details' }),
    );
    const panel = await screen.findByLabelText('AI chat queue');
    expect(within(panel).getByText(/AI engagement is off/)).toBeInTheDocument();
  });

  it('names the reactive setting rather than calling the AI off', async () => {
    vi.mocked(api.getQueueStatus).mockResolvedValue({
      ...SCHEDULED_ONLY,
      taskRunner: {
        pendingCount: 1,
        pendingByGezel: { 'gez-1': 1 },
        pendingByProject: { 'project-7': 1 },
        dispatchable: { count: 1, byGezel: { 'gez-1': 1 } },
        scheduled: { count: 0, byGezel: {} },
        holdReason: 'engagement-paused',
      },
    });

    render(<QueueMeter />);
    await userEvent.click(
      await screen.findByRole('button', { name: 'AI chat queue — click for details' }),
    );
    const panel = await screen.findByLabelText('AI chat queue');
    expect(within(panel).getByText(/Activity is set to reactive/)).toBeInTheDocument();
  });

  // A daemon older than this UI sends only the totals. Falling back to
  // "everything is dispatchable" keeps the old behavior rather than
  // silently hiding work the UI can't classify.
  it('falls back to the legacy totals when the daemon sends no split', async () => {
    vi.mocked(api.getQueueStatus).mockResolvedValue({
      providers: {},
      taskRunner: {
        pendingCount: 3,
        pendingByGezel: { 'gez-1': 3 },
        pendingByProject: { 'project-7': 3 },
      },
      sessions: [],
      cache: [],
      at: '',
    });

    render(<QueueMeter />);
    const button = await screen.findByRole('button', {
      name: 'AI chat queue — click for details',
    });
    expect(button).toHaveTextContent('Tasks3');
  });
});
