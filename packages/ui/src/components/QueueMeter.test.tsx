import type { ConfigResponse, QueueStatusResponse } from '@bendyline/gezel-client';
import { render, screen, waitFor } from '@testing-library/react';
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

function liveTurn(overrides: Partial<LiveTurnState> = {}): LiveTurnState {
  return {
    phase: 'prefill',
    label: 'Preparing',
    startedAt: Date.now(),
    lastEventAt: Date.now(),
    ...overrides,
  };
}

describe('QueueMeter — preparing window', () => {
  beforeEach(() => {
    mockLiveTurns = new Map();
    vi.mocked(api.getConfig).mockResolvedValue({ provider: 'llama-cpp' } as ConfigResponse);
    vi.mocked(api.getQueueStatus).mockResolvedValue(PREPARING_STATUS);
    vi.mocked(api.listGezels).mockResolvedValue({
      gezels: [{ id: 'gez-1', name: 'Alejandro' }],
    } as never);
  });

  it('stays visible while the on-device engine is still loading', async () => {
    // A turn is in flight on the not-yet-registered provider.
    mockLiveTurns.set('sess-1', liveTurn({ gezelId: 'gez-1' }));

    render(<QueueMeter />);

    // The chip surfaces even though `status.providers['llama-cpp']` is
    // absent — the regression was that this went dark during preparing.
    await waitFor(() => {
      expect(screen.getByTitle('AI chat queue — click for details')).toBeInTheDocument();
    });
  });

  it('lists the waiting turn with its gezel + phase and a cancel control', async () => {
    mockLiveTurns.set('sess-1', liveTurn({ gezelId: 'gez-1', label: 'Loading model' }));

    render(<QueueMeter />);
    const button = await screen.findByTitle('AI chat queue — click for details');
    await userEvent.click(button);

    // Gezel name resolved from the listGezels map, plus the live phase.
    expect(await screen.findByText('Alejandro')).toBeInTheDocument();
    expect(screen.getByText(/Loading model/)).toBeInTheDocument();

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
    await userEvent.click(await screen.findByTitle(/AI chat queue/));
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
});
