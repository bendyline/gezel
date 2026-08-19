/**
 * End-to-end integration: spawn `gezeld` as a real child process and drive
 * it with the real `GezelClient` over HTTP. Unlike the service package's
 * `integration.test.ts` (which boots `startService()` in the same Node
 * process as the test runner), this suite exercises the full cross-process
 * path — token file handshake, runtime-files discovery, HTTP transport,
 * auth middleware. If the Electron supervisor's spawn flow ever regresses
 * in a way the in-process tests miss, it'll surface here first.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  type DiscoverOrSpawnResult,
  GezelClient,
  createTrustingFetch,
  discoverOrSpawn,
  isProcessAlive,
  readRuntime,
  resolveDaemonEntry,
  stopOwnedDaemon,
  stopProcessByPid,
} from '@bendyline/gezel-client/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectForTui } from './connection.js';

let gezelHome: string;
let spawned: DiscoverOrSpawnResult;
let client: GezelClient;
const execFileAsync = promisify(execFile);
const cliEntry = fileURLToPath(new URL('../dist/bin/gezel.js', import.meta.url));

async function runCli(...args: string[]): Promise<{ stdout: string; stderr: string }> {
  return runCliAtHome(gezelHome, ...args);
}

async function runCliAtHome(
  home: string,
  ...args: string[]
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(process.execPath, [cliEntry, '--home', home, ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      GEZEL_HOME: home,
      GEZEL_MOCK_PROVIDER: '1',
    },
    // connectOwned gives a cold daemon up to 20s to start. Keep the outer
    // process budget larger than that contract so execFile cannot kill the
    // CLI before it can report its own success or startup failure.
    timeout: 25_000,
  });
}

beforeAll(async () => {
  gezelHome = await mkdtemp(join(tmpdir(), 'gezel-daemon-integ-'));
  const daemonEntry = resolveDaemonEntry(import.meta.url);
  spawned = await discoverOrSpawn({
    daemonEntry,
    detached: false,
    stdio: 'pipe',
    home: gezelHome,
    env: {
      ...process.env,
      GEZEL_HOME: gezelHome,
      // Skip the heavy LLM provider boot — mock is deterministic and has
      // no network dependency, which keeps this test CI-friendly.
      GEZEL_MOCK_PROVIDER: '1',
      // Force an ephemeral port. Without GEZEL_PORT the daemon now claims
      // the canonical fixed port (6228); pinning to 0 keeps this
      // cross-process test hermetic and off the shared port so it can't
      // race a real local daemon or another spawning suite.
      GEZEL_PORT: '0',
      GEZEL_SERVICE_ROLE: 'user',
    },
    timeoutMs: 15_000,
  });
  client = spawned.client;
}, 20_000);

afterAll(async () => {
  await stopOwnedDaemon(spawned?.child);
  if (gezelHome) await rm(gezelHome, { recursive: true, force: true });
});

// Every case here crosses a process boundary, and the CLI-entry cases shell
// out twice with a 25s `execFile` budget each — more than vitest's 5s default
// allows, so a loaded runner timed the suite out rather than failing an
// assertion. Match the budget to the work the tests actually do.
describe('gezeld cross-process integration', { timeout: 30_000 }, () => {
  it('writes runtime files that readRuntime can parse', async () => {
    const runtime = await readRuntime(gezelHome);
    expect(runtime).not.toBeNull();
    expect(runtime?.pid).toBe(spawned.pid);
    expect(runtime?.token).toBe(spawned.token);
    expect(runtime?.baseUrl).toBe(spawned.baseUrl);
  });

  it('serves /api/health with a version', async () => {
    const health = await client.health();
    expect(health.ok).toBe(true);
    expect(typeof health.version).toBe('string');
  });

  it('rejects requests with no auth token', async () => {
    // Daemon serves HTTPS with a self-signed loopback cert; use the
    // trusting fetch built from the cert that `discoverOrSpawn` read
    // off disk so this test exercises the auth gate, not the TLS gate.
    const probeFetch = spawned.cert ? createTrustingFetch({ cert: spawned.cert }) : fetch;
    const res = await probeFetch(`${spawned.baseUrl}/api/gezels`);
    expect(res.status).toBe(401);
  });

  it('accepts requests with the runtime-file token', async () => {
    const runtime = await readRuntime(gezelHome);
    expect(runtime).not.toBeNull();
    // Build a fresh client from the disk-read token — this is the exact
    // flow the Electron supervisor's `local-adopt` branch performs.
    const adopter = new GezelClient({
      baseUrl: runtime!.baseUrl,
      token: runtime!.token,
      ...(runtime!.cert ? { fetch: createTrustingFetch({ cert: runtime!.cert }) } : {}),
    });
    const health = await adopter.health();
    expect(health.ok).toBe(true);
    const gezels = await adopter.listGezels();
    // The service auto-creates a Meester on first boot.
    expect(Array.isArray(gezels.gezels)).toBe(true);
    expect(gezels.gezels.length).toBeGreaterThan(0);
  });

  it('authorizes same-user CLI product calls without a headless consent loop', async () => {
    const result = await runCli('agent', 'list');
    expect(result.stderr).toBe('');
    expect(result.stdout.trim().length).toBeGreaterThan(0);
  });

  it('spawns a missing user daemon and completes headlessly without desktop approval', async () => {
    const headlessHome = await mkdtemp(join(tmpdir(), 'gezel-cli-headless-'));
    try {
      const result = await runCliAtHome(headlessHome, 'agent', 'list');
      expect(result.stderr).toBe('');
      expect(result.stdout.trim().length).toBeGreaterThan(0);
      const runtime = await readRuntime(headlessHome);
      expect(runtime).not.toBeNull();
      expect(runtime?.port).not.toBe(6228);
      expect(runtime ? isProcessAlive(runtime.pid) : false).toBe(true);

      const hardStopped = await runCliAtHome(headlessHome, 'stop');
      expect(hardStopped.stderr).toBe('');
      expect(hardStopped.stdout).toContain('Hard stop complete:');
      expect(hardStopped.stdout).toContain('Local engines unloaded; Gezel is Reactive.');
      expect(runtime ? isProcessAlive(runtime.pid) : false).toBe(true);

      const stopped = await runCliAtHome(headlessHome, 'stop', '--daemon');
      expect(stopped.stderr).toBe('');
      expect(stopped.stdout).toContain('stopped gezeld pid=');
      expect(runtime ? isProcessAlive(runtime.pid) : true).toBe(false);
    } finally {
      const runtime = await readRuntime(headlessHome).catch(() => null);
      if (runtime && isProcessAlive(runtime.pid)) {
        await stopProcessByPid(runtime.pid);
      }
      await rm(headlessHome, { recursive: true, force: true });
    }
  });

  it('keeps ownership of a TUI-spawned daemon and shuts it down on exit', async () => {
    const tuiHome = await mkdtemp(join(tmpdir(), 'gezel-cli-tui-owned-'));
    const previousHome = process.env.GEZEL_HOME;
    const previousMock = process.env.GEZEL_MOCK_PROVIDER;
    let stop: (() => Promise<void>) | undefined;
    try {
      process.env.GEZEL_HOME = tuiHome;
      process.env.GEZEL_MOCK_PROVIDER = '1';
      const connection = await connectForTui({ home: tuiHome });
      stop = connection.stop;
      expect(stop).toBeTypeOf('function');

      const runtime = await readRuntime(tuiHome);
      expect(runtime).not.toBeNull();
      expect(runtime ? isProcessAlive(runtime.pid) : false).toBe(true);

      await stop?.();
      expect(runtime ? isProcessAlive(runtime.pid) : true).toBe(false);
    } finally {
      if (stop) await stop().catch(() => {});
      if (previousHome === undefined) delete process.env.GEZEL_HOME;
      else process.env.GEZEL_HOME = previousHome;
      if (previousMock === undefined) delete process.env.GEZEL_MOCK_PROVIDER;
      else process.env.GEZEL_MOCK_PROVIDER = previousMock;
      const runtime = await readRuntime(tuiHome).catch(() => null);
      if (runtime && isProcessAlive(runtime.pid)) await stopProcessByPid(runtime.pid);
      await rm(tuiHome, { recursive: true, force: true });
    }
  });

  it('persists config writes across HTTP requests', async () => {
    const before = await client.getConfig();
    const patch = { provider: 'copilot' as const };
    await client.updateConfig(patch);
    const after = await client.getConfig();
    expect(after.provider).toBe('copilot');
    // Idempotent round-trip.
    await client.updateConfig({ provider: before.provider });
  });

  it('drives status and doctor through the installed CLI entry point', async () => {
    const status = await runCli('status');
    expect(status.stderr).toBe('');
    expect(status.stdout).toContain('health ok:');

    const doctor = await runCli('doctor');
    expect(doctor.stderr).toBe('');
    expect(doctor.stdout).toContain('runtime file: present');
    expect(doctor.stdout).toContain(`pid=${spawned.pid}`);
  });

  it.each([
    ['agent', 'list'],
    ['env', 'list'],
    ['task', 'list'],
    ['model', 'list'],
    ['native', 'list'],
    ['native', 'status'],
  ])('executes the %s command family in a subprocess', async (family, command) => {
    const result = await runCli(family, command);
    expect(result.stderr).toBe('');
    expect(result.stdout.trim().length).toBeGreaterThan(0);
  });

  it('rejects an empty run command before opening a provider session', async () => {
    await expect(runCli('run')).rejects.toMatchObject({
      stderr: expect.stringContaining('usage: gezel run'),
    });
  });

  it('keeps stdout reply-only when run owns an in-process service', async () => {
    const runHome = await mkdtemp(join(tmpdir(), 'gezel-cli-run-output-'));
    const prompt = 'Reply exactly with: cli-stdout-only';
    try {
      const result = await execFileAsync(
        process.execPath,
        [cliEntry, '--home', runHome, '--standalone', 'run', prompt],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            GEZEL_HOME: runHome,
            GEZEL_MOCK_PROVIDER: '1',
            GEZEL_DISABLE_MACHINE_ENGINE: '1',
            GEZEL_SKIP_SYSTEM_BOOTSTRAP: '1',
            GEZEL_SECRETS_BACKEND: 'file',
            GEZEL_LOG_LEVEL: 'info',
          },
          // Cold service startup and shutdown contend with the other
          // integration workers in a full package run. Keep the child
          // deadline below the test deadline so failures surface from the
          // command itself and the finally block still has time to clean up.
          timeout: 45_000,
        },
      );

      expect(result.stdout).toBe(`Mock reply: ${prompt}\n`);
      expect(result.stderr).toContain('INFO ');
      expect(result.stderr).toContain('[service]');
      expect(await readRuntime(runHome)).toBeNull();
    } finally {
      const runtime = await readRuntime(runHome).catch(() => null);
      if (runtime && isProcessAlive(runtime.pid)) await stopProcessByPid(runtime.pid);
      await rm(runHome, { recursive: true, force: true });
    }
  }, 60_000);

  it('starts a craftbook from the do subcommand', async () => {
    const result = await runCli('do', 'security-architecture-review');
    expect(result.stderr).toBe('');
    expect(result.stdout).toMatch(/^started .+\/\d+ — Security Architecture Review/m);

    const { projects } = await client.listProjects();
    const project = projects.find(
      (candidate) => candidate.workingDir?.toLowerCase() === process.cwd().toLowerCase(),
    );
    expect(project).toBeDefined();
    const { tasks } = await client.listProjectTasks(project!.id);
    expect(tasks.some((task) => task.craftbook.id === 'security-architecture-review')).toBe(true);
  });
});
