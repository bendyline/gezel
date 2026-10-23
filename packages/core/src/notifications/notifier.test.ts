import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatEventEnvelope } from '../schemas/gezel.js';
import type { ProjectReminder } from '../schemas/notifications.js';
import type { Question } from '../schemas/question.js';
import type { EarnedNotification, NotificationLedger } from './index.js';
import { EarnedNotifier } from './notifier.js';

const NOW = new Date('2026-10-08T06:00:00');

function morningCard(id = 'q1'): ChatEventEnvelope {
  return {
    sessionId: '',
    gezelId: '',
    projectId: 'default',
    event: {
      type: 'question_asked',
      question: {
        id,
        projectId: 'default',
        gezelId: 'wren',
        sessionId: '',
        prompt: 'Overnight your crew read 1,204 files.',
        createdAt: NOW.toISOString(),
        intent: {
          kind: 'night-shift-review',
          windowKey: '2026-10-07',
          tasksCompleted: 0,
          reports: [],
          indexing: { filesIndexed: 1204, filesReviewed: 0, mediaDescribed: 0 },
        },
      } as Question,
    },
  } as ChatEventEnvelope;
}

function fixture(opts: { config?: Record<string, unknown>; reminders?: ProjectReminder[] } = {}) {
  let now = NOW;
  let ledger: NotificationLedger | undefined;
  const delivered: EarnedNotification[] = [];
  const client = {
    getConfig: vi.fn(async () => ({ social: false, ...opts.config })),
    listGezels: vi.fn(async () => ({ gezels: [{ id: 'wren', name: 'Wren' }] })),
    listReminders: vi.fn(async () => ({ reminders: opts.reminders ?? [] })),
  };
  const notifier = new EarnedNotifier({
    client,
    deliver: (n) => delivered.push(n),
    watching: () => false,
    readLedger: () => ledger,
    writeLedger: (next) => {
      ledger = next;
    },
    now: () => now,
  });
  return {
    notifier,
    delivered,
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
      vi.advanceTimersByTime(ms);
    },
    /** The machine sleeps: the wall clock moves, timers do not. */
    sleep(ms: number) {
      now = new Date(now.getTime() + ms);
    },
  };
}

afterEach(() => vi.useRealTimers());

describe('EarnedNotifier', () => {
  it('says the night’s review once, with the card as the body', async () => {
    vi.useFakeTimers();
    const { notifier, delivered, advance } = fixture();
    await notifier.handle(morningCard());
    await notifier.handle(morningCard());
    advance(5_000);
    expect(delivered).toEqual([
      {
        title: 'Your crew worked overnight',
        body: 'Overnight your crew read 1,204 files.',
        view: 'home',
        kinds: ['morning'],
      },
    ]);
  });

  it('stays quiet when the morning notification is turned off', async () => {
    vi.useFakeTimers();
    const { notifier, delivered, advance } = fixture({
      config: { nightShift: { morningNotification: false } },
    });
    await notifier.handle(morningCard());
    advance(5_000);
    expect(delivered).toEqual([]);
  });

  it('fires a project reminder at its time, and one missed in sleep on wake', async () => {
    vi.useFakeTimers();
    const reminder = (projectId: string, at: string): ProjectReminder => ({
      projectId,
      at,
      title: 'Cards are due',
      body: '4 cards to review',
      setAt: NOW.toISOString(),
    });
    const { notifier, delivered, advance, sleep } = fixture({
      reminders: [
        reminder('cards', '2026-10-08T09:00:00'),
        reminder('verbs', '2026-10-08T15:00:00'),
      ],
    });
    await notifier.replanReminders();
    advance(3 * 60 * 60 * 1000);
    advance(5_000);
    expect(delivered.map((n) => n.title)).toEqual(['Cards are due']);
    // Slept through the second one: the wake-up fires it.
    sleep(7 * 60 * 60 * 1000);
    notifier.resume();
    advance(5_000);
    expect(delivered).toHaveLength(2);
    notifier.dispose();
  });
});

describe('EarnedNotifier lookout alerts', () => {
  function fired(firingId: string, alert = true): ChatEventEnvelope {
    return {
      sessionId: '',
      gezelId: '',
      projectId: 'home',
      event: {
        type: 'lookout_fired',
        projectId: 'home',
        lookoutId: 'lk1',
        firingId,
        name: 'Cat in the mud room',
        at: NOW.toISOString(),
        ...(alert ? { alert: { title: 'Cat in the mud room', body: 'Mud room, 6:00 AM' } } : {}),
      },
    } as ChatEventEnvelope;
  }

  it('says a lookout alert at once, ungrouped, and past the daily cap', async () => {
    vi.useFakeTimers();
    const { notifier, delivered } = fixture({ config: { notifications: { dailyCap: 0 } } });
    await notifier.handle(fired('f1'));
    await notifier.handle(fired('f2'));
    expect(delivered).toEqual([
      {
        title: 'Cat in the mud room',
        body: 'Mud room, 6:00 AM',
        view: 'projects',
        kinds: ['lookout'],
      },
      {
        title: 'Cat in the mud room',
        body: 'Mud room, 6:00 AM',
        view: 'projects',
        kinds: ['lookout'],
      },
    ]);
  });

  it('says each firing once, and nothing for a lookout without a notify action', async () => {
    vi.useFakeTimers();
    const { notifier, delivered } = fixture();
    await notifier.handle(fired('f1'));
    await notifier.handle(fired('f1'));
    await notifier.handle(fired('f3', false));
    expect(delivered).toHaveLength(1);
  });
});
