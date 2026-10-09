/**
 * Earned notifications: the one policy every host runs. A notification is
 * earned by something durable that happened — a question a gezel asked,
 * work the person asked for that finished, a level reached, the night's
 * review, or a reminder a project's own script computed from its state.
 * Nothing here can fire on the clock alone. Hosts own delivery (Electron's
 * `Notification`, the phone's local notifications); this module decides
 * what is worth saying, folds what arrives together into one, and holds the
 * rest once the day's allowance is spent.
 */

import type { ChatEventEnvelope } from '../schemas/gezel.js';
import {
  DEFAULT_NOTIFICATION_DAILY_CAP,
  NOTIFICATION_DAILY_CAP_MAX,
  type NotificationsConfig,
  type ProjectReminder,
  REMINDER_BODY_MAX,
  REMINDER_MAX_AHEAD_DAYS,
  REMINDER_TITLE_MAX,
} from '../schemas/notifications.js';
import type { Task } from '../schemas/task.js';

/** Items that arrive this close together become one notification. */
export const NOTIFICATION_GROUP_WINDOW_MS = 4_000;
/** Reminders are scheduled this far ahead; the rest wait for a later plan. */
export const REMINDER_HORIZON_DAYS = 7;
const SEEN_LIMIT = 200;
const DAY_MS = 24 * 60 * 60 * 1000;

export type EarnedKind = 'question' | 'ready' | 'level-up' | 'morning' | 'reminder';

export interface EarnedItem {
  /** Identity of the thing it is about, so a replay never notifies twice. */
  key: string;
  kind: EarnedKind;
  title: string;
  body: string;
  /** Its line in a grouped notification. */
  line: string;
  /** Where a click lands. */
  view: string;
}

export interface EarnedNotification {
  title: string;
  body: string;
  view: string;
  kinds: EarnedKind[];
}

export interface EarnedContext {
  social: boolean;
  /** The name to show for a gezel, honoring the host's naming mode. */
  gezelName(gezelId: string): string | undefined;
  /** `nightShift.morningNotification`; absent means on. */
  morningNotification: boolean;
}

export function notificationDailyCap(config: { notifications?: NotificationsConfig }): number {
  const cap = config.notifications?.dailyCap ?? DEFAULT_NOTIFICATION_DAILY_CAP;
  return Math.max(0, Math.min(NOTIFICATION_DAILY_CAP_MAX, Math.round(cap)));
}

/**
 * Work the person asked for in a chat: scheduled hosts, night-shift runs,
 * system jobs and fanout children settle without telling anyone (the host's
 * own wrap-up covers its crew). The rule the desktop's wrap-up and both
 * hosts' `task_settled` share.
 */
export function isOwnerLaunchedCompletion(task: Task, outcome: 'complete' | 'canceled'): boolean {
  if (outcome !== 'complete') return false;
  if (!task.launchSessionId) return false;
  if (task.parentTaskRef || task.cron || task.nightShift) return false;
  if (task.origin?.kind === 'system-job') return false;
  return true;
}

