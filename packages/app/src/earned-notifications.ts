// Electron's `electron` module is injected by its patched CJS loader, so —
// as in main.ts — we pull the API through `createRequire` rather than an
// ESM `import`, which would see an empty wrapper on Node 22+.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { EarnedNotifier, type NotificationLedger } from '@bendyline/gezel';
import { type GezelClient, streamAllChatEvents } from '@bendyline/gezel-client/node';
import { waitForTrayActivityRetry } from './tray-activity.js';

const require = createRequire(import.meta.url);
// biome-ignore format: `typeof import(...)` cannot be broken across lines
const { app, BrowserWindow } = require('electron') as typeof import('electron');

let earnedAbort: AbortController | null = null;
let earnedNotifier: EarnedNotifier | null = null;

function notificationLedgerPath(): string {
  return join(app.getPath('userData'), 'notification-ledger.json');
}

/**
 * Earned notifications — questions, finished work, level-ups, the night's
 * review, project reminders — raised from here whether or not a window is
 * open (the app runs hidden after a login launch). The shared policy in
 * `@bendyline/gezel` decides what is said; nothing is said while a window
 * is focused, and at most `notifications.dailyCap` a day.
 */
export function startEarnedNotifications(
  apiClient: GezelClient | null,
  notify: (opts: { title: string; body?: string; view?: string }) => boolean,
): void {
  earnedAbort?.abort();
  earnedNotifier?.dispose();
  earnedNotifier = null;
  const client = apiClient;
  if (!client || process.env.GEZEL_E2E === '1') return;
  const controller = new AbortController();
  earnedAbort = controller;
  const notifier = new EarnedNotifier({
    client,
    deliver: (n) => notify({ title: n.title, body: n.body, view: n.view }),
    watching: () => BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.isFocused()),
    readLedger: () => {
      try {
        return JSON.parse(readFileSync(notificationLedgerPath(), 'utf8')) as NotificationLedger;
      } catch {
        return undefined;
      }
    },
    writeLedger: (ledger) => {
      try {
        writeFileSync(notificationLedgerPath(), `${JSON.stringify(ledger)}\n`);
      } catch {
        // A ledger that cannot be written only forgets today's count.
      }
    },
  });
  earnedNotifier = notifier;
  void notifier.replanReminders().catch(() => {});
  void (async () => {
    while (!controller.signal.aborted) {
      try {
        for await (const envelope of streamAllChatEvents({
          url: client.allEventsUrl(),
          headers: client.authHeader(),
          fetch: client.getFetch(),
          signal: controller.signal,
        })) {
          await notifier.handle(envelope).catch(() => {});
        }
      } catch {
        // Daemon or socket loss; retry against this connection until it rotates.
      }
      if (controller.signal.aborted) return;
      await waitForTrayActivityRetry(controller.signal);
    }
  })();
}

/** After a host sleep: fire the reminders that came due meanwhile, then re-arm. */
export function resumeEarnedNotifications(): void {
  earnedNotifier?.resume();
}
