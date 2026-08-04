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

const runtime = () => ({
  port: 6228,
  baseUrl: 'https://127.0.0.1:6228',
  token: 'tok',
  cert: 'CERT',
  home: '/var/lib/gezel',
});

describe('resolveMode — machine-service decision table', () => {
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

  it('honors a per-user hosting pin without touching the SCM', async () => {
    const { queryMachineServiceState } = await import('./service-registration.js');
    await writeFile(join(home, 'config.json'), JSON.stringify({ hosting: 'per-user' }));
    ctx.scm = { status: 'running' };
    ctx.runtime = runtime();
    const mode = await resolveMode(opts());
    expect(mode.kind).toBe('local-spawn-packaged');
    expect(vi.mocked(queryMachineServiceState)).not.toHaveBeenCalled();
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
