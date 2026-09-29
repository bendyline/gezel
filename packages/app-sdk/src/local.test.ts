import { afterEach, describe, expect, it, vi } from 'vitest';

const discoverOrSpawn = vi.hoisted(() => vi.fn());
const createTrustingFetch = vi.hoisted(() => vi.fn());
const readSystemServiceEndpoint = vi.hoisted(() => vi.fn());

vi.mock('@bendyline/gezel-client/node', async (original) => ({
  ...(await original<object>()),
  discoverOrSpawn,
  createTrustingFetch,
  createPatientFetch: () => Object.assign(vi.fn(), { close: vi.fn(async () => {}) }),
  readSystemServiceEndpoint,
  DaemonNotRunningError: class DaemonNotRunningError extends Error {},
}));

const { authorizeLocal, authorizeLocalOwner } = await import('./local.js');

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
    vi.resetAllMocks();
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

  it('omits GEZEL_PORT for an opted-in canonical-port spawn while still stripping inherited values', async () => {
    process.env.GEZEL_PORT = '6228';
    discoverOrSpawn.mockResolvedValueOnce({
      outcome: 'spawned',
      baseUrl: 'https://127.0.0.1:6228',
      token: 'owner-token',
      cert: null,
      pid: 4242,
      client: {},
    });

    await authorizeLocalOwner({
      daemon: {
        daemonEntry: '/bundled/gezeld.js',
        spawnIfMissing: true,
        preferCanonicalPort: true,
      },
    });

    const spawnEnv = discoverOrSpawn.mock.calls[0]?.[0]?.env as NodeJS.ProcessEnv;
    // Unset (not inherited, not '0') → gezeld's 6228-with-ephemeral-fallback
    // path. The inherited developer-shell value must still be stripped.
    expect(spawnEnv.GEZEL_PORT).toBeUndefined();
    expect(spawnEnv.GEZEL_SERVICE_ROLE).toBe('user');
    expect(spawnEnv.GEZEL_SYSTEM_SCOPE).toBeUndefined();
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

  it('adopts a legacy full-product system service before the per-user ladder', async () => {
    readSystemServiceEndpoint.mockResolvedValueOnce({
      baseUrl: 'http://127.0.0.1:6228',
      port: 6228,
      cert: null,
      home: '/machine/gezel',
    });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true, serviceRole: 'legacy-full' }))
      .mockResolvedValueOnce(
        jsonResponse({ grantRequestId: 'grant-1', status: 'approved', token: 'app-token' }, 201),
      ) as unknown as typeof fetch;

    const authorized = await authorizeLocal({
      appId: 'vscode',
      appName: 'Visual Studio Code',
      scopes: ['product'],
      fetch: fetchImpl,
      onVerificationCode: () => {},
      daemon: { daemonEntry: '/bundled/gezeld.js', spawnIfMissing: true },
    });

    expect(authorized).toMatchObject({
      baseUrl: 'http://127.0.0.1:6228',
      token: 'app-token',
      daemon: { mode: 'legacy-full', cert: null },
    });
    expect(discoverOrSpawn).not.toHaveBeenCalled();
  });

  it('never treats a machine-engine service as a product endpoint', async () => {
    readSystemServiceEndpoint.mockResolvedValueOnce({
      baseUrl: 'http://127.0.0.1:6228',
      port: 6228,
      cert: null,
      home: '/machine/gezel',
    });
    discoverOrSpawn.mockResolvedValueOnce({
      outcome: 'spawned',
      baseUrl: 'http://127.0.0.1:54321',
      token: 'owner-token',
      cert: null,
      pid: 4242,
      client: {},
    });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true, serviceRole: 'machine-engine' }))
      .mockResolvedValueOnce(
        jsonResponse({ grantRequestId: 'grant-1', status: 'approved', token: 'app-token' }, 201),
      ) as unknown as typeof fetch;

    const authorized = await authorizeLocal({
      appId: 'vscode',
      appName: 'Visual Studio Code',
      scopes: ['product'],
      fetch: fetchImpl,
      onVerificationCode: () => {},
      daemon: { daemonEntry: '/bundled/gezeld.js', spawnIfMissing: true },
    });

    expect(authorized.daemon.mode).toBe('spawned');
    expect(authorized.baseUrl).toBe('http://127.0.0.1:54321');
    expect(discoverOrSpawn).toHaveBeenCalledOnce();
  });

  it('lets a first-party same-user client adopt the rotating owner token without consent', async () => {
    const trustingFetch = vi.fn() as unknown as typeof fetch;
    createTrustingFetch.mockReturnValueOnce(trustingFetch);
    discoverOrSpawn.mockResolvedValueOnce({
      outcome: 'spawned',
      baseUrl: 'https://127.0.0.1:54321',
      token: 'scoped-owner-token',
      cert: 'loopback-cert',
      pid: 4242,
      client: {},
    });

    const authorized = await authorizeLocalOwner({
      daemon: {
        daemonEntry: '/bundled/gezeld.js',
        spawnIfMissing: true,
      },
    });

    expect(authorized).toMatchObject({
      baseUrl: 'https://127.0.0.1:54321',
      token: 'scoped-owner-token',
      fetch: trustingFetch,
      daemon: { mode: 'spawned', pid: 4242, cert: 'loopback-cert' },
    });
  });

  it('lets a Gezel add-in trade the owner credential for its own grant, without a code', async () => {
    discoverOrSpawn.mockResolvedValueOnce({
      outcome: 'adopted',
      baseUrl: 'https://127.0.0.1:54321',
      token: 'owner-token',
      cert: null,
      pid: 4242,
      client: {},
    });
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(String(input));
      const auth = new Headers(init?.headers).get('authorization');
      calls.push(`${init?.method ?? 'GET'} ${url.pathname} ${auth}`);
      if (url.pathname === '/v1/apps/local-connect') {
        expect(JSON.parse(String(init?.body))).toEqual({ appId: 'vscode' });
        return jsonResponse({ appId: 'vscode', token: 'add-in-token' });
      }
      return jsonResponse({});
    }) as unknown as typeof fetch;
    const saved = new Map<string, string>();
    const onVerificationCode = vi.fn();

    const authorized = await authorizeLocal({
      appId: 'vscode',
      appName: 'Visual Studio Code',
      scopes: ['product', 'openai'],
      fetch: fetchImpl,
      onVerificationCode,
      gezelAddIn: true,
      tokenStorage: { save: (id, token) => void saved.set(id, token) },
      daemon: { daemonEntry: '/bundled/gezeld.js', spawnIfMissing: true },
    });

    expect(authorized.token).toBe('add-in-token');
    expect(saved.get('vscode')).toBe('add-in-token');
    expect(onVerificationCode).not.toHaveBeenCalled();
    expect(calls).toEqual([
      'POST /v1/apps/local-connect Bearer owner-token',
      'GET /api/config Bearer add-in-token',
      'GET /v1/models Bearer add-in-token',
    ]);
    expect(JSON.stringify(authorized)).not.toContain('owner-token');
  });

  it('asks for a code when the daemon will not exchange', async () => {
    discoverOrSpawn.mockResolvedValueOnce({
      outcome: 'adopted',
      baseUrl: 'https://127.0.0.1:54321',
      token: 'owner-token',
      cert: null,
      pid: 4242,
      client: {},
    });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: 'not_found' }, 404))
      .mockResolvedValueOnce(
        jsonResponse({ grantRequestId: 'grant-1', status: 'approved', token: 'app-token' }, 201),
      ) as unknown as typeof fetch;

    const authorized = await authorizeLocal({
      appId: 'vscode',
      appName: 'Visual Studio Code',
      scopes: ['product', 'openai'],
      fetch: fetchImpl,
      onVerificationCode: () => {},
      gezelAddIn: true,
      daemon: { daemonEntry: '/bundled/gezeld.js' },
    });

    expect(authorized.token).toBe('app-token');
    expect(String(vi.mocked(fetchImpl).mock.calls[1]?.[0])).toContain('/v1/apps/register');
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
