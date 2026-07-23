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
  readRuntime,
  resolveDaemonEntry,
} from '@bendyline/gezel-client/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let gezelHome: string;
let spawned: DiscoverOrSpawnResult;
let client: GezelClient;
const execFileAsync = promisify(execFile);
const cliEntry = fileURLToPath(new URL('../dist/bin/gezel.js', import.meta.url));

async function runCli(...args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(process.execPath, [cliEntry, '--home', gezelHome, ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      GEZEL_HOME: gezelHome,
      GEZEL_MOCK_PROVIDER: '1',
    },
    timeout: 15_000,
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
      // the canonical well-known port (43935); pinning to 0 keeps this
      // cross-process test hermetic and off the shared port so it can't
      // race a real local daemon or another spawning suite.
      GEZEL_PORT: '0',
    },
    timeoutMs: 15_000,
  });
  client = spawned.client;
}, 20_000);

afterAll(async () => {
  if (spawned?.child && spawned.child.exitCode === null) {
    spawned.child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const onExit = () => resolve();
      spawned.child!.once('exit', onExit);
      setTimeout(() => resolve(), 3000);
    });
  }
  if (gezelHome) await rm(gezelHome, { recursive: true, force: true });
});

describe('gezeld cross-process integration', () => {
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
});
