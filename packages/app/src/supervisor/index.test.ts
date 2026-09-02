/**
 * Orchestration tests for the supervisor's 6-branch decision tree:
 *
 *   1.   Remote          (user-configured `service: { url, token }`)
 *   1.5. System-service  (Windows installer / future macOS·Linux)
 *   2.   Local-adopt     (existing `~/.gezel/runtime/` daemon)
 *   3.   Embedded        (forced, or default fallback)
 *   4.   Local-spawn-packaged  (packaged Electron, extract+spawn the bundle)
 *   5.   Local-spawn-dev       (dev mode with `GEZEL_SPAWN=1`)
 *
 * Each branch's leaf helpers (`extract-*`, `discoverOrSpawn`,
 * `startService`, etc.) are stubbed so the test exercises the
 * orchestration logic only — which mode wins, whether failures fall
 * through to embedded, and whether the load-bearing CLAUDE.md contract
 * holds: **a misconfigured remote URL must surface as a loud error,
 * not silently drift into embedded mode**.
 */

import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Hoisted mock context so vi.mock factories can read state set per-test.
// vi.mock is hoisted above imports, so the factories reference these
// fields via closure; each `beforeEach` resets them.
const ctx = vi.hoisted(() => ({
  health: undefined as
    | undefined
    | ((
        signal?: AbortSignal,
        connection?: { baseUrl: string; token: string },
      ) => Promise<{ ok: boolean; version: string; machineEngineConnected?: boolean }>),
  runtime: null as null | {
    pid: number;
    port: number;
    baseUrl: string;
    token: string;
    cert: string | null;
  },
  systemRuntime: null as null | {
    port: number;
    baseUrl: string;
    token: string;
    cert: string | null;
    home: string;
    serviceRole?: 'user' | 'machine-engine' | 'legacy-full';
  },
  machineProbeStatus: 200,
  systemHomeInfo: null as null | {
    home: string;
    scope: 'machine' | 'user';
    version: string;
    startedAt: string;
    firstRunCompleted: boolean;
    usage: {
      gezelCount: number;
      projectCount: number;
      sessionCount: number;
      everUsed: boolean;
    };
    memory: { totalBytes: number; freeBytes: number };
    engines: Array<{ key: string; residentBytes: number }>;
  },
  processAlive: true,
  llamaProbe: {
    backend: 'cpu' as 'cuda' | 'vulkan' | 'metal' | 'cpu',
    detectedBackend: 'cpu' as 'cuda' | 'vulkan' | 'metal' | 'cpu',
    cached: false,
    reason: 'mock',
  },
  nativeLlamaPaths: {} as Partial<Record<'cuda' | 'vulkan' | 'metal' | 'cpu', string>>,
  llamaQuarantine: [] as Array<{
    backend: 'cuda' | 'vulkan' | 'metal' | 'cpu';
    signal: string;
    reason: string;
  }>,
  nativeRoot: '/mock/native-bin',
  installedNativeCandidates: ['/mock/installed-native-bin'],
  nativeReuse: {
    reused: true,
    nativeBinDir: '/mock/native-bin',
    reason: 'verified Electron native release test',
  } as { reused: boolean; nativeBinDir?: string; reason: string },
  logLines: [] as string[],
}));

vi.mock('./extract-pnpm.js', () => ({
  defaultPnpmBundleDir: () => '/fake/pnpm-bundle',
  installPnpmIfNeeded: vi.fn().mockResolvedValue({ entryPath: null, verified: false }),
}));
vi.mock('./extract-node.js', () => ({
  defaultNodeBundleDir: () => '/fake/node-bundle',
  installNodeIfNeeded: vi.fn().mockResolvedValue({ binaryPath: null, verified: false }),
}));
vi.mock('./extract-bundle.js', () => ({
  // `defaultBundlePaths` returns paths to a non-existent tarball + meta so:
  //   - existsSync(tarballPath) returns false → embedded loader uses the
  //     bare specifier import (which we mock below).
  //   - `shippedServiceVersion` reads via readBundleMeta which returns null
  //     when the file is missing.
  defaultBundlePaths: () => ({
    tarballPath: '/fake/service-bundle.tar.gz',
    metaPath: '/fake/service-bundle.meta.json',
  }),
  readBundleMeta: vi.fn().mockResolvedValue(null),
  extractBundleIfNeeded: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./native-bin.js', () => ({
  resolveNativeBinaryPath: vi.fn((binaryName: string, _mainMetaUrl: string, variant?: string) =>
    binaryName === 'llama-server' && variant
      ? (ctx.nativeLlamaPaths[variant as keyof typeof ctx.nativeLlamaPaths] ?? null)
      : null,
  ),
  nativeBinDir: () => ctx.nativeRoot,
}));
// Probe + cache-bust key live in core (`@bendyline/gezel/native`)
// because the supervisor needs to static-import them BEFORE the
// service starts — pulling them from the service package would force
// electron-builder to copy the service's transitive deps into
// app.asar (see ./llama-backend.ts for the long form). Mock the
// shared module here so the supervisor's static import resolves to a
// deterministic CPU verdict in tests.
vi.mock('@bendyline/gezel/native', () => ({
  LLAMA_ENGINE_VERSION: 'mock-engine',
  detectLlamaBackend: () => ctx.llamaProbe,
  // Quarantine is exercised for real in core's own suite; these
  // supervisor branch tests only need it to be inert.
  readLlamaQuarantine: () => ctx.llamaQuarantine,
  isBinaryQuarantined: (
    entries: Array<{ backend: string }>,
    backend: 'cuda' | 'vulkan' | 'metal' | 'cpu',
  ) => entries.some((e) => e.backend === backend),
  resolveAvailableLlamaBinary: (
    preferredBackend: 'cuda' | 'vulkan' | 'metal' | 'cpu',
    resolveBinary: (backend: 'cuda' | 'vulkan' | 'metal' | 'cpu') => string | null,
    allowFallbacks: boolean,
    isUsable?: (backend: 'cuda' | 'vulkan' | 'metal' | 'cpu', path: string) => boolean,
  ) => {
    const fallbackOrder = {
      cuda: ['cuda', 'vulkan', 'cpu'],
      vulkan: ['vulkan', 'cpu'],
      metal: ['metal', 'cpu'],
      cpu: ['cpu'],
    } as const;
    const candidates = allowFallbacks ? fallbackOrder[preferredBackend] : [preferredBackend];
    const skippedUnusable: string[] = [];
    for (const backend of candidates) {
      const path = resolveBinary(backend);
      if (!path) continue;
      if (allowFallbacks && isUsable && !isUsable(backend, path)) {
        skippedUnusable.push(backend);
        continue;
      }
      return {
        backend,
        path,
        ...(backend === preferredBackend ? {} : { fallbackFrom: preferredBackend }),
        ...(skippedUnusable.length > 0 ? { skippedUnusable: [...skippedUnusable] } : {}),
      };
    }
    return null;
  },
}));
vi.mock('./mode.js', () => ({ resolveMode: vi.fn(), resolvePerUserMode: vi.fn() }));
vi.mock('./system-service.js', () => ({
  readSystemServiceRuntime: vi.fn(() => Promise.resolve(ctx.systemRuntime)),
  // Null keeps the pre-spawn machine re-check inert for the per-user branch
  // tests; the system-service tests drive everything through ctx.systemRuntime.
  systemServiceHome: vi.fn(() => null),
}));
vi.mock('./log-rotator.js', () => ({
  LogRotator: class {
    write = vi.fn(async (line: string) => {
      ctx.logLines.push(line);
    });
    close = vi.fn().mockResolvedValue(undefined);
  },
}));
vi.mock('@bendyline/gezel-client/node', () => ({
  GezelClient: class MockGezelClient {
    constructor(private readonly connection: { baseUrl: string; token: string }) {}
    health(signal?: AbortSignal) {
      if (!ctx.health) throw new Error('test forgot to set ctx.health');
      return ctx.health(signal, this.connection);
    }
    getSystemHomeInfo() {
      if (!ctx.systemHomeInfo) {
        // Mirrors a daemon predating GET /api/system/home — the caller
        // treats it as "no evidence" and stays on the machine service.
        return Promise.reject(new Error('404 Not Found'));
      }
      return Promise.resolve(ctx.systemHomeInfo);
    }
  },
  createTrustingFetch: () =>
    vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes('/v1/remote/models')) {
        return new Response(
          JSON.stringify(ctx.machineProbeStatus === 200 ? { models: [] } : { error: 'offline' }),
          {
            status: ctx.machineProbeStatus,
            headers: { 'content-type': 'application/json' },
          },
        );
      }
      return fetch(input);
    }),
  discoverOrSpawn: vi.fn(),
  readRuntime: vi.fn(() => Promise.resolve(ctx.runtime)),
  isProcessAlive: vi.fn(() => ctx.processAlive),
  resolveDaemonEntry: () => '/fake/daemon-entry.js',
  stopProcessByPid: vi.fn().mockResolvedValue(true),
  stopOwnedDaemon: vi.fn(async (child?: ChildProcess) => {
    if (child && child.exitCode == null && child.signalCode == null) child.kill('SIGTERM');
  }),
  systemSharedAssetsDir: () => '/mock/shared-assets',
  electronNativeBinCandidates: () => ctx.installedNativeCandidates,
}));
vi.mock('@bendyline/gezel-service', () => ({
  startService: vi.fn().mockResolvedValue({
    port: 11111,
    context: { token: 'embedded-token' },
    cert: { certPem: 'EMBEDDED-CERT-PEM' },
    stop: vi.fn().mockResolvedValue(undefined),
  }),
  reuseVerifiedElectronNativeBinaries: vi.fn(async () => {
    if (ctx.nativeReuse.reused && ctx.nativeReuse.nativeBinDir) {
      process.env.GEZEL_NATIVE_BIN_DIR = ctx.nativeReuse.nativeBinDir;
    }
    return ctx.nativeReuse;
  }),
}));

