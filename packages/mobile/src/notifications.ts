import { LocalNotifications } from '@capacitor/local-notifications';

type Bridge = NonNullable<NonNullable<Window['__GEZEL__']>['earnedNotifications']>;

/** Ask once, while the person is in the app; never from the background. */
async function allowed(ask: boolean): Promise<boolean> {
  let permission = await LocalNotifications.checkPermissions();
  if (ask && (permission.display === 'prompt' || permission.display === 'prompt-with-rationale'))
    permission = await LocalNotifications.requestPermissions();
  return permission.display === 'granted';
}

/**
 * The phone's notification bridge, over Capacitor's local notifications.
 * The earned-notification policy runs in the UI (core `notifications`);
 * this only shows what it decided, schedules project reminders with the OS
 * so they fire while the app is closed, and routes a tap to its view.
 */
export function createNativeNotifications(): Bridge {
  void LocalNotifications.addListener('localNotificationActionPerformed', (action) => {
    const view = (action.notification.extra as { view?: unknown } | undefined)?.view;
    if (typeof view === 'string')
      window.dispatchEvent(new CustomEvent('gezel:navigate', { detail: { view } }));
  }).catch(() => {});
  return {
    async notify({ title, body, view }) {
      if (!(await allowed(false))) return;
      await LocalNotifications.schedule({
        notifications: [
          {
            id: Math.floor(Date.now() / 1000) % 2_000_000_000,
            title,
            body,
            extra: { kind: 'earned', view },
          },
        ],
      });
    },
    async scheduleReminders(reminders) {
      const { notifications } = await LocalNotifications.getPending();
      const ours = notifications.filter(
        (n) => (n.extra as { kind?: unknown } | undefined)?.kind === 'reminder',
      );
      if (ours.length > 0)
        await LocalNotifications.cancel({ notifications: ours.map((n) => ({ id: n.id })) });
      if (reminders.length === 0 || !(await allowed(document.visibilityState === 'visible')))
        return;
      await LocalNotifications.schedule({
        notifications: reminders.map((r) => ({
          id: r.id,
          title: r.title,
          body: r.body,
          schedule: { at: new Date(r.at), allowWhileIdle: true },
          extra: { kind: 'reminder', view: 'projects' },
        })),
      });
    },
    async clearDelivered() {
      await LocalNotifications.removeAllDeliveredNotifications();
    },
    async requestPermission() {
      if (document.visibilityState === 'visible') await allowed(true);
    },
  };
}
