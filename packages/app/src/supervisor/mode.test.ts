/**
 * Branch 1.5 decision table: the SCM query decides whether the supervisor
 * waits for, connects to, or ignores the machine service. The install-race
 * regression this guards: runtime files absent while the service is
 * START_PENDING used to silently fall through to a per-user spawn, leaving
 * two daemons on two homes racing for the GPU.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ctx = vi.hoisted(() => ({
  sysHome: '/var/lib/gezel' as string | null,
  runtime: null as null | {
    port: number;
    baseUrl: string;
    token: string;
    cert: string | null;
    home: string;
    serviceRole?: 'user' | 'machine-engine' | 'legacy-full';
  },
  scm: { status: 'not-installed' } as { status: string; detail?: string },
  localRuntime: null as null | {
    pid: number;
    port: number;
    baseUrl: string;
    token: string;
    cert: string | null;
  },
}));

vi.mock('./system-service.js', () => ({
  systemServiceHome: vi.fn(() => ctx.sysHome),
  readSystemServiceRuntime: vi.fn(() => Promise.resolve(ctx.runtime)),
}));
vi.mock('./service-registration.js', () => ({
  queryMachineServiceState: vi.fn(() => Promise.resolve(ctx.scm)),
}));
vi.mock('@bendyline/gezel-client/node', () => ({
  readRuntime: vi.fn(() => Promise.resolve(ctx.localRuntime)),
  isProcessAlive: vi.fn(() => true),
}));

const { resolveMode } = await import('./mode.js');

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-mode-'));
  ctx.sysHome = '/var/lib/gezel';
  ctx.runtime = null;
  ctx.scm = { status: 'not-installed' };
  ctx.localRuntime = null;
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  vi.clearAllMocks();
});

function opts(overrides: Partial<Parameters<typeof resolveMode>[0]> = {}) {
  return {
    home,
    packaged: true,
    devSpawn: false,
    forceEmbedded: false,
    ...overrides,
  };
}

const runtime = (serviceRole?: 'user' | 'machine-engine' | 'legacy-full') => ({
  port: 6228,
  baseUrl: 'https://127.0.0.1:6228',
  token: 'tok',
  cert: 'CERT',
  home: '/var/lib/gezel',
  ...(serviceRole ? { serviceRole } : {}),
});

describe('resolveMode — machine-service decision table', () => {
  it('resolves remote mode from a real config.json service entry, with no cert pin', async () => {
    // Branch 1 outranks the machine service. `cert: null` is deliberate —
    // remote daemons bring their own TLS chain; we never pin a cert for a
    // URL we didn't generate.
    await writeFile(
      join(home, 'config.json'),
      JSON.stringify({ service: { url: 'https://remote.example:6228/', token: 'remote-tok' } }),
    );
    ctx.scm = { status: 'running' };
    ctx.runtime = runtime('machine-engine');
    const mode = await resolveMode(opts());
    expect(mode).toEqual({
      kind: 'remote',
      baseUrl: 'https://remote.example:6228',
      token: 'remote-tok',
      cert: null,
    });
  });

  it('waits for a START_PENDING service even when runtime files are absent', async () => {
    // The install race: service enabled seconds ago, files not yet written.
    ctx.scm = { status: 'start-pending' };
    ctx.runtime = null;
    const mode = await resolveMode(opts());
    expect(mode).toMatchObject({
      kind: 'system-service',
      waitForStartup: true,
      runtime: null,
    });
  });

  it('connects (with wait budget) to a RUNNING service', async () => {
    ctx.scm = { status: 'running' };
    ctx.runtime = runtime();
    const mode = await resolveMode(opts());
    expect(mode).toMatchObject({ kind: 'system-service', waitForStartup: true });
  });

  it('ignores stale runtime files when the service is STOPPED', async () => {
    ctx.scm = { status: 'stopped' };
    ctx.runtime = runtime();
    const mode = await resolveMode(opts());
    // Falls through to per-user; packaged with no adoptable daemon → spawn.
    expect(mode.kind).toBe('local-spawn-packaged');
  });

  it('ignores stale runtime files when no service is registered', async () => {
    ctx.scm = { status: 'not-installed' };
    ctx.runtime = runtime();
    const mode = await resolveMode(opts());
    expect(mode.kind).toBe('local-spawn-packaged');
  });

  it('keeps legacy file-only behavior when the SCM is unqueryable', async () => {
    ctx.scm = { status: 'unknown', detail: 'sc.exe failed' };
    ctx.runtime = runtime();
    const mode = await resolveMode(opts());
    // Files present + unknown SCM → connect without a startup wait.
    expect(mode).toMatchObject({ kind: 'system-service', waitForStartup: false });
  });

  it('falls through when the SCM is unqueryable and no files exist', async () => {
    ctx.scm = { status: 'unknown' };
    ctx.runtime = null;
    const mode = await resolveMode(opts());
    expect(mode.kind).toBe('local-spawn-packaged');
  });

  it('honors a per-user hosting pin for a legacy full-product daemon', async () => {
    const { queryMachineServiceState } = await import('./service-registration.js');
    await writeFile(join(home, 'config.json'), JSON.stringify({ hosting: 'per-user' }));
    ctx.scm = { status: 'running' };
    ctx.runtime = runtime();
    const mode = await resolveMode(opts());
    expect(mode.kind).toBe('local-spawn-packaged');
    expect(vi.mocked(queryMachineServiceState)).toHaveBeenCalledOnce();
  });

  it('does not let a legacy per-user pin disable the split machine engine', async () => {
    await writeFile(join(home, 'config.json'), JSON.stringify({ hosting: 'per-user' }));
    ctx.scm = { status: 'running' };
    ctx.runtime = runtime('machine-engine');
    const mode = await resolveMode(opts());
    expect(mode).toMatchObject({
      kind: 'system-service',
      hostingPin: 'per-user',
      waitForStartup: true,
    });
  });

  it('waits to learn the service role when a per-user pin meets a cold machine start', async () => {
    await writeFile(join(home, 'config.json'), JSON.stringify({ hosting: 'per-user' }));
    ctx.scm = { status: 'start-pending' };
    ctx.runtime = null;
    const mode = await resolveMode(opts());
    expect(mode).toMatchObject({
      kind: 'system-service',
      hostingPin: 'per-user',
      waitForStartup: true,
      runtime: null,
    });
  });

  it('carries a machine-service pin into the mode for the preference check', async () => {
    await writeFile(join(home, 'config.json'), JSON.stringify({ hosting: 'machine-service' }));
    ctx.scm = { status: 'running' };
    ctx.runtime = runtime();
    const mode = await resolveMode(opts());
    expect(mode).toMatchObject({ kind: 'system-service', hostingPin: 'machine-service' });
  });

  it('never consults the machine service outside packaged mode', async () => {
    const { queryMachineServiceState } = await import('./service-registration.js');
    ctx.scm = { status: 'running' };
    ctx.runtime = runtime();
    const mode = await resolveMode(opts({ packaged: false }));
    expect(mode.kind).toBe('embedded');
    expect(vi.mocked(queryMachineServiceState)).not.toHaveBeenCalled();
  });

  it('prefers an adoptable local daemon over spawn after a stale-file skip', async () => {
    ctx.scm = { status: 'stopped' };
    ctx.runtime = runtime();
    ctx.localRuntime = {
      pid: 4242,
      port: 7777,
      baseUrl: 'https://127.0.0.1:7777',
      token: 'local-tok',
      cert: null,
    };
    const mode = await resolveMode(opts());
    expect(mode).toMatchObject({ kind: 'local-adopt', pid: 4242 });
  });
});

describe('resolveMode — the store ladder', () => {
  const rendezvous = {
    baseUrl: 'https://127.0.0.1:6228',
    token: 'store-tok',
    cert: 'CERT',
    source: 'app-group-mirror' as const,
  };

  it('adopts a direct install rather than starting a second service', async () => {
    const mode = await resolveMode(
      opts({ storeProfile: true, findRendezvous: () => Promise.resolve(rendezvous) }),
    );
    expect(mode).toMatchObject({ kind: 'store-connect', token: 'store-tok', cert: 'CERT' });
  });

  it('runs its own service, silently, when no direct install is present', async () => {
    // The ordinary case on a machine with only the store build. Nothing is
    // degraded, so there is no notice — and no spawn branch either.
    const mode = await resolveMode(
      opts({ storeProfile: true, findRendezvous: () => Promise.resolve(null) }),
    );
    expect(mode).toEqual({ kind: 'embedded' });
  });

  it('never reaches local-adopt, which would SIGTERM the other product', async () => {
    // The regression this guards is the whole reason the store ladder is a
    // divert rather than a branch: local-adopt stops a version-mismatched
    // daemon and respawns it. Against a direct-download install that is one
    // product killing another's service — and under the macOS sandbox the
    // signal would not even be permitted.
    ctx.localRuntime = {
      pid: 4242,
      port: 6228,
      baseUrl: 'http://127.0.0.1:6228',
      token: 't',
      cert: null,
    };
    const mode = await resolveMode(
      opts({ storeProfile: true, findRendezvous: () => Promise.resolve(null) }),
    );
    expect(mode.kind).toBe('embedded');
  });

  it('never reaches the machine-service branch, which waits on a service it does not own', async () => {
    ctx.scm = { status: 'running' };
    ctx.runtime = runtime('legacy-full');
    const mode = await resolveMode(
      opts({ storeProfile: true, findRendezvous: () => Promise.resolve(null) }),
    );
    expect(mode.kind).toBe('embedded');
  });

  it('never reaches a spawn branch', async () => {
    const mode = await resolveMode(
      opts({
        storeProfile: true,
        packaged: true,
        devSpawn: true,
        findRendezvous: () => Promise.resolve(null),
      }),
    );
    expect(mode.kind).toBe('embedded');
  });

  it('still honors an explicitly configured remote, which the user named by hand', async () => {
    await writeFile(
      join(home, 'config.json'),
      JSON.stringify({ service: { url: 'https://remote.example:6228', token: 'remote-tok' } }),
    );
    const mode = await resolveMode(
      opts({ storeProfile: true, findRendezvous: () => Promise.resolve(rendezvous) }),
    );
    expect(mode.kind).toBe('remote');
  });

  it('still honors forced embedded', async () => {
    const mode = await resolveMode(
      opts({
        storeProfile: true,
        forceEmbedded: true,
        findRendezvous: () => Promise.resolve(rendezvous),
      }),
    );
    expect(mode.kind).toBe('embedded');
  });

  it('leaves the direct-download ladder untouched when the profile is off', async () => {
    ctx.localRuntime = {
      pid: 4242,
      port: 6228,
      baseUrl: 'http://127.0.0.1:6228',
      token: 't',
      cert: null,
    };
    const mode = await resolveMode(opts({ findRendezvous: () => Promise.resolve(rendezvous) }));
    expect(mode.kind).toBe('local-adopt');
  });
});