// Imports must come after vi.mock so they pick up the mocked versions.
const { SupervisedService, connectOrStart, gracefullyStop, healthWithTimeout, stopProcessByPid } =
  await import('./index.js');
const { resolveMode } = await import('./mode.js');
const { resolveNativeBinaryPath } = await import('./native-bin.js');
const {
  discoverOrSpawn,
  stopOwnedDaemon,
  stopProcessByPid: stopDaemonProcessByPid,
} = await import('@bendyline/gezel-client/node');
const { extractBundleIfNeeded, readBundleMeta } = await import('./extract-bundle.js');
const { installNodeIfNeeded } = await import('./extract-node.js');
const { installPnpmIfNeeded } = await import('./extract-pnpm.js');
const { startService } = await import('@bendyline/gezel-service');

// Env keys the supervisor's prelude mutates. We snapshot at the start
// of each test and restore at the end so test order doesn't leak.
const ENV_KEYS = [
  'GEZEL_PNPM_PATH',
  'GEZEL_NODE_PATH',
  'GEZEL_SKIP_BUNDLED_RUNTIME_INSTALL',
  'GEZEL_DS4_SERVER_BIN',
  'GEZEL_SD_SERVER_BIN',
  'GEZEL_LLAMA_SERVER_BIN',
  'GEZEL_LLAMA_DETECTED_BACKEND',
  'GEZEL_LLAMA_DETECTED_VENDOR',
  'GEZEL_LLAMA_SERVER_BACKEND',
  'GEZEL_WHISPER_SERVER_BIN',
  'GEZEL_UV_BIN',
  'GEZEL_NATIVE_BIN_DIR',
  'GEZEL_SHARED_ASSETS_DIR',
];
let envSnapshot: Record<string, string | undefined>;
let testHome: string;

beforeEach(async () => {
  envSnapshot = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  testHome = await mkdtemp(join(tmpdir(), 'gezel-sup-orch-'));
  // Default: succeed. Branch tests override.
  ctx.health = () => Promise.resolve({ ok: true, version: '1.0.0' });
  ctx.runtime = null;
  ctx.systemRuntime = null;
  ctx.systemHomeInfo = null;
  ctx.machineProbeStatus = 200;
  ctx.processAlive = true;
  ctx.llamaProbe = {
    backend: 'cpu',
    detectedBackend: 'cpu',
    cached: false,
    reason: 'mock',
  };
  ctx.nativeLlamaPaths = {};
  ctx.nativeRoot = '/mock/native-bin';
  ctx.installedNativeCandidates = ['/mock/installed-native-bin'];
  ctx.nativeReuse = {
    reused: true,
    nativeBinDir: ctx.nativeRoot,
    reason: 'verified Electron native release test',
  };
  ctx.logLines = [];
  // "We can't read our own bundle version" is the default, which makes every
  // version check a no-op. Reset explicitly: `vi.clearAllMocks()` clears call
  // records but leaves implementations in place, so a test that stubs a
  // shipped version would otherwise leak it into the rest of the file.
  vi.mocked(readBundleMeta).mockResolvedValue(null);
});

afterEach(async () => {
  for (const k of ENV_KEYS) {
    if (envSnapshot[k] === undefined) delete process.env[k];
    else process.env[k] = envSnapshot[k];
  }
  await rm(testHome, { recursive: true, force: true }).catch(() => {});
  vi.clearAllMocks();
});

/**
 * A minimal fake child satisfying the surface `attachSpawned` /
 * `gracefullyStop` touch: stdout & stderr emitters, a `kill()` that
 * synchronously emits `exit` (so `gracefullyStop` doesn't hang on the
 * 3s SIGKILL fallback timer).
 */
function makeFakeChild(): ChildProcess {
  const ee = new EventEmitter() as EventEmitter & {
    pid: number;
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: null;
    killed: boolean;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    kill: (sig?: NodeJS.Signals) => boolean;
  };
  ee.pid = 12345;
  ee.stdout = new EventEmitter();
  ee.stderr = new EventEmitter();
  ee.stdin = null;
  ee.killed = false;
  ee.exitCode = null;
  ee.signalCode = null;
  ee.kill = vi.fn((signal: NodeJS.Signals = 'SIGTERM') => {
    ee.killed = true;
    ee.signalCode = signal;
    setImmediate(() => ee.emit('exit', null, signal));
    return true;
  });
  return ee as unknown as ChildProcess;
}

/**
 * A shipped-bundle sidecar carrying the version under test. Only `version`
 * matters to the version checks; the digest fields are filler so the stub
 * satisfies `BundleMeta`.
 */
function bundleMeta(version: string) {
  return { version, sha256: 'stub-sha', sizeBytes: 1, fileCount: 1 };
}

function baseOpts(overrides: Partial<Parameters<typeof connectOrStart>[0]> = {}) {
  return {
    home: testHome,
    packaged: false,
    devSpawn: false,
    forceEmbedded: false,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...overrides,
  };
}

describe('bundled runtime prelude', () => {
  it('lets development E2Es bypass repeated bundled runtime installs', async () => {
    process.env.GEZEL_SKIP_BUNDLED_RUNTIME_INSTALL = '1';
    process.env.GEZEL_NODE_PATH = '/development/node';
    vi.mocked(resolveMode).mockResolvedValue({
      kind: 'remote',
      baseUrl: 'https://remote.example.test',
      token: 'remote-tok',
      cert: null,
    });
    const logger = baseOpts().logger;

    const svc = await connectOrStart(baseOpts({ logger }));

    expect(installNodeIfNeeded).not.toHaveBeenCalled();
    expect(installPnpmIfNeeded).not.toHaveBeenCalled();
    expect(process.env.GEZEL_NODE_PATH).toBe('/development/node');
    expect(logger.info).toHaveBeenCalledWith(
      '[supervisor] skipping bundled runtime install in development',
    );
    await svc.shutdown();
  });

  it('never lets the development bypass disable packaged provisioning', async () => {
    process.env.GEZEL_SKIP_BUNDLED_RUNTIME_INSTALL = '1';
    vi.mocked(resolveMode).mockResolvedValue({
      kind: 'remote',
      baseUrl: 'https://remote.example.test',
      token: 'remote-tok',
      cert: null,
    });

    const svc = await connectOrStart(baseOpts({ packaged: true }));

    expect(installNodeIfNeeded).toHaveBeenCalledOnce();
    expect(installPnpmIfNeeded).toHaveBeenCalledOnce();
    await svc.shutdown();
  });

  it('clears inherited runtime overrides when the bundles are not verified', async () => {
    process.env.GEZEL_NODE_PATH = '/untrusted/global/node';
    process.env.GEZEL_PNPM_PATH = '/untrusted/global/pnpm';
    vi.mocked(resolveMode).mockResolvedValue({
      kind: 'remote',
      baseUrl: 'https://remote.example.test',
      token: 'remote-tok',
      cert: null,
    });

    const svc = await connectOrStart(baseOpts({ packaged: true }));
    expect(process.env.GEZEL_NODE_PATH).toBeUndefined();
    expect(process.env.GEZEL_PNPM_PATH).toBeUndefined();
    await svc.shutdown();
  });

  it('exposes only manifest-verified bundled script runtimes in packaged mode', async () => {
    const bundledNode = join(testHome, 'bin', 'node');
    const bundledPnpm = join(testHome, 'bin', 'pnpm-runtime', 'bin', 'pnpm.mjs');
    vi.mocked(installNodeIfNeeded).mockResolvedValueOnce({
      binaryPath: bundledNode,
      version: '24.18.0',
      action: 'up-to-date',
      verified: true,
    });
    vi.mocked(installPnpmIfNeeded).mockResolvedValueOnce({
      entryPath: bundledPnpm,
      version: '11.15.1',
      action: 'up-to-date',
      verified: true,
    });
    vi.mocked(resolveMode).mockResolvedValue({
      kind: 'remote',
      baseUrl: 'https://remote.example.test',
      token: 'remote-tok',
      cert: null,
    });

    const svc = await connectOrStart(baseOpts({ packaged: true }));
    expect(process.env.GEZEL_NODE_PATH).toBe(bundledNode);
    expect(process.env.GEZEL_PNPM_PATH).toBe(bundledPnpm);
    await svc.shutdown();
  });
});

// ── Branch 1: remote ────────────────────────────────────────────────

