import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { authorizeLocalMock, hostInProcessMock } = vi.hoisted(() => ({
  authorizeLocalMock: vi.fn(),
  hostInProcessMock: vi.fn(),
}));

vi.mock('./local.js', () => ({ authorizeLocal: authorizeLocalMock }));
vi.mock('./host-service.js', () => ({ hostInProcess: hostInProcessMock }));
vi.mock('@bendyline/gezel-client/node', () => ({
  GezelClient: class {
    constructor(readonly opts: unknown) {}
  },
  createTrustingFetch: () => globalThis.fetch,
}));

const { resolveDaemon } = await import('./connect-or-host.js');
const { GezelSdkError } = await import('./errors.js');

const APP = { appId: 'qualla', appName: 'Qualla' };

function authorized(mode: string) {
  return {
    baseUrl: 'https://127.0.0.1:1234',
    token: 'app-token',
    fetch: globalThis.fetch,
    daemon: { mode, cert: null },
  };
}

beforeEach(() => {
  authorizeLocalMock.mockReset();
  hostInProcessMock.mockReset();
  hostInProcessMock.mockResolvedValue({ mode: 'hosted', baseUrl: 'https://127.0.0.1:5555' });
});

afterEach(() => vi.clearAllMocks());

describe('resolveDaemon', () => {
  it('asks for projects and inference by default', async () => {
    authorizeLocalMock.mockResolvedValue(authorized('adopted'));
    const connection = await resolveDaemon({ ...APP, onVerificationCode: () => {} });

    expect(authorizeLocalMock).toHaveBeenCalledWith(
      expect.objectContaining({ scopes: ['product', 'openai'] }),
    );
    expect(connection.mode).toBe('adopted');
    expect(hostInProcessMock).not.toHaveBeenCalled();
  });

  it('hosts a daemon when nothing is running and the app opted in', async () => {
    authorizeLocalMock.mockRejectedValue(
      new GezelSdkError('nothing running', { code: 'daemon_not_running' }),
    );
    const connection = await resolveDaemon({
      ...APP,
      onVerificationCode: () => {},
      host: { nodePath: '/usr/bin/node' },
    });

    expect(connection.mode).toBe('hosted');
    expect(hostInProcessMock).toHaveBeenCalledWith(
      'qualla',
      expect.objectContaining({ nodePath: '/usr/bin/node' }),
      undefined,
    );
  });

  it('refuses to host after the user declined the connection', async () => {
    // Starting a private daemon here would do the thing the user just said no
    // to, in a place they cannot see.
    authorizeLocalMock.mockRejectedValue(
      new GezelSdkError('declined', { code: 'user_denied', status: 403 }),
    );
    await expect(
      resolveDaemon({ ...APP, onVerificationCode: () => {}, host: {} }),
    ).rejects.toMatchObject({ code: 'user_denied' });
    expect(hostInProcessMock).not.toHaveBeenCalled();
  });

  it('explains how to host when nothing is running and the app did not opt in', async () => {
    authorizeLocalMock.mockRejectedValue(
      new GezelSdkError('nothing running', { code: 'daemon_not_running' }),
    );
    await expect(resolveDaemon({ ...APP, onVerificationCode: () => {} })).rejects.toThrow(
      /pass `host`/,
    );
  });

  it('never falls through from a configured address', async () => {
    authorizeLocalMock.mockRejectedValue(
      new GezelSdkError('nothing running', { code: 'daemon_not_running' }),
    );
    await expect(
      resolveDaemon({ ...APP, baseUrl: 'https://gezel.example', host: {} }),
    ).rejects.toMatchObject({ code: 'daemon_not_running' });
    expect(hostInProcessMock).not.toHaveBeenCalled();
  });

  it('goes straight to hosting when the app cannot show a connection code', async () => {
    const info = vi.fn();
    const connection = await resolveDaemon({ ...APP, host: { logger: { info } } });

    expect(authorizeLocalMock).not.toHaveBeenCalled();
    expect(connection.mode).toBe('hosted');
    expect(info).toHaveBeenCalledWith(expect.stringContaining('hosting a private daemon'));
  });

  it("reuses a stored grant with the user's running Gezel before hosting", async () => {
    // No code handler, but an earlier session's grant: joining the Gezel the
    // person runs beats loading every model a second time in a private one.
    authorizeLocalMock.mockResolvedValue(authorized('adopted'));
    const tokenStorage = { save: vi.fn(), load: vi.fn(() => 'stored-token') };
    const connection = await resolveDaemon({ ...APP, tokenStorage, host: {} });

    expect(connection.mode).toBe('adopted');
    expect(authorizeLocalMock.mock.calls[0]?.[0]).not.toHaveProperty('onVerificationCode');
    expect(hostInProcessMock).not.toHaveBeenCalled();
  });

  it('hosts when a stored grant can no longer be reused', async () => {
    // authorize refuses to register without a code handler; that refusal is
    // the reuse-only attempt running out, not the user declining.
    authorizeLocalMock.mockRejectedValue(
      new GezelSdkError('needs a code', { code: 'verification_code_handler_required' }),
    );
    const tokenStorage = { save: vi.fn(), load: vi.fn(() => 'stale-token') };
    const connection = await resolveDaemon({ ...APP, tokenStorage, host: {} });
    expect(connection.mode).toBe('hosted');
  });

  it('hosts after a refusal only when the app opted in', async () => {
    for (const code of ['user_denied', 'approval_timeout', 'grant_expired']) {
      authorizeLocalMock.mockRejectedValueOnce(new GezelSdkError('refused', { code }));
      hostInProcessMock.mockClear();
      const connection = await resolveDaemon({
        ...APP,
        onVerificationCode: () => {},
        host: {},
        hostWhenRefused: true,
      });
      expect(connection.mode, code).toBe('hosted');
      expect(hostInProcessMock, code).toHaveBeenCalledOnce();
    }
  });

  it('keeps an alive-but-unwell daemon loud even for an app that hosts on refusal', async () => {
    authorizeLocalMock.mockRejectedValue(
      new GezelSdkError('server exploded', { code: 'server_error', status: 500 }),
    );
    await expect(
      resolveDaemon({ ...APP, onVerificationCode: () => {}, host: {}, hostWhenRefused: true }),
    ).rejects.toMatchObject({ code: 'server_error' });
    expect(hostInProcessMock).not.toHaveBeenCalled();
  });

  it('stays in its own home when adoption is turned off', async () => {
    const connection = await resolveDaemon({ ...APP, adoptUserDaemon: false, host: {} });
    expect(authorizeLocalMock).not.toHaveBeenCalled();
    expect(connection.mode).toBe('hosted');
  });
});
