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
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Hoisted mock context so vi.mock factories can read state set per-test.
// vi.mock is hoisted above imports, so the factories reference these
// fields via closure; each `beforeEach` resets them.
const ctx = vi.hoisted(() => ({
  health: undefined as
    | undefined
    | ((signal?: AbortSignal) => Promise<{ ok: boolean; version: string }>),
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
  },
  processAlive: true,
}));

vi.mock('./extract-pnpm.js', () => ({
  defaultPnpmBundleDir: () => '/fake/pnpm-bundle',
  installPnpmIfNeeded: vi.fn().mockResolvedValue({ entryPath: null }),
}));
vi.mock('./extract-node.js', () => ({
  defaultNodeBundleDir: () => '/fake/node-bundle',
  installNodeIfNeeded: vi.fn().mockResolvedValue({ binaryPath: null }),
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
  resolveNativeBinaryPath: () => null,
  nativeBinDir: () => '/mock/native-bin',
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
  detectLlamaBackend: () => ({
    backend: 'cpu',
    detectedBackend: 'cpu',
    cached: false,
    reason: 'mock',
  }),
}));
vi.mock('./mode.js', () => ({ resolveMode: vi.fn() }));
vi.mock('./system-service.js', () => ({
  readSystemServiceRuntime: vi.fn(() => Promise.resolve(ctx.systemRuntime)),
}));
vi.mock('./log-rotator.js', () => ({
  LogRotator: class {
    write = vi.fn().mockResolvedValue(undefined);
    close = vi.fn().mockResolvedValue(undefined);
  },
}));
vi.mock('@bendyline/gezel-client/node', () => ({
  GezelClient: class MockGezelClient {
    health(signal?: AbortSignal) {
      if (!ctx.health) throw new Error('test forgot to set ctx.health');
      return ctx.health(signal);
    }
  },
  createTrustingFetch: () => fetch,
  discoverOrSpawn: vi.fn(),
  readRuntime: vi.fn(() => Promise.resolve(ctx.runtime)),
  isProcessAlive: vi.fn(() => ctx.processAlive),
  resolveDaemonEntry: () => '/fake/daemon-entry.js',
}));
vi.mock('@bendyline/gezel-service', () => ({
  startService: vi.fn().mockResolvedValue({
    port: 11111,
    context: { token: 'embedded-token' },
    cert: { certPem: 'EMBEDDED-CERT-PEM' },
    stop: vi.fn().mockResolvedValue(undefined),
  }),
}));

// Imports must come after vi.mock so they pick up the mocked versions.
const { SupervisedService, connectOrStart, gracefullyStop, healthWithTimeout, stopProcessByPid } =
  await import('./index.js');
const { resolveMode } = await import('./mode.js');
const { discoverOrSpawn } = await import('@bendyline/gezel-client/node');
const { readBundleMeta } = await import('./extract-bundle.js');

// Env keys the supervisor's prelude mutates. We snapshot at the start
// of each test and restore at the end so test order doesn't leak.
const ENV_KEYS = [
  'GEZEL_PNPM_PATH',
  'GEZEL_NODE_PATH',
  'GEZEL_SD_SERVER_BIN',
  'GEZEL_LLAMA_SERVER_BIN',
  'GEZEL_LLAMA_DETECTED_BACKEND',
  'GEZEL_LLAMA_DETECTED_VENDOR',
  'GEZEL_LLAMA_SERVER_BACKEND',
  'GEZEL_WHISPER_SERVER_BIN',
  'GEZEL_UV_BIN',
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
  ctx.processAlive = true;
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
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: null;
    killed: boolean;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    kill: (sig?: NodeJS.Signals) => boolean;
  };
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