describe('Branch 1 — remote', () => {
  it('returns mode "remote" when probe succeeds', async () => {
    vi.mocked(resolveMode).mockResolvedValue({
      kind: 'remote',
      baseUrl: 'https://remote.example.test',
      token: 'remote-tok',
      cert: null,
    });
    ctx.health = () => Promise.resolve({ ok: true, version: '1.0.0' });
    const svc = await connectOrStart(baseOpts());
    expect(svc.mode).toBe('remote');
    expect(svc.baseUrl).toBe('https://remote.example.test');
    expect(svc.token).toBe('remote-tok');
    await svc.shutdown();
  });

  // The CLAUDE.md contract: misconfigured remote URL surfaces as a
  // loud error, not silently drifting into embedded mode. If this
  // ever changes to a fallback, packaged users with a stale `service:`
  // config experience a "the app launched but nothing works"
  // diagnostic — the worst possible UX.
  it('THROWS when remote probe fails — does NOT silently fall through to embedded', async () => {
    vi.mocked(resolveMode).mockResolvedValue({
      kind: 'remote',
      baseUrl: 'https://offline.example.test',
      token: 'remote-tok',
      cert: null,
    });
    ctx.health = () => Promise.reject(new Error('connection refused'));
    await expect(connectOrStart(baseOpts())).rejects.toThrow(
      /did not respond.*connection refused/i,
    );
  });
});

// ── Branch 1.5: system-service ──────────────────────────────────────

/** The post-SCM mode shape: connection details come from runtime files. */
function sysMode(
  overrides: Partial<{
    serviceHome: string;
    waitForStartup: boolean;
    hostingPin: 'auto' | 'machine-service' | 'per-user';
  }> = {},
) {
  return {
    kind: 'system-service' as const,
    serviceHome: overrides.serviceHome ?? '/var/lib/gezel',
    runtime: ctx.systemRuntime,
    waitForStartup: overrides.waitForStartup ?? false,
    hostingPin: overrides.hostingPin ?? ('auto' as const),
  };
}

function sysRuntime(
  home = '/var/lib/gezel',
  serviceRole?: 'user' | 'machine-engine' | 'legacy-full',
) {
  return {
    port: 5555,
    baseUrl: 'https://127.0.0.1:5555',
    token: 'svc-tok',
    cert: 'CERT',
    home,
    ...(serviceRole ? { serviceRole } : {}),
  };
}

describe('Branch 1.5 — system-service', () => {
  it('uses the machine daemon only as an engine and starts a per-user product service', async () => {
    ctx.systemRuntime = sysRuntime('/var/lib/gezel', 'machine-engine');
    vi.mocked(resolveMode).mockResolvedValue(sysMode());
    const { resolvePerUserMode } = await import('./mode.js');
    vi.mocked(resolvePerUserMode).mockResolvedValue({ kind: 'embedded' });

    const svc = await connectOrStart(baseOpts({ packaged: true }));

    expect(svc.mode).toBe('embedded');
    expect(svc.baseUrl).toBe('https://127.0.0.1:11111');
    await svc.shutdown();
  });

  it('keeps the user product daemon healthy when the machine engine probe fails', async () => {
    ctx.systemRuntime = sysRuntime('/var/lib/gezel', 'machine-engine');
    ctx.machineProbeStatus = 503;
    vi.mocked(resolveMode).mockResolvedValue(sysMode());
    const { resolvePerUserMode } = await import('./mode.js');
    vi.mocked(resolvePerUserMode).mockResolvedValue({ kind: 'embedded' });

    const svc = await connectOrStart(baseOpts({ packaged: true }));

    expect(svc.mode).toBe('embedded');
    expect(svc.fallbackReason).toMatchObject({
      code: 'machine-engine-unavailable',
      sourceMode: 'system-service',
    });
    await svc.shutdown();
  });

  it('keeps a per-user hosting pin for legacy full-product machine daemons', async () => {
    ctx.systemRuntime = sysRuntime('/var/lib/gezel', 'legacy-full');
    vi.mocked(resolveMode).mockResolvedValue(sysMode({ hostingPin: 'per-user' }));
    const { resolvePerUserMode } = await import('./mode.js');
    vi.mocked(resolvePerUserMode).mockResolvedValue({ kind: 'embedded' });

    const svc = await connectOrStart(baseOpts({ packaged: true }));

    expect(svc.mode).toBe('embedded');
    await svc.shutdown();
  });

  it('keeps established machine-home data visible in explicit compatibility mode', async () => {
    ctx.systemRuntime = sysRuntime('/var/lib/gezel', 'legacy-full');
    vi.mocked(resolveMode).mockResolvedValue(sysMode());

    const svc = await connectOrStart(baseOpts({ packaged: true }));

    expect(svc.mode).toBe('system-service');
    expect(svc.fallbackReason).toMatchObject({
      code: 'legacy-machine-data',
      sourceMode: 'system-service',
    });
    await svc.shutdown();
  });

  it('returns mode "system-service" when health succeeds', async () => {
    ctx.systemRuntime = sysRuntime();
    vi.mocked(resolveMode).mockResolvedValue(sysMode());
    ctx.health = () => Promise.resolve({ ok: true, version: '1.0.0' });
    const svc = await connectOrStart(baseOpts({ packaged: true }));
    expect(svc.mode).toBe('system-service');
    expect(svc.baseUrl).toBe('https://127.0.0.1:5555');
    expect(svc.token).toBe('svc-tok');
    await svc.shutdown();
  });

  it('falls through to embedded when system-service health check fails', async () => {
    ctx.systemRuntime = sysRuntime();
    vi.mocked(resolveMode).mockResolvedValue(sysMode());
    ctx.health = () => Promise.reject(new Error('SCM stopped'));
    const svc = await connectOrStart(baseOpts({ packaged: true }));
    // Distinct from the remote contract: system-service IS allowed to
    // fall through (the user's machine still works, just embedded).
    expect(svc.mode).toBe('embedded');
    expect(svc.fallbackReason).toMatchObject({
      code: 'system-service-unhealthy',
      sourceMode: 'system-service',
    });
    await svc.shutdown();
  });

  // The install-race contract: when the SCM says the service is coming up,
  // the supervisor WAITS for runtime discovery instead of spawning a second
  // daemon beside it. Runtime files appearing mid-wait must be adopted.
  it('waits for runtime files when the service manager says the service is starting', async () => {
    ctx.systemRuntime = null;
    vi.mocked(resolveMode).mockResolvedValue(sysMode({ waitForStartup: true }));
    ctx.health = () => Promise.resolve({ ok: true, version: '1.0.0' });
    // Publish the runtime files "while the service boots" — after the
    // first poll misses.
    setTimeout(() => {
      ctx.systemRuntime = sysRuntime();
    }, 150);
    const svc = await connectOrStart(baseOpts({ packaged: true }));
    expect(svc.mode).toBe('system-service');
    expect(svc.baseUrl).toBe('https://127.0.0.1:5555');
    expect(discoverOrSpawn).not.toHaveBeenCalled();
    await svc.shutdown();
  }, 15_000);

  // The machine service's gezeld tree is written only by the platform
  // installer, so an app-only update (macOS ZIP via Squirrel) leaves it on
  // the previous release. We cannot stop or replace it, and falling back to
  // embedded would point the user at a different GEZEL_HOME — so we stay
  // connected and raise a banner instead.
  it('flags a version mismatch but stays connected to the system service', async () => {
    ctx.systemRuntime = sysRuntime('/Library/Application Support/Gezel');
    vi.mocked(resolveMode).mockResolvedValue(
      sysMode({ serviceHome: '/Library/Application Support/Gezel' }),
    );
    vi.mocked(readBundleMeta).mockResolvedValue(bundleMeta('1.26211.23'));
    ctx.health = () => Promise.resolve({ ok: true, version: '1.26210.19' });

    const svc = await connectOrStart(baseOpts({ packaged: true }));

    expect(svc.mode).toBe('system-service');
    expect(svc.baseUrl).toBe('https://127.0.0.1:5555');
    expect(svc.fallbackReason).toMatchObject({
      code: 'system-service-version-mismatch',
      sourceMode: 'system-service',
    });
    // Both versions must reach the user — "they disagree" alone is not
    // actionable when deciding whether to rerun the installer.
    expect(svc.fallbackReason?.message).toContain('1.26210.19');
    expect(svc.fallbackReason?.message).toContain('1.26211.23');
    expect(discoverOrSpawn).not.toHaveBeenCalled();
    await svc.shutdown();
  });

  it('stays quiet when the system service matches the shipped version', async () => {
    ctx.systemRuntime = sysRuntime();
    vi.mocked(resolveMode).mockResolvedValue(sysMode());
    vi.mocked(readBundleMeta).mockResolvedValue(bundleMeta('1.26211.23'));
    ctx.health = () => Promise.resolve({ ok: true, version: '1.26211.23' });

    const svc = await connectOrStart(baseOpts({ packaged: true }));

    expect(svc.mode).toBe('system-service');
    expect(svc.fallbackReason).toBeNull();
    await svc.shutdown();
  });

  // Dev workspaces move version-to-version constantly and any system service
  // present is a leftover from a real install, so the check would be noise.
  it('skips the version check outside packaged mode', async () => {
    ctx.systemRuntime = sysRuntime();
    vi.mocked(resolveMode).mockResolvedValue(sysMode());
    vi.mocked(readBundleMeta).mockResolvedValue(bundleMeta('9.9.9'));
    ctx.health = () => Promise.resolve({ ok: true, version: '1.0.0' });

    const svc = await connectOrStart(baseOpts({ packaged: false }));

    expect(svc.mode).toBe('system-service');
    expect(svc.fallbackReason).toBeNull();
    await svc.shutdown();
  });

  // Rerunning the installer is how a user resolves this banner, so the
  // reconnect that follows has to clear it rather than carry the boot-time
  // verdict for the rest of the session.
  it('clears the mismatch once the service reports a matching version', async () => {
    ctx.systemRuntime = sysRuntime('/Library/Application Support/Gezel');
    vi.mocked(resolveMode).mockResolvedValue(
      sysMode({ serviceHome: '/Library/Application Support/Gezel' }),
    );
    vi.mocked(readBundleMeta).mockResolvedValue(bundleMeta('1.26211.23'));
    ctx.health = () => Promise.resolve({ ok: true, version: '1.26210.19' });
    const svc = await connectOrStart(baseOpts({ packaged: true }));
    expect(svc.fallbackReason?.code).toBe('system-service-version-mismatch');

    ctx.health = () => Promise.resolve({ ok: true, version: '1.26211.23' });

    await svc.restart('after reinstall');

    expect(svc.mode).toBe('system-service');
    expect(svc.fallbackReason).toBeNull();
    await svc.shutdown();
  });

  // The fresh-home guard: a healthy machine service whose home has never
  // been used must not shadow a per-user home holding real work — that
  // combination is exactly the split tonight's install race produced, and
  // adopting the machine side presents an empty app.
  it('declines a never-used machine home when the user home has real data', async () => {
    // Make the user home "established": two gezels and a session.
    await mkdir(join(testHome, 'gezels', 'fenton', 'sessions'), { recursive: true });
    await writeFile(join(testHome, 'gezels', 'fenton', 'sessions', 's1.json'), '{}');
    await mkdir(join(testHome, 'gezels', 'adler'), { recursive: true });

    ctx.systemRuntime = sysRuntime();
    ctx.systemHomeInfo = {
      home: '/var/lib/gezel',
      scope: 'machine',
      version: '1.0.0',
      startedAt: new Date().toISOString(),
      firstRunCompleted: true,
      usage: { gezelCount: 1, projectCount: 1, sessionCount: 0, everUsed: false },
      memory: { totalBytes: 1, freeBytes: 1 },
      engines: [],
    };
    vi.mocked(resolveMode).mockResolvedValue(sysMode());
    const { resolvePerUserMode } = await import('./mode.js');
    vi.mocked(resolvePerUserMode).mockResolvedValue({ kind: 'embedded' });
    ctx.health = () => Promise.resolve({ ok: true, version: '1.0.0' });

    const svc = await connectOrStart(baseOpts({ packaged: true }));

    expect(svc.mode).toBe('embedded');
    expect(svc.fallbackReason).toMatchObject({
      code: 'machine-service-home-fresh',
      sourceMode: 'system-service',
    });
    // The decision must persist so later launches skip the machine wait.
    const config = JSON.parse(await readFile(join(testHome, 'config.json'), 'utf8')) as {
      hosting?: string;
    };
    expect(config.hosting).toBe('per-user');
    await svc.shutdown();
  });

  it('stays on the machine service when BOTH homes have real data', async () => {
    await mkdir(join(testHome, 'gezels', 'fenton', 'sessions'), { recursive: true });
    await writeFile(join(testHome, 'gezels', 'fenton', 'sessions', 's1.json'), '{}');
    await mkdir(join(testHome, 'gezels', 'adler'), { recursive: true });

    ctx.systemRuntime = sysRuntime();
    ctx.systemHomeInfo = {
      home: '/var/lib/gezel',
      scope: 'machine',
      version: '1.0.0',
      startedAt: new Date().toISOString(),
      firstRunCompleted: true,
      usage: { gezelCount: 4, projectCount: 2, sessionCount: 12, everUsed: true },
      memory: { totalBytes: 1, freeBytes: 1 },
      engines: [],
    };
    vi.mocked(resolveMode).mockResolvedValue(sysMode());
    ctx.health = () => Promise.resolve({ ok: true, version: '1.0.0' });

    const svc = await connectOrStart(baseOpts({ packaged: true }));

    expect(svc.mode).toBe('system-service');
    expect(svc.fallbackReason).toBeNull();
    await svc.shutdown();
  });
});

