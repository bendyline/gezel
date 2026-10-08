import {
  type ChatEventEnvelope,
  EarnedNotifier,
  type NotificationLedger,
  type ProjectReminder,
} from '@bendyline/gezel';
import { useEffect } from 'react';
import { api } from '../api.js';
import { streamSharedAllChatEvents } from '../shared-chat-events.js';
import { socialHost } from './useSocialMode.js';

const LEDGER_KEY = 'gezel:notification-ledger';

function readLedger(): NotificationLedger | undefined {
  try {
    const raw = localStorage.getItem(LEDGER_KEY);
    return raw ? (JSON.parse(raw) as NotificationLedger) : undefined;
  } catch {
    return undefined;
  }
}

function writeLedger(ledger: NotificationLedger): void {
  try {
    localStorage.setItem(LEDGER_KEY, JSON.stringify(ledger));
  } catch {
    // Without storage the day's count is forgotten on reload; the OS still shows what fired.
  }
}

/** A stable 31-bit id per reminder, since the OS identifies notifications by number. */
export function reminderNotificationId(reminder: ProjectReminder): number {
  let hash = 5381;
  const key = `${reminder.projectId}:${reminder.at}`;
  for (let i = 0; i < key.length; i++) hash = ((hash << 5) + hash + key.charCodeAt(i)) | 0;
  return hash >>> 1 || 1;
}

/**
 * Earned notifications for a host whose UI drives them — the phone, where
 * the runtime lives in this page. Runs the shared policy (core
 * `notifications`) over the event stream, hands project reminders to the
 * OS so they fire with the app closed, and clears the tray when the person
 * comes back. Does nothing on the desktop, where Electron's main process
 * owns notifications.
 */
export function useHostNotifications(): void {
  useEffect(() => {
    const bridge = window.__GEZEL__?.earnedNotifications;
    if (!bridge) return;
    const notifier = new EarnedNotifier({
      client: api,
      host: socialHost(),
      deliver: (n) =>
        void bridge.notify({ title: n.title, body: n.body, view: n.view }).catch(() => {}),
      watching: () => document.visibilityState === 'visible',
      // The OS asks only once, and only in the app: the first time something
      // worth a notification happens while the person is here.
      earned: () => {
        if (document.visibilityState === 'visible') void bridge.requestPermission().catch(() => {});
      },
      readLedger,
      writeLedger,
      scheduleReminders: (planned) =>
        void bridge
          .scheduleReminders(
            planned.map((r) => ({
              id: reminderNotificationId(r),
              at: r.at,
              title: r.title,
              body: r.body ?? '',
            })),
          )
          .catch(() => {}),
    });
    const ctrl = new AbortController();
    void notifier.replanReminders().catch(() => {});
    void (async () => {
      try {
        for await (const env of streamSharedAllChatEvents({
          url: api.allEventsUrl(),
          headers: api.authHeader(),
          signal: ctrl.signal,
          fetch: api.getFetch(),
        })) {
          await notifier.handle(env as ChatEventEnvelope).catch(() => {});
        }
      } catch {
        /* aborted */
      }
    })();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void bridge.clearDelivered().catch(() => {});
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      ctrl.abort();
      notifier.dispose();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);
}
