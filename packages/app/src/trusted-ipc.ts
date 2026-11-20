import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent } from 'electron';

/** Decides whether a message came from the app's own page. */
export type IpcSenderCheck = (event: IpcMainEvent | IpcMainInvokeEvent) => boolean;

export interface TrustedIpc {
  handle(channel: string, listener: Parameters<IpcMain['handle']>[1]): void;
  on(channel: string, listener: Parameters<IpcMain['on']>[1]): void;
}

/**
 * `ipcMain`, answering only senders `isTrusted` accepts.
 *
 * Every channel the preload exposes goes through this, because the preload
 * runs in whatever document fills the main frame. A channel that answered any
 * sender handed that document the bearer token (`gezel:current-connection`)
 * and the bridge behind it: restarting the service, installing updates,
 * autostart, the Office add-ins. A refused `handle` rejects; a refused `on`
 * answers a synchronous caller with `null`, so it never hangs.
 */
export function createTrustedIpc(
  ipc: Pick<IpcMain, 'handle' | 'on'>,
  isTrusted: IpcSenderCheck,
): TrustedIpc {
  return {
    handle(channel, listener) {
      ipc.handle(channel, (event, ...args) => {
        if (!isTrusted(event)) {
          throw new Error(`${channel} is only answered for Gezel's own page`);
        }
        return listener(event, ...args);
      });
    },
    on(channel, listener) {
      ipc.on(channel, (event, ...args) => {
        if (!isTrusted(event)) {
          event.returnValue = null;
          return;
        }
        listener(event, ...args);
      });
    },
  };
}