// ── Branch 2: local-adopt ───────────────────────────────────────────

describe('Branch 2 — local-adopt', () => {
  it('returns mode "local-adopt" when health succeeds', async () => {
    vi.mocked(resolveMode).mockResolvedValue({
      kind: 'local-adopt',
      baseUrl: 'https://127.0.0.1:6666',
      token: 'adopt-tok',
      cert: 'CERT',
      pid: 99999,
    });
    ctx.health = () => Promise.resolve({ ok: true, version: '1.0.0' });
    const svc = await connectOrStart(baseOpts());
    expect(svc.mode).toBe('local-adopt');
    expect(svc.baseUrl).toBe('https://127.0.0.1:6666');
    await svc.shutdown();
  });

  it('falls through to embedded when adopted daemon health check fails', async () => {
    vi.mocked(resolveMode).mockResolvedValue({
      kind: 'local-adopt',
      baseUrl: 'https://127.0.0.1:6666',
      token: 'adopt-tok',
      cert: null,
      pid: 99999,
    });
    ctx.health = () => Promise.reject(new Error('connection refused'));
    ctx.processAlive = false;
    const svc = await connectOrStart(baseOpts());
    expect(svc.mode).toBe('embedded');
    expect(svc.fallbackReason).toMatchObject({
      code: 'adopted-daemon-unhealthy',
      sourceMode: 'local-adopt',
    });
    await svc.shutdown();
  });

  // The case that matters most, because it is the common one. Right after an
  // upgrade the adopted daemon is alive but still re-extracting its ~32k-file
  // service bundle, so a single 5s probe fails. Killing it there would throw
  // away a perfectly good daemon mid-boot; a v1.26219.45 Linux upgrade showed
  // the symptom exactly — launch failed immediately after install, then simply
  // worked later once the daemon had finished starting.
  it('waits for an adopted daemon that is still starting instead of giving up', async () => {
    vi.mocked(resolveMode).mockResolvedValue({
      kind: 'local-adopt',
      baseUrl: 'https://127.0.0.1:6666',
      token: 'adopt-tok',
      cert: null,
      pid: 99999,
    });
    let attempts = 0;
    ctx.health = () => {
      attempts += 1;
      return attempts < 3
        ? Promise.reject(new Error('still booting'))
        : Promise.resolve({ ok: true, version: '9.9.9' });
    };
    ctx.processAlive = true;

    const svc = await connectOrStart(baseOpts({ packaged: false, adoptHealthWaitMs: 5_000 }));
    expect(svc.mode).toBe('local-adopt');
    expect(attempts).toBeGreaterThanOrEqual(3);
    await svc.shutdown();
  });

  it('refreshes rotated runtime credentials instead of killing the healthy daemon', async () => {
    vi.mocked(resolveMode).mockResolvedValue({
      kind: 'local-adopt',
      baseUrl: 'https://127.0.0.1:6666',
      token: 'stale-token',
      cert: 'STALE-CERT',
      pid: 99999,
    });
    ctx.runtime = {
      baseUrl: 'https://127.0.0.1:7777',
      port: 7777,
      token: 'fresh-token',
      cert: 'FRESH-CERT',
      pid: 99999,
    };
    ctx.health = (_signal, connection) =>
      connection?.token === 'fresh-token'
        ? Promise.resolve({ ok: true, version: '1.0.0' })
        : Promise.reject(new Error('stale bearer token'));
    ctx.processAlive = true;

    // Even with no remaining wait budget, a newly published runtime
    // generation gets one bounded health probe before any stop is considered.
    const svc = await connectOrStart(baseOpts({ adoptHealthWaitMs: 0 }));

    expect(svc.mode).toBe('local-adopt');
    expect(svc.baseUrl).toBe('https://127.0.0.1:7777');
    expect(svc.token).toBe('fresh-token');
    expect(svc.cert).toBe('FRESH-CERT');
    expect(stopDaemonProcessByPid).not.toHaveBeenCalled();
    await svc.shutdown();
  });

  it('stops a wedged adopted daemon once its start budget expires, then recovers', async () => {
    vi.mocked(resolveMode).mockResolvedValue({
      kind: 'local-adopt',
      baseUrl: 'https://127.0.0.1:6666',
      token: 'adopt-tok',
      cert: null,
      pid: 99999,
    });
    ctx.health = () => Promise.reject(new Error('wedged listener'));
    ctx.processAlive = true;

    // Budget 0: no patience, straight to the give-up path. Previously this
    // threw and left the app with nothing; now the daemon is stopped and the
    // supervisor recovers, matching what the two neighbouring branches do.
    const svc = await connectOrStart(baseOpts({ adoptHealthWaitMs: 0 }));
    expect(svc.mode).toBe('embedded');
    expect(stopDaemonProcessByPid).toHaveBeenCalled();
    await svc.shutdown();
  });

  it('still refuses a second writer if the wedged daemon will not die', async () => {
    vi.mocked(resolveMode).mockResolvedValue({
      kind: 'local-adopt',
      baseUrl: 'https://127.0.0.1:6666',
      token: 'adopt-tok',
      cert: null,
      pid: 99999,
    });
    ctx.health = () => Promise.reject(new Error('wedged listener'));
    ctx.processAlive = true;
    // The real stopProcessByPid delegates to this; make the ladder fail.
    vi.mocked(stopDaemonProcessByPid).mockResolvedValueOnce(false);

    await expect(connectOrStart(baseOpts({ adoptHealthWaitMs: 0 }))).rejects.toThrow(
      /did not exit when asked; refusing to start a second writer/i,
    );
  });

  // In dev mode the version mismatch path is skipped — only the
  // packaged branch enforces version pinning. This test pins that
  // gate so a refactor moving the check outside `if (opts.packaged)`
  // doesn't silently start respawning every adopted dev daemon.
  it('does not enforce version match in dev mode (different version is still adopted)', async () => {
    vi.mocked(resolveMode).mockResolvedValue({
      kind: 'local-adopt',
      baseUrl: 'https://127.0.0.1:6666',
      token: 'adopt-tok',
      cert: null,
      pid: 99999,
    });
    ctx.health = () => Promise.resolve({ ok: true, version: '0.9.0' });
    const svc = await connectOrStart(baseOpts({ packaged: false }));
    expect(svc.mode).toBe('local-adopt');
    await svc.shutdown();
  });
});

