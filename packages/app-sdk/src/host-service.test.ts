import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hostInProcess, resetHostStateForTest } from './host-service.js';
import type { HostServiceModule } from './host-types.js';

let root: string;
const cleanup: Array<() => Promise<void>> = [];

/** A service module that records its options and never binds a port. */
function stubService(port = 41234): HostServiceModule & {
  calls: unknown[];
  stopped: number;
  directFetch: typeof fetch;
} {
  const calls: unknown[] = [];
  const directFetch: typeof fetch = async () => new Response('direct');
  const module = {
    calls,
    stopped: 0,
    directFetch,
    startService: async (opts: Record<string, unknown>) => {
      calls.push(opts);
      return {
        port,
        clientToken: 'client-token',
        cert: null,
        profile: 'embedded-inference' as const,
        fetch: directFetch,
        stop: async () => {
          module.stopped += 1;
        },
      };
    },
  };
  return module;
}

/** Runtime files as a live daemon would leave them for this same home. */
async function writeRuntime(home: string, pid: number, port: number): Promise<void> {
  const dir = join(home, 'runtime');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'pid'), `${pid}\n`);
  await writeFile(join(dir, 'port'), `${port}\n`);
  await writeFile(join(dir, 'auth-token'), 'sibling-token\n');
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'gezel-host-service-'));
  resetHostStateForTest();
});

afterEach(async () => {
  for (const close of cleanup.splice(0)) await close().catch(() => undefined);
  resetHostStateForTest();
  await rm(root, { recursive: true, force: true }).catch(() => {});
  vi.restoreAllMocks();
});

describe('hostInProcess', () => {
  it("starts a user-role daemon on an ephemeral port in the app's home", async () => {
    const home = join(root, 'app-home');
    const service = stubService();
    const connection = await hostInProcess('qualla', { home, serviceModule: service });
    cleanup.push(() => connection.close());

    expect(connection.mode).toBe('hosted');
    expect(connection.home).toBe(home);
    expect(connection.token).toBe('client-token');
    expect(service.calls[0]).toMatchObject({
      home,
      role: 'user',
      // Never the canonical 6228: that port belongs to the machine's own Gezel.
      port: 0,
      preferCanonicalPort: false,
    });
  });

  it('passes the inference-only embedding profile to the service', async () => {
    const home = join(root, 'app-home');
    const service = stubService();
    const connection = await hostInProcess('qualla', {
      home,
      mode: 'in-process',
      inferenceOnly: true,
      serviceModule: service,
    });
    cleanup.push(() => connection.close());

    expect(service.calls[0]).toMatchObject({ embeddedInferenceOnly: true });
    expect(connection.fetch).toBe(service.directFetch);
  });

  it('fails fast when the service is too old for the inference-only profile', async () => {
    const home = join(root, 'app-home');
    const service = stubService();
    const startService = service.startService.bind(service);
    service.startService = async (opts) => {
      const running = await startService(opts);
      return { ...running, profile: undefined, fetch: undefined };
    };

    await expect(
      hostInProcess('qualla', {
        home,
        mode: 'in-process',
        inferenceOnly: true,
        serviceModule: service,
      }),
    ).rejects.toMatchObject({ code: 'service_inference_only_unsupported' });
    expect(service.stopped).toBe(1);
  });

  it('joins the daemon a sibling instance already started', async () => {
    const home = join(root, 'app-home');
    await writeRuntime(home, process.pid, 45001);
    const service = stubService();
    const health = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const connection = await hostInProcess(
      'qualla',
      { home, serviceModule: service },
      health as unknown as typeof fetch,
    );
    cleanup.push(() => connection.close());

    // A second window of the same app must not fail on the single-writer
    // lock, and must not start a rival daemon over the same home.
    expect(connection.mode).toBe('hosted-adopted');
    expect(connection.token).toBe('sibling-token');
    expect(service.calls).toHaveLength(0);

    // Closing an adopted connection leaves the daemon (and its runtime files)
    // alone: it belongs to whoever started it.
    await connection.close();
    await expect(readFile(join(home, 'runtime', 'pid'), 'utf8')).resolves.toContain(
      String(process.pid),
    );
  });

  it('starts its own daemon when the recorded process is gone', async () => {
    const home = join(root, 'app-home');
    // A pid that cannot be alive — the daemon died without cleaning up.
    await writeRuntime(home, 2 ** 31 - 1, 45002);
    const service = stubService();

    const connection = await hostInProcess('qualla', { home, serviceModule: service });
    cleanup.push(() => connection.close());

    expect(connection.mode).toBe('hosted');
    expect(service.calls).toHaveLength(1);
  });

  it('removes only the runtime files it owns', async () => {
    const home = join(root, 'app-home');
    const service = stubService();
    const connection = await hostInProcess('qualla', { home, serviceModule: service });
    // The stub never writes runtime files, so stand in for the daemon.
    await writeRuntime(home, process.pid, 45003);

    await connection.close();
    expect(service.stopped).toBe(1);
    await expect(readFile(join(home, 'runtime', 'pid'), 'utf8')).rejects.toThrow();

    // A daemon that appeared during our shutdown owns them now; deleting its
    // discovery files would strand every client of it.
    const other = await hostInProcess('qualla', { home, serviceModule: stubService() });
    await writeRuntime(home, 2 ** 31 - 2, 45004);
    await other.close();
    await expect(readFile(join(home, 'runtime', 'pid'), 'utf8')).resolves.toContain('2147483646');
  });

  it('refuses a second hosted daemon in one process', async () => {
    const home = join(root, 'app-home');
    const connection = await hostInProcess('qualla', { home, serviceModule: stubService() });
    cleanup.push(() => connection.close());

    await expect(
      hostInProcess('other', { home: join(root, 'other'), serviceModule: stubService() }),
    ).rejects.toMatchObject({ code: 'host_already_active' });
  });

  it('says what to install when the service is missing', async () => {
    await expect(
      hostInProcess('qualla', {
        home: join(root, 'app-home'),
        serviceEntry: '@bendyline/definitely-not-installed',
      }),
    ).rejects.toMatchObject({ code: 'service_not_installed' });
  });
});

