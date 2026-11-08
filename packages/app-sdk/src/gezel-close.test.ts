import { describe, expect, it, vi } from 'vitest';
import type { DaemonConnection } from './host-types.js';
import type { AppToolsRegistration } from './types.js';

const registrations: Array<AppToolsRegistration & { close: ReturnType<typeof vi.fn> }> = [];

vi.mock('./app-tools.js', () => ({
  registerAppTools: vi.fn(async () => {
    const registration = {
      relayId: `relay-${registrations.length + 1}`,
      ready: Promise.resolve(),
      update: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    registrations.push(registration);
    return registration;
  }),
}));

const { Gezel } = await import('./gezel.js');

function fakeDaemon(): DaemonConnection & { close: ReturnType<typeof vi.fn> } {
  return {
    mode: 'adopted',
    baseUrl: 'https://127.0.0.1:1',
    token: 'token',
    fetch: vi.fn() as unknown as typeof fetch,
    cert: null,
    client: {
      getProject: async (id: string) => ({ id, gezelIds: [] }),
      listGezels: async () => ({ gezels: [] }),
    } as never,
    close: vi.fn(async () => undefined),
  };
}

describe('Gezel.close', () => {
  it('withdraws the tools its projects registered, so the app can exit', async () => {
    registrations.length = 0;
    const daemon = fakeDaemon();
    const gezel = Gezel.fromDaemon(daemon);
    const project = await gezel.openProject('journal');
    await project.registerTools({ tools: [] });
    await project.registerTools({ tools: [] });

    await gezel.close();

    expect(registrations.map((r) => r.close.mock.calls.length)).toEqual([1, 1]);
    expect(daemon.close).toHaveBeenCalledTimes(1);
  });

  it('does not close a registration the app already closed itself', async () => {
    registrations.length = 0;
    const gezel = Gezel.fromDaemon(fakeDaemon());
    const project = await gezel.openProject('journal');
    const registration = await project.registerTools({ tools: [] });

    await registration.close();
    await gezel.close();

    expect(registrations[0]?.close).toHaveBeenCalledTimes(1);
  });
});