// ── Branch 4: local-spawn-packaged ──────────────────────────────────

describe('Branch 4 — local-spawn-packaged', () => {
  it('returns mode "local-spawn-packaged" when spawn succeeds', async () => {
    vi.mocked(resolveMode).mockResolvedValue({ kind: 'local-spawn-packaged' });
    vi.mocked(discoverOrSpawn).mockResolvedValue({
      child: makeFakeChild(),
      baseUrl: 'https://127.0.0.1:7777',
      token: 'spawn-tok',
      cert: null,
      pid: 12345,
    } as unknown as Awaited<ReturnType<typeof discoverOrSpawn>>);
    const svc = await connectOrStart(baseOpts({ packaged: true }));
    expect(svc.mode).toBe('local-spawn-packaged');
    expect(svc.baseUrl).toBe('https://127.0.0.1:7777');
    expect(discoverOrSpawn).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 30_000 }));
    await svc.shutdown();
  });

  it('falls through to embedded when spawn rejects', async () => {
    vi.mocked(resolveMode).mockResolvedValue({ kind: 'local-spawn-packaged' });
    vi.mocked(discoverOrSpawn).mockRejectedValue(new Error('extracted bundle missing'));
    const svc = await connectOrStart(baseOpts({ packaged: true }));
    expect(svc.mode).toBe('embedded');
    expect(svc.fallbackReason).toMatchObject({
      code: 'packaged-spawn-failed',
      sourceMode: 'local-spawn-packaged',
    });
    await svc.shutdown();
  });

  it('falls through to embedded when discoverOrSpawn returns no child', async () => {
    // This shape happens when the discover step adopts an existing
    // daemon instead of spawning. In packaged mode that would skip
    // the version-check logic; we treat it as a spawn failure and
    // fall through.
    vi.mocked(resolveMode).mockResolvedValue({ kind: 'local-spawn-packaged' });
    vi.mocked(discoverOrSpawn).mockResolvedValue({
      child: null,
      baseUrl: 'https://127.0.0.1:7777',
      token: 'spawn-tok',
      cert: null,
      pid: 12345,
    } as unknown as Awaited<ReturnType<typeof discoverOrSpawn>>);
    const svc = await connectOrStart(baseOpts({ packaged: true }));
    expect(svc.mode).toBe('embedded');
    expect(svc.fallbackReason).toMatchObject({ code: 'packaged-spawn-failed' });
    await svc.shutdown();
  });
});

// ── Branch 5: local-spawn-dev ───────────────────────────────────────

describe('Branch 5 — local-spawn-dev', () => {
  it('returns mode "local-spawn-dev" when spawn succeeds', async () => {
    vi.mocked(resolveMode).mockResolvedValue({ kind: 'local-spawn-dev' });
    vi.mocked(discoverOrSpawn).mockResolvedValue({
      child: makeFakeChild(),
      baseUrl: 'https://127.0.0.1:8888',
      token: 'dev-spawn-tok',
      cert: null,
      pid: 67890,
    } as unknown as Awaited<ReturnType<typeof discoverOrSpawn>>);
    const svc = await connectOrStart(baseOpts({ devSpawn: true }));
    expect(svc.mode).toBe('local-spawn-dev');
    expect(discoverOrSpawn).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({ GEZEL_DISABLE_MACHINE_ENGINE: '1' }),
      }),
    );
    await svc.shutdown();
  });

  it('falls through to embedded when dev spawn rejects', async () => {
    vi.mocked(resolveMode).mockResolvedValue({ kind: 'local-spawn-dev' });
    vi.mocked(discoverOrSpawn).mockRejectedValue(new Error('daemon entry missing'));
    const svc = await connectOrStart(baseOpts({ devSpawn: true }));
    expect(svc.mode).toBe('embedded');
    expect(svc.fallbackReason).toMatchObject({
      code: 'dev-spawn-failed',
      sourceMode: 'local-spawn-dev',
    });
    await svc.shutdown();
  });
});

// ── Branch 3: embedded as default ───────────────────────────────────

describe('Branch 3 — embedded', () => {
  it('returns mode "embedded" when resolveMode picks embedded', async () => {
    vi.mocked(resolveMode).mockResolvedValue({ kind: 'embedded' });
    const svc = await connectOrStart(baseOpts({ forceEmbedded: true }));
    expect(svc.mode).toBe('embedded');
    expect(svc.token).toBe('embedded-token');
    expect(svc.cert).toBe('EMBEDDED-CERT-PEM');
    expect(svc.fallbackReason).toBeNull();
    expect(process.env.GEZEL_SHARED_ASSETS_DIR).toBe('/mock/shared-assets');
    expect(process.env.GEZEL_NATIVE_BIN_DIR).toBeUndefined();
    const { startService } = await import('@bendyline/gezel-service');
    expect(startService).toHaveBeenCalledWith(
      expect.objectContaining({ machineEngineDiscovery: false }),
    );
    await svc.shutdown();
  });

  it('uses a native payload that exists in the development checkout', async () => {
    ctx.nativeRoot = join(testHome, 'native-bin');
    ctx.nativeReuse = {
      reused: true,
      nativeBinDir: ctx.nativeRoot,
      reason: 'verified Electron native release test',
    };
    await mkdir(ctx.nativeRoot, { recursive: true });
    vi.mocked(resolveMode).mockResolvedValue({ kind: 'embedded' });

    const svc = await connectOrStart(baseOpts({ forceEmbedded: true }));

    expect(process.env.GEZEL_NATIVE_BIN_DIR).toBe(ctx.nativeRoot);
    const { reuseVerifiedElectronNativeBinaries } = await import('@bendyline/gezel-service');
    expect(reuseVerifiedElectronNativeBinaries).toHaveBeenCalledWith({
      candidates: [ctx.nativeRoot],
      allowStandaloneMacPayload: true,
    });
    await svc.shutdown();
  });

  it('does not expose a development or installed payload rejected by the native pin', async () => {
    ctx.nativeRoot = join(testHome, 'native-bin');
    ctx.nativeReuse = { reused: false, reason: 'sha256 mismatch' };
    await mkdir(ctx.nativeRoot, { recursive: true });
    vi.mocked(resolveMode).mockResolvedValue({ kind: 'embedded' });
    const warnings: string[] = [];

    const svc = await connectOrStart(
      baseOpts({
        forceEmbedded: true,
        logger: { info: () => {}, warn: (message) => void warnings.push(message) },
      }),
    );

    expect(process.env.GEZEL_NATIVE_BIN_DIR).toBeUndefined();
    expect(warnings.some((message) => message.includes('sha256 mismatch'))).toBe(true);
    await svc.shutdown();
  });

  it('reuses a verified installed Electron payload when the development payload is absent', async () => {
    const installedRoot = join(testHome, 'installed-native-bin');
    ctx.installedNativeCandidates = [installedRoot];
    ctx.nativeReuse = {
      reused: true,
      nativeBinDir: installedRoot,
      reason: 'verified Electron native release test',
    };
    await mkdir(installedRoot, { recursive: true });
    vi.mocked(resolveMode).mockResolvedValue({ kind: 'embedded' });

    const svc = await connectOrStart(baseOpts({ forceEmbedded: true }));

    expect(process.env.GEZEL_NATIVE_BIN_DIR).toBe(installedRoot);
    const { reuseVerifiedElectronNativeBinaries } = await import('@bendyline/gezel-service');
    expect(reuseVerifiedElectronNativeBinaries).toHaveBeenCalledWith({
      candidates: [installedRoot],
    });
    await svc.shutdown();
  });

  it('keeps the standalone exception scoped to dev when falling back to an installed app', async () => {
    ctx.nativeRoot = join(testHome, 'native-bin');
    const installedRoot = join(testHome, 'installed-native-bin');
    ctx.installedNativeCandidates = [installedRoot];
    await mkdir(ctx.nativeRoot, { recursive: true });
    await mkdir(installedRoot, { recursive: true });
    vi.mocked(resolveMode).mockResolvedValue({ kind: 'embedded' });
    const { reuseVerifiedElectronNativeBinaries } = await import('@bendyline/gezel-service');
    vi.mocked(reuseVerifiedElectronNativeBinaries)
      .mockResolvedValueOnce({ reused: false, reason: 'dev hash mismatch' })
      .mockImplementationOnce(async () => {
        process.env.GEZEL_NATIVE_BIN_DIR = installedRoot;
        return {
          reused: true,
          nativeBinDir: installedRoot,
          reason: 'verified Electron native release test',
        };
      });

    const svc = await connectOrStart(baseOpts({ forceEmbedded: true }));

    expect(process.env.GEZEL_NATIVE_BIN_DIR).toBe(installedRoot);
    expect(reuseVerifiedElectronNativeBinaries).toHaveBeenNthCalledWith(1, {
      candidates: [ctx.nativeRoot],
      allowStandaloneMacPayload: true,
    });
    expect(reuseVerifiedElectronNativeBinaries).toHaveBeenNthCalledWith(2, {
      candidates: [installedRoot],
    });
    await svc.shutdown();
  });
});

