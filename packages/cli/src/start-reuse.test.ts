import { describe, expect, it, vi } from 'vitest';
import { startShortfall, startShortfallMessage } from './start-reuse.js';

const WEB = { port: 52000, baseUrl: 'http://127.0.0.1:52000' };
const accountsWanted = { port: undefined, web: true, accounts: true };

function signInState(accountsRequired: boolean | undefined, status = 200) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    Response.json(accountsRequired === undefined ? {} : { accountsRequired }, { status }),
  );
}

describe('startShortfall', () => {
  it('will not adopt a web daemon without accounts for --accounts', async () => {
    const fetch = signInState(false);
    expect(
      await startShortfall(WEB, accountsWanted, {
        readWebUiToken: async () => 'tok',
        fetch: fetch as unknown as typeof globalThis.fetch,
      }),
    ).toBe('accounts');
    expect(String(fetch.mock.calls[0]?.[0])).toBe('http://127.0.0.1:52000/v1/apps/signin/state');
  });

  it('adopts a web daemon that requires accounts', async () => {
    const fetch = signInState(true);
    expect(
      await startShortfall(WEB, accountsWanted, {
        readWebUiToken: async () => 'tok',
        fetch: fetch as unknown as typeof globalThis.fetch,
      }),
    ).toBeNull();
  });

  it('counts a daemon that cannot say as one without accounts', async () => {
    for (const fetch of [
      signInState(undefined, 404),
      signInState(undefined),
      vi.fn(async () => {
        throw new Error('connection refused');
      }),
    ]) {
      expect(
        await startShortfall(WEB, accountsWanted, {
          readWebUiToken: async () => 'tok',
          fetch: fetch as unknown as typeof globalThis.fetch,
        }),
      ).toBe('accounts');
    }
  });

  it('does not ask about accounts when they were not requested', async () => {
    const fetch = signInState(false);
    expect(
      await startShortfall(
        WEB,
        { port: undefined, web: true, accounts: false },
        { readWebUiToken: async () => 'tok', fetch: fetch as unknown as typeof globalThis.fetch },
      ),
    ).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('checks the port and the web UI before accounts', async () => {
    const fetch = signInState(true);
    const deps = {
      readWebUiToken: async () => 'tok',
      fetch: fetch as unknown as typeof globalThis.fetch,
    };
    expect(await startShortfall(WEB, { ...accountsWanted, port: 7000 }, deps)).toBe('port');
    expect(
      await startShortfall(
        { port: 52000, baseUrl: 'https://127.0.0.1:52000' },
        accountsWanted,
        deps,
      ),
    ).toBe('web');
    expect(
      await startShortfall(WEB, accountsWanted, { ...deps, readWebUiToken: async () => ' \n' }),
    ).toBe('web');
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('startShortfallMessage', () => {
  it('says how to restart with accounts, keeping every flag', () => {
    expect(startShortfallMessage('accounts', { pid: 4242, port: 52000 }, accountsWanted)).toBe(
      'gezeld is already running for this home with the web UI but without accounts (pid 4242).\n' +
        'Restart it with the web UI and accounts with `gezel start --web --accounts --restart`, or stop it first with `gezel stop`.',
    );
    expect(
      startShortfallMessage(
        'web',
        { pid: 4242, port: 52000 },
        { port: 7000, web: true, accounts: false },
      ),
    ).toBe(
      'gezeld is already running for this home without the web UI (pid 4242).\n' +
        'Restart it with the web UI with `gezel start --port 7000 --web --restart`, or stop it first with `gezel stop`.',
    );
  });
});