describe('store embedding verification', () => {
  it('verifies before starting and restores ambient engine overrides on failure', async () => {
    const before = process.env.GEZEL_LLAMA_SERVER_BIN;
    process.env.GEZEL_LLAMA_SERVER_BIN = '/developer/override';
    const service = stubService();
    service.verifyNativeBinaries = vi.fn(async () => {
      expect(process.env.GEZEL_LLAMA_SERVER_BIN).toBeUndefined();
      return { reused: false, reason: 'fixture mismatch' };
    });
    try {
      await expect(
        hostInProcess('fixture', {
          home: join(root, 'store-home'),
          mode: 'in-process',
          inferenceOnly: true,
          distributionProfile: 'store',
          nativeBinDir: join(root, 'native'),
          serviceModule: service,
        }),
      ).rejects.toMatchObject({ code: 'native_verification_failed' });
      expect(service.calls).toEqual([]);
      expect(process.env.GEZEL_LLAMA_SERVER_BIN).toBe('/developer/override');
    } finally {
      if (before === undefined) delete process.env.GEZEL_LLAMA_SERVER_BIN;
      else process.env.GEZEL_LLAMA_SERVER_BIN = before;
    }
  });
});

it('requires a store payload before touching the service and verifies explicit development payloads', async () => {
  const service = stubService();
  await expect(
    hostInProcess('fixture', {
      home: join(root, 'store-home'),
      distributionProfile: 'store',
      serviceModule: service,
    }),
  ).rejects.toMatchObject({ code: 'native_payload_required' });
  expect(service.calls).toEqual([]);
  service.verifyNativeBinaries = vi.fn(async () => ({
    reused: false,
    reason: 'changed development payload',
  }));
  await expect(
    hostInProcess('fixture', {
      home: join(root, 'development'),
      nativeBinDir: join(root, 'native'),
      serviceModule: service,
    }),
  ).rejects.toMatchObject({ code: 'native_verification_failed' });
  expect(service.verifyNativeBinaries).toHaveBeenCalledWith({ candidates: [join(root, 'native')] });
  expect(service.calls).toEqual([]);
});
