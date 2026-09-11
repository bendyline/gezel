import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  home: '',
  runtime: vi.fn(),
  inspect: vi.fn(),
  fetch: vi.fn(),
  local: vi.fn(),
  unstampedDev: undefined as boolean | undefined,
}));
vi.mock('@bendyline/gezel', async (original) => {
  const actual = await original<typeof import('@bendyline/gezel')>();
  return {
    ...actual,
    isUnstampedDevBuild: (version: string) =>
      mocks.unstampedDev ?? actual.isUnstampedDevBuild(version),
  };
});
vi.mock('@bendyline/gezel-client/node', async (original) => ({
  ...(await original<typeof import('@bendyline/gezel-client/node')>()),
  systemServiceHome: () => mocks.home,
  readSystemServiceRuntime: mocks.runtime,
}));
vi.mock('../../machine-engine/bridge.js', () => ({ inspectMachineRuntime: mocks.inspect }));
vi.mock('../../remotes/pinned-fetch.js', () => ({
  createPinnedFetch: () => Object.assign(mocks.fetch, { close: async () => {} }),
}));
vi.mock('./device-capacity-ledger.js', () => ({
  DeviceCapacityLedger: class {
    execute = mocks.local;
  },
}));
vi.mock('./measured-budget.js', () => ({
  measuredCapacityBudget: async () => ({ kind: 'unified', fastBytes: 96 * 1024 ** 3 }),
}));

import { GEZEL_VERSION } from '@bendyline/gezel';
import {
  acquireNativeCapacity,
  assessBrokerVersionSkew,
  estimateNativeLaunchMemory,
} from './device-capacity.js';

