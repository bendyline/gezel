import { afterEach, describe, expect, it, vi } from 'vitest';

const discoverOrSpawn = vi.hoisted(() => vi.fn());
const createTrustingFetch = vi.hoisted(() => vi.fn());

vi.mock('@bendyline/gezel-client/node', () => ({
  discoverOrSpawn,
  createTrustingFetch,
  DaemonNotRunningError: class DaemonNotRunningError extends Error {},
}));

const { authorizeLocal } = await import('./local.js');

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('local native app connection', () => {
  const originalSystemScope = process.env.GEZEL_SYSTEM_SCOPE;
  const originalRole = process.env.GEZEL_SERVICE_ROLE;
  const originalPort = process.env.GEZEL_PORT;

  afterEach(() => {
    vi.clearAllMocks();
    restoreEnv('GEZEL_SYSTEM_SCOPE', originalSystemScope);
    restoreEnv('GEZEL_SERVICE_ROLE', originalRole);
    restoreEnv('GEZEL_PORT', originalPort);
  });

  it('starts only an ephemeral user daemon and returns a scoped authorization', async () => {
    process.env.GEZEL_SYSTEM_SCOPE = '1';
    process.env.GEZEL_SERVICE_ROLE = 'machine-engine';
    process.env.GEZEL_PORT = '6228';
    discoverOrSpawn.mockResolvedValueOnce({
      outcome: 'spawned',
      baseUrl: 'https://127.0.0.1:54321',
      token: 'root-token-must-not-escape',
      cert: null,
      pid: 4242,
      client: {},
    });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ grantRequestId: 'grant-1', status: 'approved', token: 'app-token' }, 201),
      ) as unknown as typeof fetch;

    const authorized = await authorizeLocal({
      appId: 'vscode',
      appName: 'Visual Studio Code',
      scopes: ['product', 'openai'],
      baseUrl: undefined,
      fetch: fetchImpl,
      onVerificationCode: () => {},
      daemon: {
        daemonEntry: '/bundled/gezeld.js',
        spawnIfMissing: true,
      },
    });

    expect(discoverOrSpawn).toHaveBeenCalledWith(
      expect.objectContaining({
        daemonEntry: '/bundled/gezeld.js',
        spawnIfMissing: true,
        env: expect.objectContaining({
          GEZEL_PORT: '0',
          GEZEL_SERVICE_ROLE: 'user',
        }),
      }),
    );
    const spawnEnv = discoverOrSpawn.mock.calls[0]?.[0]?.env as NodeJS.ProcessEnv;
    expect(spawnEnv.GEZEL_SYSTEM_SCOPE).toBeUndefined();
    expect(authorized).toMatchObject({
      baseUrl: 'https://127.0.0.1:54321',
      token: 'app-token',
      daemon: { mode: 'spawned', pid: 4242, cert: null },
    });
    expect(authorized).not.toHaveProperty('firstPartyToken');
    expect(authorized).not.toHaveProperty('rootToken');
  });

  it('preserves an operator-selected user home while overriding system role and port', async () => {
    const originalHome = process.env.GEZEL_HOME;
    process.env.GEZEL_HOME = '/custom/user/gezel';
    discoverOrSpawn.mockResolvedValueOnce({
      outcome: 'adopted',
      baseUrl: 'http://127.0.0.1:54321',
      token: 'root-token',
      cert: null,
      pid: 4242,
      client: {},
    });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ grantRequestId: 'grant-1', status: 'approved', token: 'app-token' }, 201),
      ) as unknown as typeof fetch;

    try {
      await authorizeLocal({
        appId: 'native-app',
        appName: 'Native App',
        scopes: ['openai'],
        fetch: fetchImpl,
        daemon: { daemonEntry: '/bundled/gezeld.js' },
      });
      const spawnEnv = discoverOrSpawn.mock.calls[0]?.[0]?.env as NodeJS.ProcessEnv;
      expect(spawnEnv.GEZEL_HOME).toBe('/custom/user/gezel');
      expect(spawnEnv.GEZEL_PORT).toBe('0');
      expect(spawnEnv.GEZEL_SERVICE_ROLE).toBe('user');
    } finally {
      restoreEnv('GEZEL_HOME', originalHome);
    }
  });

  it('does not allow discovery-only third-party callers to request spawning without an entry', async () => {
    await expect(
      authorizeLocal({
        appId: 'third-party',
        appName: 'Third Party',
        scopes: ['openai'],
        daemon: { spawnIfMissing: true },
      }),
    ).rejects.toMatchObject({ code: 'daemon_entry_required' });
    expect(discoverOrSpawn).not.toHaveBeenCalled();
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