describe('native llama-server selection', () => {
  it('falls back from CUDA to Vulkan and reports the effective backend', async () => {
    ctx.llamaProbe = {
      backend: 'cuda',
      detectedBackend: 'cuda',
      cached: false,
      reason: 'mock CUDA driver',
    };
    ctx.nativeLlamaPaths = {
      vulkan: '/mock/native-bin/linux-x64-vulkan/gezel-llama-server',
      cpu: '/mock/native-bin/linux-x64-cpu/gezel-llama-server',
    };
    vi.mocked(resolveMode).mockResolvedValue({ kind: 'embedded' });

    const svc = await connectOrStart(baseOpts({ forceEmbedded: true }));

    expect(process.env.GEZEL_LLAMA_SERVER_BIN).toBe(
      '/mock/native-bin/linux-x64-vulkan/gezel-llama-server',
    );
    expect(process.env.GEZEL_LLAMA_SERVER_BACKEND).toBe('vulkan');
    expect(process.env.GEZEL_LLAMA_DETECTED_BACKEND).toBe('cuda');
    const llamaVariants = vi
      .mocked(resolveNativeBinaryPath)
      .mock.calls.filter(([name]) => name === 'llama-server')
      .map(([, , variant]) => variant);
    expect(llamaVariants).toEqual(['cuda', 'vulkan']);
    await svc.shutdown();
  });

  it('routes around a bundled CUDA build that crashed on this machine', async () => {
    // Spawn and embedded launches resolve the binary HERE and stamp
    // GEZEL_LLAMA_SERVER_BIN, which makes the daemon's own discovery
    // treat it as pre-set and skip its quarantine check. So this branch
    // has to apply the quarantine itself or those two modes would keep
    // relaunching a build already known to die on startup.
    ctx.llamaProbe = {
      backend: 'cuda',
      detectedBackend: 'cuda',
      cached: false,
      reason: 'mock CUDA driver',
    };
    ctx.nativeLlamaPaths = {
      cuda: '/mock/native-bin/linux-x64-cuda/gezel-llama-server',
      vulkan: '/mock/native-bin/linux-x64-vulkan/gezel-llama-server',
      cpu: '/mock/native-bin/linux-x64-cpu/gezel-llama-server',
    };
    ctx.llamaQuarantine = [
      { backend: 'cuda', signal: 'SIGILL', reason: 'crashed before becoming ready' },
    ];
    const warnings: string[] = [];
    vi.mocked(resolveMode).mockResolvedValue({ kind: 'embedded' });

    const svc = await connectOrStart(
      baseOpts({
        forceEmbedded: true,
        logger: { info: () => {}, warn: (m: string) => void warnings.push(m) },
      }),
    );

    expect(process.env.GEZEL_LLAMA_SERVER_BACKEND).toBe('vulkan');
    // The hardware still has CUDA, so Settings must keep offering it.
    expect(process.env.GEZEL_LLAMA_DETECTED_BACKEND).toBe('cuda');
    expect(warnings.some((w) => w.includes('quarantined') && w.includes('SIGILL'))).toBe(true);
    await svc.shutdown();
  });
});

