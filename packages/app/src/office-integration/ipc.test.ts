import type { IpcMain } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import type { OfficeIntegrationClient } from './controller.js';
import { parseOfficeApps, registerOfficeIntegrationIpc } from './ipc.js';

function fakeIpc() {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const ipcMain = {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    },
  } as unknown as IpcMain;
  return { ipcMain, handlers };
}

describe('parseOfficeApps', () => {
  it('accepts known apps and removes duplicates', () => {
    expect(parseOfficeApps(['word', 'excel', 'word'])).toEqual(['word', 'excel']);
    expect(parseOfficeApps(['word', 'excel'])).toEqual(['word', 'excel']);
  });

  it('refuses anything the renderer could smuggle in', () => {
    expect(parseOfficeApps([])).toBeNull();
    expect(parseOfficeApps('word')).toBeNull();
    expect(parseOfficeApps(['word', 'outlook'])).toBeNull();
    expect(parseOfficeApps(['word', 'excel', 'powerpoint', 'word'])).toBeNull();
    expect(parseOfficeApps([{ app: 'word' }])).toBeNull();
  });
});

describe('registerOfficeIntegrationIpc', () => {
  it('registers every channel the preload bridge calls', () => {
    const { ipcMain, handlers } = fakeIpc();
    registerOfficeIntegrationIpc(ipcMain, () => null);
    expect([...handlers.keys()].sort()).toEqual([
      'gezel:libreoffice:disable',
      'gezel:libreoffice:enable',
      'gezel:libreoffice:verify',
      'gezel:office-host:clear-cache',
      'gezel:office-host:disable',
      'gezel:office-host:enable',
      'gezel:office-host:repair',
      'gezel:office-host:verify',
    ]);
  });

  it('answers without a connection instead of throwing', async () => {
    const { ipcMain, handlers } = fakeIpc();
    registerOfficeIntegrationIpc(ipcMain, () => null);
    await expect(handlers.get('gezel:office-host:verify')?.({})).resolves.toEqual({
      ok: false,
      error: 'service is unavailable',
    });
  });

  it('rejects an invalid app list before touching the daemon', async () => {
    const { ipcMain, handlers } = fakeIpc();
    const configureOffice = vi.fn();
    const client = { configureOffice } as unknown as OfficeIntegrationClient;
    registerOfficeIntegrationIpc(ipcMain, () => client);
    await expect(
      Promise.resolve(handlers.get('gezel:office-host:enable')?.({}, ['outlook'])),
    ).resolves.toEqual({
      ok: false,
      error: 'Choose Word, Excel, or PowerPoint.',
    });
    expect(configureOffice).not.toHaveBeenCalled();
  });

  it('turns a daemon failure into an error result', async () => {
    const { ipcMain, handlers } = fakeIpc();
    const client = {
      getLibreOfficeSetupStatus: vi.fn(async () => {
        throw new Error('daemon said no');
      }),
    } as unknown as OfficeIntegrationClient;
    registerOfficeIntegrationIpc(ipcMain, () => client);
    await expect(handlers.get('gezel:libreoffice:verify')?.({})).resolves.toEqual({
      ok: false,
      error: 'daemon said no',
    });
  });
});
