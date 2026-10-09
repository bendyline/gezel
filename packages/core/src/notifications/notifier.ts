import { type SocialHost, resolveSocialMode } from '../character/index.js';
import { displayName } from '../gezel-display.js';
import type { ChatEventEnvelope } from '../schemas/gezel.js';
import type { NotificationsConfig, ProjectReminder } from '../schemas/notifications.js';
import {
  type EarnedContext,
  type EarnedItem,
  type EarnedNotification,
  NotificationGate,
  type NotificationLedger,
  earnedItemFor,
  markNotificationsSeen,
  notificationDailyCap,
  planReminders,
  reminderItem,
} from './policy.js';

/** A reminder missed while the machine slept still fires on wake, if this recent. */
const REMINDER_GRACE_MS = 12 * 60 * 60 * 1000;
const NAMES_TTL_MS = 10 * 60 * 1000;

/** The three reads a notifier needs; `GezelClient` and the UI's `api` both fit. */
export interface EarnedNotifierClient {
  getConfig(): Promise<{
    social?: boolean;
    roleBasedNameOnlyMode?: boolean;
    nightShift?: { morningNotification?: boolean };
    notifications?: NotificationsConfig;
  }>;
  listGezels(): Promise<{
    gezels: ReadonlyArray<{ id: string; name: string; roleBasedName?: string }>;
  }>;
  listReminders(): Promise<{ reminders: ProjectReminder[] }>;
}

export interface EarnedNotifierDeps {
  client: EarnedNotifierClient;
  /** How an absent `config.social` reads here (the desktop answers it resolved). */
  host?: SocialHost;
  /**
   * The OS schedules reminders itself — a phone, where the app may be closed
   * when one comes due. Without it, this notifier arms them in-process.
   */
  scheduleReminders?(planned: ProjectReminder[]): void;
  /** Every earned item, delivered or not — a phone asks for permission on the first one. */
  earned?(item: EarnedItem): void;
  deliver(notification: EarnedNotification): void;
  /** A window is focused, so what happens is already on screen. */
  watching(): boolean;
  readLedger(): NotificationLedger | undefined;
  writeLedger(ledger: NotificationLedger): void;
  now?(): Date;
}

/**
 * A host's earned notifications: feeds the event stream through the shared
 * policy and keeps the project reminders scheduled. Electron's main process
 * runs one (so notifications reach the person whether or not a window is
 * open); the phone's UI runs one against the in-app runtime.
 */
export class EarnedNotifier {
  private readonly gate: NotificationGate;
  private names: { at: number; byId: Map<string, string> } | undefined;
  private armed: ProjectReminder[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private cap = notificationDailyCap({});

  constructor(private readonly deps: EarnedNotifierDeps) {
    this.gate = new NotificationGate({
      deliver: (n) => deps.deliver(n),
      cap: () => this.cap,
      watching: () => deps.watching(),
      load: () => deps.readLedger(),
      save: (ledger) => deps.writeLedger(ledger),
      now: () => this.now(),
    });
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private async context(): Promise<EarnedContext> {
    const config = await this.deps.client.getConfig();
    this.cap = notificationDailyCap(config);
    const namesOnly = config.roleBasedNameOnlyMode === true;
    if (!this.names || this.now().getTime() - this.names.at > NAMES_TTL_MS) {
      const { gezels } = await this.deps.client.listGezels().catch(() => ({ gezels: [] }));
      this.names = {
        at: this.now().getTime(),
        byId: new Map(gezels.map((g) => [g.id, displayName(g, namesOnly)])),
      };
    }
    const byId = this.names.byId;
    return {
      social: resolveSocialMode(config, this.deps.host ?? 'desktop'),
      gezelName: (id) => byId.get(id),
      morningNotification: config.nightShift?.morningNotification !== false,
    };
  }

  async handle(envelope: ChatEventEnvelope): Promise<void> {
    const event = envelope.event;
    if (event.type === 'reminders_updated') return this.replanReminders();
    if (event.type === 'gezel_created') this.names = undefined;
    if (
      event.type !== 'question_asked' &&
      event.type !== 'task_settled' &&
      event.type !== 'growth_level_up'
    )
      return;
    const item = earnedItemFor(envelope, await this.context());
    if (!item) return;
    this.deps.earned?.(item);
    this.gate.offer(item);
  }

  /** Re-read every project's reminder and arm the next one. */
  async replanReminders(): Promise<void> {
    const [{ reminders }] = await Promise.all([
      this.deps.client.listReminders(),
      this.context().catch(() => undefined),
    ]);
    const planned = planReminders(reminders, { cap: this.cap, now: this.now() });
    if (this.deps.scheduleReminders) {
      this.deps.scheduleReminders(planned);
      return;
    }
    this.armed = planned;
    this.arm();
  }

  /** After a sleep: fire what came due meanwhile, then re-arm from the wall clock. */
  resume(): void {
    this.tick();
  }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const next = this.armed[0];
    if (!next) return;
    const delay = Math.max(0, Date.parse(next.at) - this.now().getTime());
    this.timer = setTimeout(() => this.tick(), delay);
  }

  private tick(): void {
    const nowMs = this.now().getTime();
    const due = this.armed.filter((r) => Date.parse(r.at) <= nowMs);
    this.armed = this.armed.filter((r) => Date.parse(r.at) > nowMs);
    const fresh = due.filter((r) => nowMs - Date.parse(r.at) <= REMINDER_GRACE_MS);
    const stale = due.filter((r) => nowMs - Date.parse(r.at) > REMINDER_GRACE_MS);
    if (stale.length > 0)
      this.deps.writeLedger(
        markNotificationsSeen(this.deps.readLedger(), stale.map(reminderItem), this.now()),
      );
    for (const reminder of fresh) this.gate.offer(reminderItem(reminder));
    this.arm();
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.armed = [];
    this.gate.dispose();
  }
}
