import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatEvent, ChatEventEnvelope } from '../schemas/gezel.js';
import type { ProjectReminder } from '../schemas/notifications.js';
import type { Question } from '../schemas/question.js';
import {
  type EarnedContext,
  type EarnedItem,
  NotificationGate,
  type NotificationLedger,
  admitNotifications,
  earnedItemFor,
  parseReminderRequest,
  planReminders,
} from './policy.js';

const NOW = new Date('2026-10-07T10:00:00');
const plain: EarnedContext = {
  social: false,
  gezelName: (id) => ({ anna: 'Anna' })[id],
  morningNotification: true,
};
const social: EarnedContext = { ...plain, social: true };

function envelope(event: ChatEvent, projectId = 'trip'): ChatEventEnvelope {
  return { sessionId: 's1', gezelId: 'anna', projectId, event };
}

function question(overrides: Partial<Question> = {}): Question {
  return {
    id: 'q1',
    projectId: 'trip',
    gezelId: 'anna',
    sessionId: 's1',
    prompt: 'Which week suits you?\nMore detail here.',
    createdAt: NOW.toISOString(),
    ...overrides,
  };
}

const asked = (q = question()) => envelope({ type: 'question_asked', question: q });
const settled = (taskRef = 'trip/4') =>
  envelope({
    type: 'task_settled',
    taskRef,
    title: 'Plan the trip',
    outcome: 'complete',
    gezelId: 'anna',
  });

function item(key: string): EarnedItem {
  return earnedItemFor(asked(question({ id: key })), plain)!;
}

describe('earned notifications', () => {
  it('earns nothing from events that are not questions, finished work, or level-ups', () => {
    const quiet: ChatEvent[] = [
      { type: 'night_shift', active: true, source: 'scheduled' },
      {
        type: 'task_event',
        eventId: 'e1',
        kind: 'task.updated',
        summary: 'Plan the trip: active',
        at: NOW.toISOString(),
      },
      { type: 'growth_updated', gezelId: 'anna' } as ChatEvent,
      { type: 'question_answered', question: question() },
      { type: 'reminders_updated', projectId: 'trip' },
      { type: 'task_settled', taskRef: 'trip/4', title: 'Plan the trip', outcome: 'canceled' },
    ];
    for (const event of quiet) {
      expect(earnedItemFor(envelope(event), plain)).toBeNull();
      expect(earnedItemFor(envelope(event), social)).toBeNull();
    }
  });

  it('never notifies on the clock alone: an idle gate delivers nothing', () => {
    vi.useFakeTimers();
    const deliver = vi.fn();
    let ledger: NotificationLedger | undefined;
    const gate = new NotificationGate({
      deliver,
      cap: () => 3,
      watching: () => false,
      load: () => ledger,
      save: (next) => {
        ledger = next;
      },
    });
    vi.advanceTimersByTime(7 * 24 * 60 * 60 * 1000);
    gate.flush();
    expect(deliver).not.toHaveBeenCalled();
    expect(planReminders([], { cap: 3, now: NOW })).toEqual([]);
  });

  it('speaks plainly with social mode off and in the gezel’s name with it on', () => {
    expect(earnedItemFor(asked(), plain)).toMatchObject({
      title: 'Gezel needs your input',
      body: 'Which week suits you?',
    });
    expect(earnedItemFor(asked(), social)).toMatchObject({ title: 'Anna has a question' });
    expect(earnedItemFor(settled(), plain)).toMatchObject({
      title: 'Your work is ready',
      body: 'Plan the trip is finished.',
      view: 'projects',
    });
    expect(earnedItemFor(settled(), social)).toMatchObject({
      title: 'Anna finished “Plan the trip”',
    });
    const levelUp = envelope({
      type: 'growth_level_up',
      gezelId: 'anna',
      gezelName: 'Anna',
      toLevel: 3,
    });
    expect(earnedItemFor(levelUp, plain)).toBeNull();
    expect(earnedItemFor(levelUp, social)).toMatchObject({ title: 'Anna reached level 3' });
  });

  it('says the night’s review once, and not at all when it is turned off', () => {
    const review = asked(
      question({ intent: { kind: 'night-shift-review' } as Question['intent'] }),
    );
    expect(earnedItemFor(review, plain)).toMatchObject({
      kind: 'morning',
      title: 'Your crew worked overnight',
    });
    expect(earnedItemFor(review, { ...plain, morningNotification: false })).toBeNull();
    const finishedCard = asked(
      question({ intent: { kind: 'task-finished', taskRef: 'trip/4' } as Question['intent'] }),
    );
    expect(earnedItemFor(finishedCard, plain)).toBeNull();
  });
});

