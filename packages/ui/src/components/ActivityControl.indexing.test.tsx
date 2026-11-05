import type { ChatEventEnvelope } from '@bendyline/gezel';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';
import type { IndexProgress } from './indexing-activity.js';

const listeners = vi.hoisted(() => new Set<(event: ChatEventEnvelope) => void>());
vi.mock('../api.js', () => ({ api: createMockApi() }));
vi.mock('../shared-chat-events.js', () => ({
  async *streamSharedAllChatEvents({ signal }: { signal: AbortSignal }) {
    const queue: ChatEventEnvelope[] = [];
    let wake: (() => void) | undefined;
    const receive = (event: ChatEventEnvelope) => {
      queue.push(event);
      wake?.();
    };
    const abort = () => wake?.();
    listeners.add(receive);
    signal.addEventListener('abort', abort);
    try {
      while (!signal.aborted) {
        const event = queue.shift();
        if (event) yield event;
        else
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
      }
    } finally {
      listeners.delete(receive);
      signal.removeEventListener('abort', abort);
    }
  },
}));
vi.mock('./chat-bubbles.js', () => ({
  RenderedMarkdown: ({ markdown }: { markdown: string }) => <p>{markdown}</p>,
}));

const { api } = await import('../api.js');
const { ActivityControl } = await import('./ActivityControl.js');
const { ActivityProvider } = await import('./activity-context.js');

async function progress(event: Partial<IndexProgress>) {
  await act(async () => {
    const envelope: ChatEventEnvelope = {
      sessionId: '',
      gezelId: '',
      projectId: '',
      event: {
        type: 'index_progress',
        phase: 'scan',
        state: 'started',
        projectId: 'squisq',
        gezelId: 'saara',
        gezelName: 'Saara',
        ...event,
      },
    };
    for (const receive of listeners) receive(envelope);
  });
}

async function mount() {
  render(
    <ActivityProvider>
      <ActivityControl />
    </ActivityProvider>,
  );
  await screen.findByRole('button', { name: 'Activity — All quiet' });
}

beforeEach(() => {
  vi.mocked(api.listGezels).mockResolvedValue({
    gezels: [
      { id: 'saara', name: 'Saara' },
      { id: 'noor', name: 'Noor' },
    ],
  } as never);
  vi.mocked(api.listProjects).mockResolvedValue({
    projects: [
      { id: 'squisq', name: 'Squisq' },
      { id: 'shop', name: 'Shop' },
    ],
  } as never);
});

afterEach(() => {
  cleanup();
  listeners.clear();
  vi.useRealTimers();
});

describe('indexing in Activity', () => {
  it('keeps a scan working until it ends, then shows its result briefly', async () => {
    await mount();
    vi.useFakeTimers();
    await progress({ detail: '2305 files…' });
    const trigger = screen.getByRole('button', { name: 'Activity — 1 working · Saara' });
    expect(trigger).toHaveClass('is-working');
    expect(within(trigger).getByText('Saara')).toBeVisible();
    expect(within(trigger).queryByText('All quiet')).toBeNull();
    fireEvent.click(trigger);
    const working = screen.getByRole('region', { name: 'Working' });
    expect(within(working).getByText('Scanning · Squisq')).toBeVisible();
    expect(within(working).getByText('2305 files…')).toBeVisible();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(trigger).toHaveClass('is-working');
    expect(within(working).getByText('Scanning · Squisq')).toBeVisible();

    const open = vi.fn();
    window.addEventListener('gezel:open-tab', open);
    try {
      fireEvent.click(within(working).getByRole('button', { name: 'Open Saara' }));
      expect(open.mock.calls[0]?.[0].detail).toMatchObject({ kind: 'gezel', id: 'saara' });
    } finally {
      window.removeEventListener('gezel:open-tab', open);
    }

    await progress({ state: 'ended', detail: '2305 files in 10s' });
    expect(trigger).not.toHaveClass('is-working');
    expect(trigger).toHaveAccessibleName('Activity — 1 ready');
    fireEvent.click(trigger);
    const ready = screen.getByRole('region', { name: 'Ready' });
    expect(within(ready).getByText('Scan finished · Squisq')).toBeVisible();
    expect(within(ready).getByText('2305 files in 10s')).toBeVisible();
    expect(within(ready).getByRole('button', { name: 'Open project' })).toBeVisible();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_001);
    });
    expect(trigger).toHaveAccessibleName('Activity — All quiet');
  });

  it('tracks concurrent projects independently and expires batch-only pulses', async () => {
    await mount();
    vi.useFakeTimers();
    await progress({});
    await progress({ projectId: 'shop', gezelId: 'noor', gezelName: 'Noor' });
    // A later phase of Squisq's job, not a second job.
    await progress({ phase: 'review', state: 'progress', detail: '3 files reviewed' });
    const trigger = screen.getByRole('button', { name: 'Activity — 2 working · Saara, Noor' });
    expect(within(trigger).getByText('+1')).toBeVisible();
    expect(trigger.querySelectorAll('.activity-control-avatar')).toHaveLength(2);

    await progress({ state: 'ended' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_001);
    });
    expect(trigger).toHaveAccessibleName('Activity — 1 working · Noor');
    fireEvent.click(trigger);
    const working = screen.getByRole('region', { name: 'Working' });
    expect(within(working).getByText('Scanning · Shop')).toBeVisible();
    expect(within(working).queryByText(/Squisq/)).toBeNull();
  });

  it('counts one catch-up drive once across its phases and its model slot', async () => {
    const at = '2026-10-02T12:00:00.000Z';
    const queues = {
      providers: {
        mlx: {
          running: 1,
          queuedInteractive: 0,
          queuedBackground: 0,
          concurrency: 2,
          // The Librarian's study call: no chat session, so the snapshot
          // counts it as anonymous background work.
          active: [{ gezelId: 'saara', projectId: 'squisq', job: 'summary', runningForMs: 2_000 }],
          pending: [],
        },
      },
      sessions: [],
      cache: [],
      at,
      taskRunner: { pendingCount: 0, pendingByGezel: {}, pendingByProject: {} },
    };
    vi.mocked(api.getActivityStatus).mockResolvedValue({
      items: [
        {
          id: 'background:running',
          section: 'working',
          title: 'Background work',
          detail: '1 background operation running.',
          questionIds: [],
        },
      ],
      questions: [],
      queues,
      at,
    } as never);
    render(
      <ActivityProvider>
        <ActivityControl />
      </ActivityProvider>,
    );
    await screen.findByRole('button', { name: 'Activity — 1 working · Saara' });
    vi.useFakeTimers();

    // The drive opens without a worker, wraps the static rescan's own start
    // and end, then reports media and study batches.
    await progress({ gezelId: undefined, gezelName: undefined, detail: 'Index catch-up' });
    await progress({});
    await progress({ state: 'ended', detail: '2305 files in 10s' });
    await progress({ phase: 'shadow', state: 'progress', detail: '2 media files described' });
    await progress({ phase: 'enrich', state: 'progress', detail: '8 files enriched' });
    const trigger = screen.getByRole('button', { name: 'Activity — 1 working · Saara' });
    fireEvent.click(trigger);
    const working = screen.getByRole('region', { name: 'Working' });
    expect(within(working).getByText('Studying · Squisq')).toBeVisible();
    expect(within(working).queryByText('Background work')).toBeNull();

    // A quiet stretch between batches does not end a job that started.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(trigger).toHaveAccessibleName('Activity — 1 working · Saara');
    expect(within(working).getByText('Studying · Squisq')).toBeVisible();
  });
});