const dirs: string[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  mocks.unstampedDev = undefined;
  mocks.home = `/test-machine-${randomUUID()}`;
  // Same build on both sides: the ordinary production shape, where the
  // installed broker is the authority. The skew suite below varies it.
  mocks.inspect.mockResolvedValue({
    pinnedIdentityFingerprint: 'stable-device',
    gezelVersion: GEZEL_VERSION,
  });
  mocks.runtime.mockResolvedValue({
    serviceRole: 'machine-engine',
    cert: 'cert-1',
    token: 'token-1',
    baseUrl: 'https://127.0.0.1:6228',
  });
  mocks.fetch.mockImplementation(
    async () => new Response(JSON.stringify({ state: 'granted', releaseRequested: false })),
  );
  mocks.local.mockResolvedValue({ state: 'granted', releaseRequested: false });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
const acquire = () =>
  acquireNativeCapacity(
    { home: '/isolated-eval', requirement: () => ({ bytes: 1024 ** 3 }) },
    { command: 'fake-model', args: [], baseUrl: 'http://127.0.0.1:9999' },
    new AbortController().signal,
    () => {},
  );

describe('native capacity broker discovery', () => {
  it('coordinates isolated eval inference through the installed broker', async () => {
    vi.stubEnv('GEZEL_DISABLE_MACHINE_ENGINE', '1');
    const lease = await acquire();
    const [url, init] = mocks.fetch.mock.calls[0]!;
    expect(url).toContain('/v1/remote/manage/native-capacity');
    expect(init.headers.authorization).toBe('Bearer token-1');
    expect(JSON.parse(init.body)).toMatchObject({ action: 'acquire', ownerPid: process.pid });
    expect(mocks.local).not.toHaveBeenCalled();
    await lease.release();
  });

  it('uses the local ledger after an explicit self-hosted startup choice', async () => {
    vi.stubEnv('GEZEL_NATIVE_CAPACITY_AUTHORITY', 'local');
    const lease = await acquire();
    expect(mocks.local).toHaveBeenCalled();
    expect(mocks.runtime).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
    await lease.release();
  });

  it('refreshes rotated credentials and re-verifies the same identity after broker restart', async () => {
    const lease = await acquire();
    mocks.runtime.mockResolvedValue({
      serviceRole: 'machine-engine',
      cert: 'cert-2',
      token: 'token-2',
      baseUrl: 'https://127.0.0.1:6228',
    });
    await lease.bind(process.pid);
    expect(mocks.inspect).toHaveBeenCalledTimes(2);
    expect(mocks.fetch.mock.calls.at(-1)![1].headers.authorization).toBe('Bearer token-2');
    mocks.runtime.mockResolvedValue({
      serviceRole: 'machine-engine',
      cert: 'cert-3',
      token: 'token-3',
      baseUrl: 'https://127.0.0.1:6228',
    });
    mocks.inspect.mockResolvedValue({ pinnedIdentityFingerprint: 'different-device' });
    await expect(lease.ready()).rejects.toThrow(/identity changed/);
  });

  it('does not create a second ledger when the broker temporarily disappears', async () => {
    const lease = await acquire();
    mocks.runtime.mockResolvedValue(null);
    await expect(lease.shouldYield()).rejects.toThrow(/restore memory coordination/);
    await expect(acquire()).rejects.toThrow(/restore memory coordination/);
    expect(mocks.local).not.toHaveBeenCalled();
  });

  it('requires an older broker to update instead of bypassing admission', async () => {
    mocks.fetch.mockImplementation(async () => new Response('', { status: 404 }));
    await expect(acquire()).rejects.toThrow(/needs an update/);
    expect(mocks.local).not.toHaveBeenCalled();
  });

  it('preserves an actionable capacity denial from the broker', async () => {
    mocks.fetch.mockImplementation(
      async () =>
        new Response(JSON.stringify({ error: 'Working set exceeds safe device capacity.' }), {
          status: 409,
        }),
    );
    await expect(acquire()).rejects.toThrow('Working set exceeds safe device capacity.');
  });

  it('uses the account ledger when no broker is installed', async () => {
    mocks.runtime.mockResolvedValue(null);
    const lease = await acquire();
    expect(mocks.local).toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
    await lease.release();
  });
});

it('prices recognition projectors and image text encoders as well as main weights', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gezel-weight-estimate-'));
  dirs.push(dir);
  const model = join(dir, 'model');
  await mkdir(model);
  await writeFile(join(model, 'weights.safetensors'), Buffer.alloc(100));
  await writeFile(join(model, 'config.json'), Buffer.alloc(999));
  const projector = join(dir, 'projector.gguf');
  const encoder = join(dir, 'encoder.gguf');
  await writeFile(projector, Buffer.alloc(200));
  await writeFile(encoder, Buffer.alloc(300));
  expect(
    await estimateNativeLaunchMemory({
      command: 'engine',
      args: ['--model', model, '--mmproj', projector, '--llm', encoder, '--accelerator', 'cpu'],
      baseUrl: '',
    }),
  ).toEqual({ bytes: 900 + 1024 ** 3, gpuBytes: 0 });
});

describe('admission wait ceilings', () => {
  const waitFor = async (
    replies: () => { state: string; releaseRequested: boolean; [k: string]: unknown },
  ) => {
    vi.stubEnv('GEZEL_NATIVE_CAPACITY_AUTHORITY', 'local');
    mocks.local.mockImplementation(async (command: { action: string }) =>
      command.action === 'acquire' ? replies() : { state: 'released', releaseRequested: false },
    );
    const started = Date.now();
    const flight = acquireNativeCapacity(
      { home: '/isolated-eval', requirement: () => ({ bytes: 1024 ** 3 }) },
      { command: 'fake-model', args: [], baseUrl: 'http://127.0.0.1:9999' },
      new AbortController().signal,
      () => {},
    ).then(
      () => ({ ok: true as const, elapsed: Date.now() - started }),
      (err: Error) => ({ ok: false as const, error: err, elapsed: Date.now() - started }),
    );
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    return flight;
  };

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('gives up in seconds when no engine is holding the memory', async () => {
    const result = await waitFor(() => ({
      state: 'waiting',
      releaseRequested: false,
      externalShortfall: true,
      requiredBytes: 9.7 * 1024 ** 3,
      availableBytes: 4.29 * 1024 ** 3,
    }));
    expect(result.ok).toBe(false);
    expect(result.elapsed).toBeLessThan(30_000);
    const message = (result as { error: Error }).error.message;
    // Names both numbers and says whose memory it is — the old wording
    // described protecting engine work that, in this branch, does not exist.
    expect(message).toContain('9.7 GB');
    expect(message).toContain('4.3 GB');
    expect(message).toContain('other applications');
  });

  it('still waits out the full budget behind another engine', async () => {
    const result = await waitFor(() => ({ state: 'waiting', releaseRequested: false }));
    expect(result.ok).toBe(false);
    expect(result.elapsed).toBeGreaterThanOrEqual(5 * 60_000);
    expect((result as { error: Error }).error.message).toContain('still protected');
  });

  it('forgives a transient shortfall that clears before the ceiling', async () => {
    let calls = 0;
    const result = await waitFor(() => {
      calls += 1;
      if (calls <= 4)
        return {
          state: 'waiting',
          releaseRequested: false,
          externalShortfall: true,
          requiredBytes: 4 * 1024 ** 3,
          availableBytes: 3 * 1024 ** 3,
        };
      return { state: 'granted', releaseRequested: false };
    });
    expect(result.ok).toBe(true);
  });
});