describe('the daily allowance', () => {
  it('stops at the cap and starts over the next day', () => {
    let ledger: NotificationLedger | undefined;
    const sent: string[] = [];
    for (const key of ['a', 'b', 'c', 'd', 'e']) {
      const result = admitNotifications(ledger, [item(key)], { cap: 3, now: NOW });
      ledger = result.ledger;
      if (result.notification) sent.push(key);
    }
    expect(sent).toEqual(['a', 'b', 'c']);
    const tomorrow = new Date('2026-10-08T08:00:00');
    expect(
      admitNotifications(ledger, [item('f')], { cap: 3, now: tomorrow }).notification,
    ).not.toBeNull();
    // Held items were noted, so tomorrow does not dredge them up.
    expect(
      admitNotifications(ledger, [item('d')], { cap: 3, now: tomorrow }).notification,
    ).toBeNull();
  });

  it('is off at zero', () => {
    expect(
      admitNotifications(undefined, [item('a')], { cap: 0, now: NOW }).notification,
    ).toBeNull();
  });

  it('never says the same thing twice', () => {
    const first = admitNotifications(undefined, [item('a')], { cap: 3, now: NOW });
    const replay = admitNotifications(first.ledger, [item('a')], { cap: 3, now: NOW });
    expect(replay.notification).toBeNull();
    expect(replay.ledger.sent).toBe(1);
  });
});

describe('grouping', () => {
  afterEach(() => vi.useRealTimers());

  it('folds what arrives together into one notification', () => {
    vi.useFakeTimers();
    const deliver = vi.fn();
    let ledger: NotificationLedger | undefined;
    const gate = new NotificationGate({
      deliver,
      cap: () => 3,
      watching: () => false,
      load: () => ledger,
      save: (next) => {
        ledger = next;
      },
      now: () => NOW,
    });
    gate.offer(earnedItemFor(asked(), plain)!);
    gate.offer(earnedItemFor(settled(), plain)!);
    gate.offer(earnedItemFor(settled('trip/5'), plain)!);
    gate.offer(earnedItemFor(settled('trip/6'), plain)!);
    expect(deliver).not.toHaveBeenCalled();
    vi.advanceTimersByTime(5_000);
    expect(deliver).toHaveBeenCalledOnce();
    expect(deliver.mock.calls[0]![0]).toMatchObject({
      title: '4 things are waiting',
      body: 'A question is waiting · “Plan the trip” is ready · “Plan the trip” is ready and 1 more',
      view: 'home',
    });
    expect(ledger?.sent).toBe(1);
  });

  it('says nothing while the person is watching, and nothing later about it', () => {
    vi.useFakeTimers();
    const deliver = vi.fn();
    let ledger: NotificationLedger | undefined;
    let watching = true;
    const gate = new NotificationGate({
      deliver,
      cap: () => 3,
      watching: () => watching,
      load: () => ledger,
      save: (next) => {
        ledger = next;
      },
      now: () => NOW,
    });
    gate.offer(earnedItemFor(asked(), plain)!);
    watching = false;
    gate.offer(earnedItemFor(asked(), plain)!);
    vi.advanceTimersByTime(5_000);
    expect(deliver).not.toHaveBeenCalled();
  });
});

describe('reminders', () => {
  const reminder = (projectId: string, at: string): ProjectReminder => ({
    projectId,
    at,
    title: 'Cards are due',
    setAt: NOW.toISOString(),
  });

  it('schedules future reminders in the week ahead, no more on one day than the cap', () => {
    const planned = planReminders(
      [
        reminder('past', '2026-10-07T09:00:00'),
        reminder('a', '2026-10-08T09:00:00'),
        reminder('b', '2026-10-08T10:00:00'),
        reminder('c', '2026-10-08T11:00:00'),
        reminder('d', '2026-10-09T09:00:00'),
        reminder('far', '2026-10-20T09:00:00'),
      ],
      { cap: 2, now: NOW },
    );
    expect(planned.map((r) => r.projectId)).toEqual(['a', 'b', 'd']);
    expect(planReminders([reminder('a', '2026-10-08T09:00:00')], { cap: 0, now: NOW })).toEqual([]);
  });

  it('accepts only a future time a script computed, within thirty days', () => {
    const opts = { projectId: 'cards', source: 'deck-store', now: NOW };
    expect(
      parseReminderRequest(
        { at: '2026-10-08T09:00:00Z', title: 'Cards are due', body: '4 cards to review' },
        opts,
      ),
    ).toMatchObject({ projectId: 'cards', title: 'Cards are due', source: 'deck-store' });
    expect(() => parseReminderRequest({ title: 'Hi' }, opts)).toThrow(/'at'/);
    expect(() => parseReminderRequest({ at: '2026-10-06T09:00:00Z', title: 'Hi' }, opts)).toThrow(
      /future/,
    );
    expect(() => parseReminderRequest({ at: '2026-12-20T09:00:00Z', title: 'Hi' }, opts)).toThrow(
      /30 days/,
    );
    expect(() => parseReminderRequest({ at: '2026-10-08T09:00:00Z' }, opts)).toThrow(/'title'/);
  });
});