describe('mode-aware restart', () => {
  it('re-probes remote mode without invoking either local spawner', async () => {
    const health = vi.fn(() => Promise.resolve({ ok: true, version: '1.0.0' }));
    ctx.health = health;
    vi.mocked(resolveMode).mockResolvedValue({
      kind: 'remote',
      baseUrl: 'https://remote.example.test',
      token: 'remote-tok',
      cert: null,
    });
    const svc = await connectOrStart(baseOpts({ packaged: true }));
    vi.mocked(discoverOrSpawn).mockClear();

    await svc.restart('test reconnect');

    expect(health).toHaveBeenCalledTimes(2);
    expect(discoverOrSpawn).not.toHaveBeenCalled();
    expect(svc.mode).toBe('remote');
    await svc.shutdown();
  });

  it('restart in remote mode THROWS when the re-probe fails and does NOT fall back', async () => {
    // The loud-fail contract holds at restart time too: a remote daemon that
    // stopped answering must surface as an error on the existing remote
    // connection, never silently drift into embedded/spawned mode.
    let healthy = true;
    ctx.health = () =>
      healthy
        ? Promise.resolve({ ok: true, version: '1.0.0' })
        : Promise.reject(new Error('connection refused'));
    vi.mocked(resolveMode).mockResolvedValue({
      kind: 'remote',
      baseUrl: 'https://remote.example.test',
      token: 'remote-tok',
      cert: null,
    });
    const svc = await connectOrStart(baseOpts({ packaged: true }));
    vi.mocked(discoverOrSpawn).mockClear();
    healthy = false;

    await expect(svc.restart('reconnect after outage')).rejects.toThrow(/did not respond/i);

    expect(svc.mode).toBe('remote');
    expect(svc.baseUrl).toBe('https://remote.example.test');
    expect(svc.fallbackReason).toBeNull();
    expect(discoverOrSpawn).not.toHaveBeenCalled();
    await svc.shutdown();
  });

  it('re-reads rotated system-service runtime without spawning locally', async () => {
    ctx.systemRuntime = {
      port: 5555,
      baseUrl: 'https://127.0.0.1:5555',
      token: 'old-token',
      cert: 'OLD-CERT',
      home: 'C:/ProgramData/Gezel',
    };
    vi.mocked(resolveMode).mockResolvedValue({
      kind: 'system-service',
      serviceHome: 'C:/ProgramData/Gezel',
      runtime: ctx.systemRuntime,
      waitForStartup: false,
      hostingPin: 'auto',
    });
    const svc = await connectOrStart(baseOpts({ packaged: true }));
    ctx.systemRuntime = {
      port: 6000,
      baseUrl: 'https://127.0.0.1:6000',
      token: 'rotated-token',
      cert: 'ROTATED-CERT',
      home: 'C:/ProgramData/Gezel',
    };
    vi.mocked(discoverOrSpawn).mockClear();

    await svc.restart('reconnect system service');

    expect(svc.baseUrl).toBe('https://127.0.0.1:6000');
    expect(svc.token).toBe('rotated-token');
    expect(svc.cert).toBe('ROTATED-CERT');
    expect(svc.mode).toBe('system-service');
    expect(discoverOrSpawn).not.toHaveBeenCalled();
    await svc.shutdown();
  });

  it('re-reads adopted runtime without spawning locally', async () => {
    vi.mocked(resolveMode).mockResolvedValue({
      kind: 'local-adopt',
      baseUrl: 'https://127.0.0.1:6666',
      token: 'old-token',
      cert: 'OLD-CERT',
      pid: 100,
    });
    const svc = await connectOrStart(baseOpts());
    ctx.runtime = {
      pid: 101,
      port: 7000,
      baseUrl: 'https://127.0.0.1:7000',
      token: 'new-token',
      cert: 'NEW-CERT',
    };
    vi.mocked(discoverOrSpawn).mockClear();

    await svc.restart('reconnect adopted daemon');

    expect(svc.baseUrl).toBe('https://127.0.0.1:7000');
    expect(svc.token).toBe('new-token');
    expect(svc.mode).toBe('local-adopt');
    expect(discoverOrSpawn).not.toHaveBeenCalled();
    await svc.shutdown();
  });

  it('coalesces concurrent restart transitions', async () => {
    let release!: (value: { ok: boolean; version: string }) => void;
    const pending = new Promise<{ ok: boolean; version: string }>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    ctx.health = () => {
      calls += 1;
      return calls === 1 ? Promise.resolve({ ok: true, version: '1.0.0' }) : pending;
    };
    vi.mocked(resolveMode).mockResolvedValue({
      kind: 'remote',
      baseUrl: 'https://remote.example.test',
      token: 'remote-tok',
      cert: null,
    });
    const svc = await connectOrStart(baseOpts());

    const first = svc.restart('first');
    const second = svc.restart('second');
    await vi.waitFor(() => expect(calls).toBe(2));
    expect(calls).toBe(2);
    release({ ok: true, version: '1.0.0' });
    await Promise.all([first, second]);
    expect(calls).toBe(2);
    await svc.shutdown();
  });

  it('serializes crash recovery with a user-requested restart', async () => {
    const svc = new SupervisedService(
      'local-spawn-dev',
      'http://127.0.0.1:1234',
      'token',
      null,
      baseOpts({ devSpawn: true }),
    );
    svc.attachSpawned(makeFakeChild());
    const replacement = makeFakeChild();
    let finishSpawn!: (value: Awaited<ReturnType<typeof discoverOrSpawn>>) => void;
    vi.mocked(discoverOrSpawn).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishSpawn = resolve;
        }),
    );

    const requested = svc.restart('user request');
    const crash = (
      svc as unknown as { handleCrash: (reason: string) => Promise<void> }
    ).handleCrash('concurrent health failure');
    await vi.waitFor(() => expect(discoverOrSpawn).toHaveBeenCalledOnce());
    finishSpawn({
      child: replacement,
      baseUrl: 'http://127.0.0.1:2345',
      token: 'new-token',
      cert: null,
      pid: 2345,
      outcome: 'spawned',
      client: {} as never,
    });
    await Promise.all([requested, crash]);

    expect(discoverOrSpawn).toHaveBeenCalledOnce();
    expect(svc.baseUrl).toBe('http://127.0.0.1:2345');
    await svc.shutdown();
  });

  it('keeps the old packaged daemon live when bundle preparation fails before shutdown', async () => {
    const oldChild = makeFakeChild();
    const svc = new SupervisedService(
      'local-spawn-packaged',
      'https://127.0.0.1:1234',
      'old-token',
      'OLD-CERT',
      baseOpts({ packaged: true }),
    );
    svc.attachSpawned(oldChild);
    vi.mocked(extractBundleIfNeeded).mockRejectedValueOnce(new Error('atomic extraction failed'));

    await expect(svc.restart('apply folder move')).rejects.toThrow('atomic extraction failed');

    expect(svc.state).toBe('ready');
    expect(svc.token).toBe('old-token');
    expect(oldChild.kill).not.toHaveBeenCalled();
    expect(discoverOrSpawn).not.toHaveBeenCalled();
    await svc.shutdown();
  });

  it('retains a spawned daemon whose shutdown rejects but whose old endpoint is still healthy', async () => {
    const oldChild = makeFakeChild();
    const svc = new SupervisedService(
      'local-spawn-dev',
      'https://127.0.0.1:1234',
      'old-token',
      'OLD-CERT',
      baseOpts({ devSpawn: true }),
    );
    svc.attachSpawned(oldChild);
    vi.mocked(stopOwnedDaemon).mockRejectedValueOnce(new Error('shutdown channel failed'));

    await expect(svc.restart('stop failure injection')).rejects.toThrow('shutdown channel failed');

    expect(svc.state).toBe('ready');
    expect(svc.token).toBe('old-token');
    expect(discoverOrSpawn).not.toHaveBeenCalled();
    expect(startService).not.toHaveBeenCalled();
    await svc.shutdown();
  });

  it('recovers an embedded restart through a second verified embedded start', async () => {
    const oldStop = vi.fn().mockResolvedValue(undefined);
    const svc = new SupervisedService(
      'embedded',
      'https://127.0.0.1:1234',
      'old-token',
      'OLD-CERT',
      baseOpts({ forceEmbedded: true }),
    );
    svc.attachEmbedded(oldStop);
    vi.mocked(startService).mockRejectedValueOnce(new Error('first embedded bind failed'));

    await svc.restart('embedded failure injection');

    expect(oldStop).toHaveBeenCalledOnce();
    expect(startService).toHaveBeenCalledTimes(2);
    expect(svc.state).toBe('ready');
    expect(svc.mode).toBe('embedded');
    expect(svc.token).toBe('embedded-token');
    expect(svc.fallbackReason).toMatchObject({
      code: 'restart-failed',
      sourceMode: 'embedded',
    });
    await svc.shutdown();
  });

  it('falls back to verified embedded mode when spawning fails after the old daemon stops', async () => {
    const oldChild = makeFakeChild();
    const svc = new SupervisedService(
      'local-spawn-dev',
      'https://127.0.0.1:1234',
      'old-token',
      'OLD-CERT',
      baseOpts({ devSpawn: true }),
    );
    svc.attachSpawned(oldChild);
    vi.mocked(discoverOrSpawn).mockRejectedValueOnce(new Error('spawn failed after stop'));
    const restarted = vi.fn();
    svc.onRestart(restarted);

    await svc.restart('apply folder move');

    expect(oldChild.kill).toHaveBeenCalled();
    expect(svc.state).toBe('ready');
    expect(svc.mode).toBe('embedded');
    expect(svc.token).toBe('embedded-token');
    expect(svc.cert).toBe('EMBEDDED-CERT-PEM');
    expect(svc.fallbackReason).toMatchObject({
      code: 'restart-failed',
      sourceMode: 'local-spawn-dev',
    });
    expect(restarted).toHaveBeenCalledOnce();
    await svc.shutdown();
  });

  it('falls back when the spawned replacement exhausts its health-wait budget', async () => {
    const svc = new SupervisedService(
      'local-spawn-dev',
      'https://127.0.0.1:1234',
      'old-token',
      null,
      baseOpts({ devSpawn: true }),
    );
    svc.attachSpawned(makeFakeChild());
    vi.mocked(discoverOrSpawn).mockRejectedValueOnce(
      new Error('Timed out after 5000ms waiting for gezeld to start'),
    );

    await svc.restart('health-wait injection');

    expect(svc.mode).toBe('embedded');
    expect(svc.state).toBe('ready');
    expect(svc.fallbackReason?.message).toContain('Timed out after 5000ms');
    await svc.shutdown();
  });

  it('rejects stale rotated credentials before publishing the replacement', async () => {
    const svc = new SupervisedService(
      'local-spawn-dev',
      'https://127.0.0.1:1234',
      'old-token',
      null,
      baseOpts({ devSpawn: true }),
    );
    svc.attachSpawned(makeFakeChild());
    const staleCandidate = makeFakeChild();
    vi.mocked(discoverOrSpawn).mockResolvedValueOnce({
      child: staleCandidate,
      baseUrl: 'https://127.0.0.1:2345',
      token: 'stale-rotated-token',
      cert: 'ROTATED-CERT',
      pid: 2345,
      outcome: 'spawned',
      client: {} as never,
    });
    ctx.health = (_signal, candidate) =>
      candidate?.token === 'stale-rotated-token'
        ? Promise.reject(new Error('401 invalid rotated token'))
        : Promise.resolve({ ok: true, version: '1.0.0' });

    await svc.restart('token-rotation injection');

    expect(staleCandidate.kill).toHaveBeenCalled();
    expect(svc.mode).toBe('embedded');
    expect(svc.state).toBe('ready');
    expect(svc.token).toBe('embedded-token');
    expect(svc.token).not.toBe('stale-rotated-token');
    await svc.shutdown();
  });

  it('enters a tokenless fatal state when replacement and embedded recovery both fail', async () => {
    const svc = new SupervisedService(
      'local-spawn-dev',
      'https://127.0.0.1:1234',
      'old-token',
      'OLD-CERT',
      baseOpts({ devSpawn: true }),
    );
    svc.attachSpawned(makeFakeChild());
    vi.mocked(discoverOrSpawn).mockRejectedValueOnce(new Error('replacement spawn failed'));
    vi.mocked(startService).mockRejectedValueOnce(new Error('embedded bind failed'));
    const fatal = vi.fn();
    svc.onFatal(fatal);

    await expect(svc.restart('fatal injection')).rejects.toThrow(/both failed/i);

    expect(svc.state).toBe('failed');
    expect(svc.token).toBe('');
    expect(svc.cert).toBeNull();
    expect(svc.failure).toMatchObject({
      code: 'restart-unrecoverable',
      sourceMode: 'local-spawn-dev',
    });
    expect(fatal).toHaveBeenCalledOnce();

    const recoveredChild = makeFakeChild();
    vi.mocked(discoverOrSpawn).mockResolvedValueOnce({
      child: recoveredChild,
      baseUrl: 'https://127.0.0.1:3456',
      token: 'retry-token',
      cert: 'RETRY-CERT',
      pid: 3456,
      outcome: 'spawned',
      client: {} as never,
    });
    await svc.restart('retry from persistent error page');
    expect(svc.state).toBe('ready');
    expect(svc.token).toBe('retry-token');
    expect(svc.failure).toBeNull();
    await svc.shutdown();
  });
});

