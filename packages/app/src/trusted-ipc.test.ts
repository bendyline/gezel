import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import { describe, expect, it } from 'vitest';
import { createTrustedIpc } from './trusted-ipc.js';

type Listener = (event: { returnValue?: unknown; trusted: boolean }, ...args: unknown[]) => unknown;

function fakeIpcMain() {
  const handlers = new Map<string, Listener>();
  const listeners = new Map<string, Listener>();
  const ipc = {
    handle: (channel: string, fn: Listener) => handlers.set(channel, fn),
    on: (channel: string, fn: Listener) => listeners.set(channel, fn),
  } as unknown as Pick<IpcMain, 'handle' | 'on'>;
  return { ipc, handlers, listeners };
}

const isTrusted = (event: IpcMainEvent | IpcMainInvokeEvent) =>
  (event as unknown as { trusted: boolean }).trusted;

describe('createTrustedIpc', () => {
  // The preload runs in whatever document fills the main frame; a page that
  // is not the app must get neither the token nor the bridge.
  it('answers an invoke only for the trusted page', async () => {
    const { ipc, handlers } = fakeIpcMain();
    createTrustedIpc(ipc, isTrusted).handle('gezel:restart-service', (_event, reason) => ({
      restarted: reason,
    }));
    const handler = handlers.get('gezel:restart-service')!;
    expect(await handler({ trusted: true }, 'folders')).toEqual({ restarted: 'folders' });
    expect(() => handler({ trusted: false }, 'folders')).toThrow(
      /only answered for Gezel's own page/,
    );
  });

  it('answers a synchronous message with null for anything else, so it never hangs', () => {
    const { ipc, listeners } = fakeIpcMain();
    createTrustedIpc(ipc, isTrusted).on('gezel:current-connection', (event) => {
      event.returnValue = { token: 'secret' };
    });
    const listener = listeners.get('gezel:current-connection')!;
    const trusted: { returnValue?: unknown; trusted: boolean } = { trusted: true };
    const untrusted: { returnValue?: unknown; trusted: boolean } = { trusted: false };
    listener(trusted);
    listener(untrusted);
    expect(trusted.returnValue).toEqual({ token: 'secret' });
    expect(untrusted.returnValue).toBeNull();
  });

  it('tells the check which channel was asked, so a page can be trusted for one channel', async () => {
    const { ipc, handlers, listeners } = fakeIpcMain();
    const onlyRestart = (_event: IpcMainEvent | IpcMainInvokeEvent, channel: string) =>
      channel === 'gezel:restart-service';
    const trustedIpc = createTrustedIpc(ipc, onlyRestart);
    trustedIpc.handle('gezel:restart-service', () => 'restarted');
    trustedIpc.on('gezel:current-connection', (event) => {
      event.returnValue = { token: 'secret' };
    });
    expect(await handlers.get('gezel:restart-service')!({ trusted: false })).toBe('restarted');
    const event: { returnValue?: unknown; trusted: boolean } = { trusted: false };
    listeners.get('gezel:current-connection')!(event);
    expect(event.returnValue).toBeNull();
  });
});
