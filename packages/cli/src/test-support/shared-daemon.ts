/**
 * One real `gezeld` per test file, spawned as a child process and driven with
 * the real `GezelClient` and the built CLI. Shared by daemon-integration.test.ts
 * (transport, auth, lifecycle) and daemon-commands.test.ts (CLI commands
 * against a live daemon), which were one 117 s file until 2026-11-23; split,
 * vitest runs them side by side, each against its own daemon.
 *
 * Call `registerSharedDaemon()` at the top of a test file. The bindings below
 * are live: they hold the daemon once `beforeAll` has run.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  type DiscoverOrSpawnResult,
  type GezelClient,
  discoverOrSpawn,
  resolveDaemonEntry,
  stopOwnedDaemon,
} from '@bendyline/gezel-client/node';
import { afterAll, afterEach, beforeAll } from 'vitest';

export let gezelHome: string;
/**
 * The working directory every CLI child runs in. Commands that act on "the
 * current project" register it, and `env indexing on` indexes it. When this
 * was the checkout itself, the daemon indexed the whole monorepo (~5k files)
 * mid-suite; under V8 coverage that exhausted the runner and the daemon died
 * with a Zone OOM, failing every later case (2026-09-25).
 */
export let workspaceCwd: string;
// The shared daemon can retain workspace handles after a CLI exits. Windows
// cleanup must wait for daemon shutdown, including when a test fails.
export const daemonWorkspaceDirs: string[] = [];
export let spawned: DiscoverOrSpawnResult;
export let client: GezelClient;
/** The daemon's recent output, printed when a case fails; its home is deleted afterwards. */
const daemonLog: string[] = [];
export const execFileAsync = promisify(execFile);
export const cliEntry = fileURLToPath(new URL('../../dist/bin/gezel.js', import.meta.url));

export async function runCli(...args: string[]): Promise<{ stdout: string; stderr: string }> {
  return runCliAtHome(gezelHome, ...args);
}

/**
 * Env for a spawned CLI child, minus the vitest markers.
 *
 * These children run the real `dist` build, so `VITEST` in their environment
 * is a lie with teeth: the service reads it to pick the in-process fallbacks
 * that exist because worker entrypoints aren't built under vitest. A CLI run
 * that boots its own service then loads the embedding model on its main
 * thread and cannot exit until that load finishes — the whole reason this
 * suite used to hit its deadline.
 */
export function childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  // On Windows a fresh home downloads the MXC launcher at boot, and once it
  // lands `--strict-sandbox` stops refusing — so the suite's outcome depended
  // on how fast npm answered. Keep Windows isolation disabled for this suite.
  const env: NodeJS.ProcessEnv = { ...process.env, GEZEL_MXC: 'off', ...extra };
  for (const key of Object.keys(env)) {
    if (key.startsWith('VITEST')) delete env[key];
  }
  return env;
}

/**
 * A fresh home whose turns carry no indexed context. The mock provider echoes
 * the prompt it was given, and per-turn retrieval legitimately prepends hits
 * from the bundled Handboek catalog, which an empty workspace cwd cannot keep
 * out. The stdout cases assert the CLI's stdout/stderr boundary, not what
 * retrieval finds.
 */
export async function mkdtempHomeWithoutRetrieval(prefix: string): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), prefix));
  await writeFile(join(home, 'config.json'), `${JSON.stringify({ retrieval: { mode: 'off' } })}\n`);
  return home;
}

export async function runCliAtHome(
  home: string,
  ...args: string[]
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(process.execPath, [cliEntry, '--home', home, ...args], {
    cwd: workspaceCwd,
    env: childEnv({ GEZEL_HOME: home, GEZEL_MOCK_PROVIDER: '1' }),
    // connectOwned gives a cold daemon up to 20s to start. Keep the outer
    // process budget larger than that contract so execFile cannot kill the
    // CLI before it can report its own success or startup failure.
    timeout: 25_000,
  });
}

export function registerSharedDaemon(): void {
  beforeAll(async () => {
    gezelHome = await mkdtemp(join(tmpdir(), 'gezel-daemon-integ-'));
    // Resolved to match what a child's process.cwd() reports (macOS /var → /private/var).
    workspaceCwd = await realpath(await mkdtemp(join(tmpdir(), 'gezel-daemon-integ-cwd-')));
    const daemonEntry = resolveDaemonEntry(import.meta.url);
    spawned = await discoverOrSpawn({
      daemonEntry,
      detached: false,
      stdio: 'pipe',
      home: gezelHome,
      // Stripped of VITEST like every CLI child: inheriting it put this daemon's
      // indexing and embedding on its event loop, and about a minute after the
      // suite first touched the cwd project that stalled health checks past
      // the CLI's 5s probe.
      env: childEnv({
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
      }),
      timeoutMs: 15_000,
    });
    client = spawned.client;
    // Drained here or nowhere: a daemon whose pipe fills blocks on its next log line.
    for (const stream of [spawned.child?.stdout, spawned.child?.stderr])
      stream?.on('data', (chunk: Buffer) => {
        daemonLog.push(...chunk.toString().split('\n').filter(Boolean));
        daemonLog.splice(0, daemonLog.length - 200);
      });
  }, 20_000);

  afterEach(({ task }) => {
    if (task.result?.state === 'fail')
      console.error(`gezeld output before this failure:\n${daemonLog.join('\n')}`);
  });

  afterAll(async () => {
    await stopOwnedDaemon(spawned?.child);
    for (const folder of daemonWorkspaceDirs) {
      await rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
    if (gezelHome) await rm(gezelHome, { recursive: true, force: true });
    if (workspaceCwd) await rm(workspaceCwd, { recursive: true, force: true });
  });
}