function firstLine(text: string, max = 140): string {
  const line = (text.split('\n').find((l) => l.trim()) ?? '').replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * The notification an event earns, or null. Only questions, finished
 * owner-launched work and level-ups qualify; every other event — heartbeats,
 * night-shift switches, task ticks — earns nothing. Social mode decides the
 * register: a gezel's name and voice, or plain status text. Growth stays out
 * of sight with social mode off, so a level-up says nothing then.
 */
export function earnedItemFor(envelope: ChatEventEnvelope, ctx: EarnedContext): EarnedItem | null {
  const event = envelope.event;
  if (event.type === 'question_asked') {
    const question = event.question;
    if (question.answer) return null;
    // The finished-work card rides beside `task_settled`, which says it.
    if (question.intent?.kind === 'task-finished') return null;
    if (question.intent?.kind === 'night-shift-review') {
      if (!ctx.morningNotification) return null;
      return {
        key: `morning:${question.id}`,
        kind: 'morning',
        title: 'Your crew worked overnight',
        body: firstLine(question.prompt, 200),
        line: 'Your crew worked overnight',
        view: 'home',
      };
    }
    const name = ctx.social ? ctx.gezelName(question.gezelId) : undefined;
    return {
      key: `question:${question.id}`,
      kind: 'question',
      title: name ? `${name} has a question` : 'Gezel needs your input',
      body: firstLine(question.prompt),
      line: name ? `${name} has a question` : 'A question is waiting',
      view: 'chat',
    };
  }
  if (event.type === 'task_settled') {
    if (event.outcome !== 'complete') return null;
    const name = ctx.social && event.gezelId ? ctx.gezelName(event.gezelId) : undefined;
    const title = firstLine(event.title, 80);
    return {
      key: `ready:${event.taskRef}`,
      kind: 'ready',
      title: name ? `${name} finished “${title}”` : 'Your work is ready',
      body: name ? 'Open it when you have a minute.' : `${title} is finished.`,
      line: `“${title}” is ready`,
      view: envelope.projectId === 'default' ? 'home' : 'projects',
    };
  }
  if (event.type === 'growth_level_up') {
    if (!ctx.social) return null;
    const name = ctx.gezelName(event.gezelId) ?? event.gezelName;
    return {
      key: `level:${event.gezelId}:${event.toLevel}`,
      kind: 'level-up',
      title: `${name} reached level ${event.toLevel}`,
      body: 'Growth choices are waiting — open the Growth tab when you have a minute.',
      line: `${name} reached level ${event.toLevel}`,
      view: 'gezels',
    };
  }
  return null;
}

/** The notification a due reminder becomes. */
export function reminderItem(reminder: ProjectReminder): EarnedItem {
  return {
    key: `reminder:${reminder.projectId}:${reminder.at}`,
    kind: 'reminder',
    title: reminder.title,
    body: reminder.body ?? '',
    line: reminder.title,
    view: 'projects',
  };
}

export interface NotificationLedger {
  /** Local calendar day the count is for (`YYYY-MM-DD`). */
  day: string;
  sent: number;
  /** Keys already notified or already seen on screen, newest last. */
  seen: string[];
}

export function localDay(now: Date): string {
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

export function emptyLedger(now: Date): NotificationLedger {
  return { day: localDay(now), sent: 0, seen: [] };
}

function today(ledger: NotificationLedger | undefined, now: Date): NotificationLedger {
  if (!ledger) return emptyLedger(now);
  const day = localDay(now);
  return ledger.day === day ? ledger : { day, sent: 0, seen: ledger.seen };
}

function remember(seen: readonly string[], keys: readonly string[]): string[] {
  return [...seen.filter((k) => !keys.includes(k)), ...keys].slice(-SEEN_LIMIT);
}

/** Record items the person already saw on screen, so they never notify later. */
export function markNotificationsSeen(
  ledger: NotificationLedger | undefined,
  items: readonly EarnedItem[],
  now: Date,
): NotificationLedger {
  const current = today(ledger, now);
  return {
    ...current,
    seen: remember(
      current.seen,
      items.map((i) => i.key),
    ),
  };
}

/** Several items as one notification. */
export function groupNotification(items: readonly EarnedItem[]): EarnedNotification {
  const kinds = [...new Set(items.map((i) => i.kind))];
  if (items.length === 1) {
    const [item] = items as [EarnedItem];
    return { title: item.title, body: item.body, view: item.view, kinds };
  }
  const shown = items.slice(0, 3).map((i) => i.line);
  const more = items.length - shown.length;
  const views = new Set(items.map((i) => i.view));
  return {
    title: `${items.length} things are waiting`,
    body: `${shown.join(' · ')}${more > 0 ? ` and ${more} more` : ''}`,
    view: views.size === 1 ? [...views][0]! : 'home',
    kinds,
  };
}

/**
 * Decide what reaches the person: drop what was already said or seen, fold
 * the rest into one notification, and hold it once the day's allowance is
 * spent (held items stay where they always are, in Updates and their chats).
 */
export function admitNotifications(
  ledger: NotificationLedger | undefined,
  items: readonly EarnedItem[],
  opts: { cap: number; now: Date },
): { ledger: NotificationLedger; notification: EarnedNotification | null } {
  const current = today(ledger, opts.now);
  const fresh: EarnedItem[] = [];
  for (const item of items)
    if (!current.seen.includes(item.key) && !fresh.some((f) => f.key === item.key))
      fresh.push(item);
  if (fresh.length === 0) return { ledger: current, notification: null };
  const seen = remember(
    current.seen,
    fresh.map((i) => i.key),
  );
  if (opts.cap <= 0 || current.sent >= opts.cap)
    return { ledger: { ...current, seen }, notification: null };
  return {
    ledger: { ...current, seen, sent: current.sent + 1 },
    notification: groupNotification(fresh),
  };
}

export interface NotificationGateDeps {
  deliver(notification: EarnedNotification): void;
  cap(): number;
  /** The person is looking at the app now, so what happens is already on screen. */
  watching(): boolean;
  load(): NotificationLedger | undefined;
  save(ledger: NotificationLedger): void;
  now?(): Date;
  windowMs?: number;
}

/**
 * The live half of the policy: what arrives within a few seconds is offered
 * together, and nothing is said while the person is watching.
 */
export class NotificationGate {
  private pending: EarnedItem[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly deps: NotificationGateDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  offer(item: EarnedItem): void {
    if (this.deps.watching()) {
      this.deps.save(markNotificationsSeen(this.deps.load(), [item], this.now()));
      return;
    }
    this.pending.push(item);
    this.timer ??= setTimeout(
      () => this.flush(),
      this.deps.windowMs ?? NOTIFICATION_GROUP_WINDOW_MS,
    );
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const items = this.pending;
    this.pending = [];
    if (items.length === 0) return;
    if (this.deps.watching()) {
      this.deps.save(markNotificationsSeen(this.deps.load(), items, this.now()));
      return;
    }
    const { ledger, notification } = admitNotifications(this.deps.load(), items, {
      cap: this.deps.cap(),
      now: this.now(),
    });
    this.deps.save(ledger);
    if (notification) this.deps.deliver(notification);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = [];
  }
}

/**
 * Which reminders to hand the OS: future ones inside the horizon, earliest
 * first, no more on one day than the daily allowance. A reminder fires while
 * the app may be closed, so the allowance is enforced here, at planning time.
 */
export function planReminders(
  reminders: readonly ProjectReminder[],
  opts: { cap: number; now: Date },
): ProjectReminder[] {
  if (opts.cap <= 0) return [];
  const nowMs = opts.now.getTime();
  const horizon = nowMs + REMINDER_HORIZON_DAYS * DAY_MS;
  const perDay = new Map<string, number>();
  const planned: ProjectReminder[] = [];
  for (const reminder of [...reminders].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
    const at = Date.parse(reminder.at);
    if (!Number.isFinite(at) || at <= nowMs || at > horizon) continue;
    const day = localDay(new Date(at));
    const count = perDay.get(day) ?? 0;
    if (count >= opts.cap) continue;
    perDay.set(day, count + 1);
    planned.push(reminder);
  }
  return planned;
}

/**
 * Validate a script's `gezel.reminder.set` call into the stored reminder.
 * The time must be in the future and within `REMINDER_MAX_AHEAD_DAYS`.
 */
export function parseReminderRequest(
  input: unknown,
  opts: { projectId: string; source?: string; now: Date },
): ProjectReminder {
  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const at = typeof raw.at === 'string' ? Date.parse(raw.at) : Number.NaN;
  if (!Number.isFinite(at)) throw new Error("reminder.set needs 'at', an ISO date-time.");
  const nowMs = opts.now.getTime();
  if (at <= nowMs) throw new Error("reminder.set needs a future 'at'.");
  if (at > nowMs + REMINDER_MAX_AHEAD_DAYS * DAY_MS)
    throw new Error(`reminder.set can look ahead at most ${REMINDER_MAX_AHEAD_DAYS} days.`);
  const title = typeof raw.title === 'string' ? firstLine(raw.title, REMINDER_TITLE_MAX) : '';
  if (!title) throw new Error("reminder.set needs a 'title'.");
  const body = typeof raw.body === 'string' ? firstLine(raw.body, REMINDER_BODY_MAX) : '';
  return {
    projectId: opts.projectId,
    at: new Date(at).toISOString(),
    title,
    ...(body ? { body } : {}),
    ...(opts.source ? { source: opts.source } : {}),
    setAt: opts.now.toISOString(),
  };
}