describe('Branch 1.5 — system-service', () => {
  it('returns mode "system-service" when health succeeds', async () => {
    vi.mocked(resolveMode).mockResolvedValue({
      kind: 'system-service',
      baseUrl: 'https://127.0.0.1:5555',
      token: 'svc-tok',
      cert: 'CERT',
      serviceHome: '/var/lib/gezel',
    });
    ctx.health = () => Promise.resolve({ ok: true, version: '1.0.0' });
    const svc = await connectOrStart(baseOpts({ packaged: true }));
    expect(svc.mode).toBe('system-service');
    await svc.shutdown();
  });

  it('falls through to embedded when system-service health check fails', async () => {
    vi.mocked(resolveMode).mockResolvedValue({
      kind: 'system-service',
      baseUrl: 'https://127.0.0.1:5555',
      token: 'svc-tok',
      cert: null,
      serviceHome: '/var/lib/gezel',
    });
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

  // The machine service's gezeld tree is written only by the platform
  // installer, so an app-only update (macOS ZIP via Squirrel) leaves it on
  // the previous release. We cannot stop or replace it, and falling back to
  // embedded would point the user at a different GEZEL_HOME — so we stay
  // connected and raise a banner instead.
  it('flags a version mismatch but stays connected to the system service', async () => {
    vi.mocked(resolveMode).mockResolvedValue({
      kind: 'system-service',
      baseUrl: 'https://127.0.0.1:5555',
      token: 'svc-tok',
      cert: 'CERT',
      serviceHome: '/Library/Application Support/Gezel',
    });
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
    vi.mocked(resolveMode).mockResolvedValue({
      kind: 'system-service',
      baseUrl: 'https://127.0.0.1:5555',
      token: 'svc-tok',
      cert: 'CERT',
      serviceHome: '/var/lib/gezel',
    });
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
    vi.mocked(resolveMode).mockResolvedValue({
      kind: 'system-service',
      baseUrl: 'https://127.0.0.1:5555',
      token: 'svc-tok',
      cert: null,
      serviceHome: '/var/lib/gezel',
    });
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
    vi.mocked(resolveMode).mockResolvedValue({
      kind: 'system-service',
      baseUrl: 'https://127.0.0.1:5555',
      token: 'svc-tok',
      cert: 'CERT',
      serviceHome: '/Library/Application Support/Gezel',
    });
    vi.mocked(readBundleMeta).mockResolvedValue(bundleMeta('1.26211.23'));
    ctx.health = () => Promise.resolve({ ok: true, version: '1.26210.19' });
    const svc = await connectOrStart(baseOpts({ packaged: true }));
    expect(svc.fallbackReason?.code).toBe('system-service-version-mismatch');

    ctx.systemRuntime = {
      port: 5555,
      baseUrl: 'https://127.0.0.1:5555',
      token: 'svc-tok',
      cert: 'CERT',
      home: '/Library/Application Support/Gezel',
    };
    ctx.health = () => Promise.resolve({ ok: true, version: '1.26211.23' });

    await svc.restart('after reinstall');

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

  it('refuses embedded fallback while an unhealthy adopted pid is still alive', async () => {
    vi.mocked(resolveMode).mockResolvedValue({
      kind: 'local-adopt',
      baseUrl: 'https://127.0.0.1:6666',
      token: 'adopt-tok',
      cert: null,
      pid: 99999,
    });
    ctx.health = () => Promise.reject(new Error('wedged listener'));
    ctx.processAlive = true;

    await expect(connectOrStart(baseOpts())).rejects.toThrow(
      /refusing to start an embedded writer/i,
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

  it('re-reads rotated system-service runtime without spawning locally', async () => {
    vi.mocked(resolveMode).mockResolvedValue({
      kind: 'system-service',
      baseUrl: 'https://127.0.0.1:5555',
      token: 'old-token',
      cert: 'OLD-CERT',
      serviceHome: 'C:/ProgramData/Gezel',
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
});

describe('health lifecycle', () => {
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
  it('escalates to SIGKILL when SIGTERM was delivered but the child did not exit', async () => {
    vi.useFakeTimers();
    try {
      const child = new EventEmitter() as EventEmitter & {
        killed: boolean;
        exitCode: number | null;
        signalCode: NodeJS.Signals | null;
        kill: ReturnType<typeof vi.fn>;
      };
      // Start true to prove this is not a valid process-exit predicate.
      child.killed = true;
      child.exitCode = null;
      child.signalCode = null;
      child.kill = vi.fn((signal: NodeJS.Signals = 'SIGTERM') => {
        if (signal === 'SIGKILL') {
          child.signalCode = signal;
          queueMicrotask(() => child.emit('exit', null, signal));
        }
        return true;
      });

      const stopping = gracefullyStop(child as unknown as ChildProcess, baseOpts().logger);
      await vi.advanceTimersByTimeAsync(3_000);
      await stopping;

      expect(child.kill).toHaveBeenNthCalledWith(1, 'SIGTERM');
      expect(child.kill).toHaveBeenNthCalledWith(2, 'SIGKILL');
    } finally {
      vi.useRealTimers();
    }
  });

  it('confirms an adopted stale pid exited and escalates before allowing replacement', async () => {
    vi.useFakeTimers();
    try {
      let alive = true;
      const signals: NodeJS.Signals[] = [];
      const stopping = stopProcessByPid(1234, baseOpts().logger, {
        graceMs: 100,
        pollIntervalMs: 10,
        isAlive: () => alive,
        signalProcess: (_pid, signal) => {
          signals.push(signal);
          if (signal === 'SIGKILL') alive = false;
        },
      });

      await vi.advanceTimersByTimeAsync(100);
      await expect(stopping).resolves.toBe(true);
      expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses replacement when an adopted stale pid survives escalation', async () => {
    vi.useFakeTimers();
    try {
      const signals: NodeJS.Signals[] = [];
      const stopping = stopProcessByPid(1234, baseOpts().logger, {
        graceMs: 100,
        pollIntervalMs: 10,
        isAlive: () => true,
        signalProcess: (_pid, signal) => signals.push(signal),
      });

      await vi.advanceTimersByTimeAsync(200);
      await expect(stopping).resolves.toBe(false);
      expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
    } finally {
      vi.useRealTimers();
    }
  });
});