describe('memory-authority version skew', () => {
  it('is not skew when the broker is the same build', () => {
    expect(assessBrokerVersionSkew('1.26251.69', '1.26251.69')).toBeNull();
    expect(assessBrokerVersionSkew('0.0.0', '0.0.0')).toBeNull();
  });

  it('sends a dev checkout to its own ledger, whatever the broker reports', () => {
    // Ordering would say the opposite: 0.0.0 sorts BELOW every stamped
    // release. The test is "unstamped", because a checkout carries code no
    // release has yet — which is the whole reason to run it locally.
    for (const broker of ['1.26251.69', '9.99999.999', undefined]) {
      expect(assessBrokerVersionSkew(broker, '0.0.0')).toMatchObject({
        takeLocalAuthority: true,
        brokerVersion: broker ?? 'unknown',
      });
    }
  });

  it('never diverts a stamped build, but still reports the skew', () => {
    const skew = assessBrokerVersionSkew('1.26251.69', '1.26252.4');
    expect(skew).toMatchObject({ takeLocalAuthority: false, brokerVersion: '1.26251.69' });
  });

  it('uses the local ledger when a dev build meets an installed release broker', async () => {
    mocks.unstampedDev = true;
    mocks.inspect.mockResolvedValue({
      pinnedIdentityFingerprint: 'stable-device',
      gezelVersion: '1.26251.69',
    });
    const lease = await acquire();
    expect(mocks.local).toHaveBeenCalled();
    // The whole point: no admission request crosses to the older broker.
    expect(mocks.fetch).not.toHaveBeenCalled();
    await lease.release();
  });

  it('defers anyway when the operator asks for the machine authority', async () => {
    mocks.unstampedDev = true;
    mocks.inspect.mockResolvedValue({
      pinnedIdentityFingerprint: 'stable-device',
      gezelVersion: '1.26251.69',
    });
    vi.stubEnv('GEZEL_NATIVE_CAPACITY_AUTHORITY', 'machine');
    const lease = await acquire();
    expect(mocks.fetch).toHaveBeenCalled();
    expect(mocks.local).not.toHaveBeenCalled();
    await lease.release();
  });

  it('still refuses a competing ledger when the broker is merely unreachable', async () => {
    // An outage is not permission to double-book, and the diversion must not
    // become a way to reach the local ledger by breaking identity discovery.
    mocks.inspect.mockRejectedValue(new Error('identity returned HTTP 503'));
    await expect(acquire()).rejects.toThrow(/HTTP 503/);
    // The broker then goes away entirely. Claiming the authority before
    // rethrowing above is what keeps this from quietly becoming a second
    // ledger beside whatever the installed engine had already admitted — the
    // diversion must not be reachable by breaking identity discovery.
    mocks.runtime.mockResolvedValue(null);
    await expect(acquire()).rejects.toThrow(/restore memory coordination/);
    expect(mocks.local).not.toHaveBeenCalled();
  });
});