describe('health lifecycle', () => {
  it('persists the health failure cause and endpoint without logging the token', async () => {
    const logger = baseOpts().logger;
    const svc = new SupervisedService(
      'local-spawn-dev',
      'https://127.0.0.1:44481',
      'never-log-this-token',
      'CERT',
      baseOpts({ devSpawn: true, logger }),
    );
    svc.attachSpawned(makeFakeChild());
    ctx.health = () =>
      Promise.reject(
        new TypeError('fetch failed', {
          cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:44481'), {
            code: 'ECONNREFUSED',
          }),
        }),
      );

    await (svc as unknown as { tick: () => Promise<void> }).tick();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(
        /health-check failure 1\/3.*endpoint=https:\/\/127\.0\.0\.1:44481.*ECONNREFUSED/,
      ),
    );
    expect(ctx.logLines.join('\n')).toMatch(/health-check failure 1\/3.*ECONNREFUSED/);
    expect(ctx.logLines.join('\n')).not.toContain('never-log-this-token');
    await svc.shutdown();
  });

  it('carries health, shutdown, reprobe, and child-state evidence into a fatal restart', async () => {
    const svc = new SupervisedService(
      'local-spawn-dev',
      'https://127.0.0.1:44481',
      'token',
      'CERT',
      baseOpts({ devSpawn: true }),
    );
    svc.attachSpawned(makeFakeChild());
    ctx.health = () =>
      Promise.reject(
        new TypeError('fetch failed', {
          cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
        }),
      );
    vi.mocked(stopOwnedDaemon).mockRejectedValueOnce(new Error('shutdown pipe stalled'));
    const internal = svc as unknown as {
      tick: () => Promise<void>;
      consecutiveHealthFailures: number;
    };
    internal.consecutiveHealthFailures = 2;

    await internal.tick();

    expect(svc.state).toBe('failed');
    expect(svc.failure?.message).toContain('stopError=Error: shutdown pipe stalled');
    expect(svc.failure?.message).toContain('reprobeError=TypeError: fetch failed');
    expect(svc.failure?.message).toContain('ECONNRESET');
    expect(svc.failure?.message).toContain('pid=12345');
    expect(svc.failure?.message).toContain('preceding health failure');
    expect(ctx.logLines.join('\n')).toContain('health restart threshold reached');
    expect(ctx.logLines.join('\n')).toContain('fatal restart failure');
    await svc.shutdown();
  });

  it('clears the machine-engine notice after the user daemon reconnects to it', async () => {
    const svc = new SupervisedService(
      'local-spawn-packaged',
      'http://127.0.0.1:1234',
      'token',
      null,
      baseOpts({ packaged: true }),
      {
        fallbackReason: {
          code: 'machine-engine-unavailable',
          sourceMode: 'system-service',
          message: 'engine starting',
        },
      },
    );
    svc.attachSpawned(makeFakeChild());
    ctx.health = () =>
      Promise.resolve({ ok: true, version: '1.0.0', machineEngineConnected: true });
    const reloaded = vi.fn();
    svc.onRestart(reloaded);

    await (svc as unknown as { tick: () => Promise<void> }).tick();

    expect(svc.fallbackReason).toBeNull();
    expect(reloaded).toHaveBeenCalledOnce();
    await svc.shutdown();
  });

  it('bounds a health implementation that ignores AbortSignal', async () => {
    vi.useFakeTimers();
    try {
      const never = new Promise<{
        ok: true;
        startedAt: string;
        version: string;
      }>(() => {});
      const result = healthWithTimeout({ health: () => never }, 50);
      const assertion = expect(result).rejects.toThrow(/timed out after 50ms/i);
      await vi.advanceTimersByTimeAsync(50);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps only one probe in flight and ignores an aborted old generation', async () => {
    const child = makeFakeChild();
    const svc = new SupervisedService(
      'local-spawn-dev',
      'http://127.0.0.1:1234',
      'token',
      null,
      baseOpts({ devSpawn: true }),
    );
    svc.attachSpawned(child);
    let calls = 0;
    ctx.health = () => {
      calls += 1;
      return new Promise(() => {});
    };
    const internal = svc as unknown as {
      tick: () => Promise<void>;
      consecutiveHealthFailures: number;
    };
    internal.consecutiveHealthFailures = 2;

    const first = internal.tick();
    const duplicate = internal.tick();
    await vi.waitFor(() => expect(calls).toBe(1));
    svc.attachSpawned(makeFakeChild());
    await Promise.all([first, duplicate]);

    expect(calls).toBe(1);
    expect(internal.consecutiveHealthFailures).toBe(0);
    expect(discoverOrSpawn).not.toHaveBeenCalled();
    await svc.shutdown();
  });
});

describe('graceful child shutdown', () => {
  it('delegates owned-child shutdown to the shared stdin/tree lifecycle helper', async () => {
    const child = makeFakeChild();
    const logger = baseOpts().logger;

    await gracefullyStop(child, logger);

    expect(stopOwnedDaemon).toHaveBeenCalledWith(child, logger, {
      graceMs: 3_000,
      forceMs: 3_000,
    });
  });

  it('delegates adopted-pid shutdown to the shared cross-platform helper', async () => {
    const logger = baseOpts().logger;
    const isAlive = () => true;
    const signalProcess = vi.fn();

    await expect(
      stopProcessByPid(1234, logger, {
        graceMs: 100,
        pollIntervalMs: 10,
        platform: 'linux',
        isAlive,
        signalProcess,
      }),
    ).resolves.toBe(true);

    expect(stopDaemonProcessByPid).toHaveBeenCalledWith(1234, {
      graceMs: 100,
      pollIntervalMs: 10,
      platform: 'linux',
      isAlive,
      signalProcess,
      terminateWindowsTree: undefined,
      logger,
    });
  });

  it('refuses replacement when an adopted stale pid survives escalation', async () => {
    vi.mocked(stopDaemonProcessByPid).mockResolvedValueOnce(false);
    await expect(
      stopProcessByPid(1234, baseOpts().logger, {
        platform: 'linux',
        isAlive: () => true,
      }),
    ).resolves.toBe(false);
  });

  it('force-stops an adopted stale Windows daemon as a complete process tree', async () => {
    const isAlive = () => true;
    const signalProcess = vi.fn();
    const terminateWindowsTree = vi.fn(async () => {});

    await expect(
      stopProcessByPid(1234, baseOpts().logger, {
        platform: 'win32',
        graceMs: 100,
        pollIntervalMs: 10,
        isAlive,
        signalProcess,
        terminateWindowsTree,
      }),
    ).resolves.toBe(true);

    expect(stopDaemonProcessByPid).toHaveBeenCalledWith(
      1234,
      expect.objectContaining({
        platform: 'win32',
        isAlive,
        signalProcess,
        terminateWindowsTree,
      }),
    );
  });
});

/**
 * Store-connect orchestration.
 *
 * The invariant under test is the one the whole store ladder exists for: a
 * store build may adopt the daemon a direct-download install is running, but
 * must never manage it. It did not spawn that process, cannot signal it under
 * the macOS sandbox, and the other install's lifecycle is not its to schedule.
 */
describe('store-connect', () => {
  const storeMode = {
    kind: 'store-connect' as const,
    baseUrl: 'https://127.0.0.1:6228',
    token: 'store-tok',
    cert: null,
    source: 'app-group-mirror' as const,
  };

  const healthy = (over: Record<string, unknown> = {}) => ({
    ok: true,
    version: '1.26240.3',
    apiCompat: { floor: 1, current: 1 },
    ...over,
  });

  it('adopts a compatible daemon without spawning or stopping anything', async () => {
    vi.mocked(resolveMode).mockResolvedValue(storeMode);
    ctx.health = () => Promise.resolve(healthy());

    const svc = await connectOrStart(baseOpts({ storeProfile: true }));

    expect(svc.mode).toBe('store-connect');
    expect(svc.baseUrl).toBe('https://127.0.0.1:6228');
    // The three things a store build must never do to another install.
    expect(startService).not.toHaveBeenCalled();
    expect(discoverOrSpawn).not.toHaveBeenCalled();
    expect(stopDaemonProcessByPid).not.toHaveBeenCalled();
    await svc.shutdown();
  });

  it('adopts across a version difference, which is the normal case', async () => {
    // The channels ship on different schedules. Judging on version equality
    // would send every store user to a private daemon on the first patch
    // either side released.
    vi.mocked(resolveMode).mockResolvedValue(storeMode);
    ctx.health = () => Promise.resolve(healthy({ version: '1.99999.1' }));

    const svc = await connectOrStart(baseOpts({ storeProfile: true }));
    expect(svc.mode).toBe('store-connect');
    await svc.shutdown();
  });

  it('starts its own service when the installed one does not answer', async () => {
    vi.mocked(resolveMode).mockResolvedValue(storeMode);
    ctx.health = () => Promise.reject(new Error('connection refused'));

    const svc = await connectOrStart(baseOpts({ storeProfile: true }));

    expect(svc.mode).toBe('embedded');
    expect(startService).toHaveBeenCalled();
    // Rendezvous files outlive the daemon that wrote them; they belong to the
    // other install and must be left exactly as found.
    expect(stopDaemonProcessByPid).not.toHaveBeenCalled();
    expect(svc.fallbackReason?.code).toBe('store-service-unhealthy');
    await svc.shutdown();
  });

  it('starts its own service when the installed one speaks another generation', async () => {
    vi.mocked(resolveMode).mockResolvedValue(storeMode);
    ctx.health = () => Promise.resolve(healthy({ apiCompat: { floor: 7, current: 9 } }));

    const svc = await connectOrStart(baseOpts({ storeProfile: true }));

    expect(svc.mode).toBe('embedded');
    expect(svc.fallbackReason?.code).toBe('store-service-incompatible');
    // The reason has to name something the user can act on, not an opcode.
    expect(svc.fallbackReason?.message).toMatch(/generation/i);
    await svc.shutdown();
  });

  it('declines a daemon that predates the handshake', async () => {
    // Absence is a verdict, not silence: no apiCompat means older than any
    // generation this build knows how to negotiate with.
    vi.mocked(resolveMode).mockResolvedValue(storeMode);
    ctx.health = () => Promise.resolve({ ok: true, version: '1.26100.1' });

    const svc = await connectOrStart(baseOpts({ storeProfile: true }));

    expect(svc.mode).toBe('embedded');
    expect(svc.fallbackReason?.code).toBe('store-service-incompatible');
    await svc.shutdown();
  });

  it('declines the machine-engine broker, which serves no product API', async () => {
    vi.mocked(resolveMode).mockResolvedValue(storeMode);
    ctx.health = () => Promise.resolve(healthy({ serviceRole: 'machine-engine' }));

    const svc = await connectOrStart(baseOpts({ storeProfile: true }));

    expect(svc.mode).toBe('embedded');
    expect(svc.fallbackReason?.code).toBe('store-service-incompatible');
    await svc.shutdown();
  });
});
