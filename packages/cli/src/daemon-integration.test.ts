/**
 * End-to-end integration: spawn `gezeld` as a real child process and drive
 * it with the real `GezelClient` over HTTP. Unlike the service package's
 * `integration.test.ts` (which boots `startService()` in the same Node
 * process as the test runner), this suite exercises the full cross-process
 * path — token file handshake, runtime-files discovery, HTTP transport,
 * auth middleware. If the Electron supervisor's spawn flow ever regresses
 * in a way the in-process tests miss, it'll surface here first. CLI commands
 * against a live daemon are in daemon-commands.test.ts.
 */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GezelClient,
  createTrustingFetch,
  isProcessAlive,
  readRuntime,
  stopProcessByPid,
  systemServiceHome,
} from '@bendyline/gezel-client/node';
import { activeMachineSharedHome } from '@bendyline/gezel/paths';
import { describe, expect, it } from 'vitest';
import { connectForTui, spawnedDaemonNotice } from './connection.js';
import {
  childEnv,
  cliEntry,
  client,
  daemonWorkspaceDirs,
  execFileAsync,
  gezelHome,
  mkdtempHomeWithoutRetrieval,
  registerSharedDaemon,
  runCli,
  runCliAtHome,
  spawned,
  workspaceCwd,
} from './test-support/shared-daemon.js';

registerSharedDaemon();

// Every case here crosses a process boundary, and the CLI-entry cases shell
// out with a 25s `execFile` budget each — more than vitest's 5s default.
describe('gezeld cross-process integration', { timeout: 30_000 }, () => {
  // A developer machine that ever ran a packaged install carries a real
  // machine-shared root. The daemon mounts it by design, so a machine-shared
  // project resolves its content there rather than under this suite's temp
  // home — which both breaks fresh-home assertions and writes into real user
  // state. vitest.config.ts points both roots at paths that never carry a
  // trust marker; fail loudly here if that stops reaching the workers.
  it('isolates installer-managed host state from these fresh homes', () => {
    expect(process.env.GEZEL_MACHINE_SHARED_HOME).toContain('gezel-cli-host-isolation-');
    expect(activeMachineSharedHome()).toBeNull();
    expect(systemServiceHome()).toBe(process.env.GEZEL_SYSTEM_SERVICE_HOME);
  });

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

  it('rejects dangerous globs through the built daemon and still handles ordinary searches', async () => {
    for (const glob of [
      `${'{'.repeat(4999)}x${'}'.repeat(4999)}`,
      '{a,b}'.repeat(30),
      '{1..1000000000}',
    ]) {
      await expect(client.toolFindFiles('default', { glob })).rejects.toMatchObject({
        status: 422,
      });
    }
    const result = await client.toolFindFiles('default', { glob: '**/*.{ts,tsx}', maxResults: 2 });
    expect(Array.isArray(result.files)).toBe(true);
    await expect(client.health()).resolves.toMatchObject({ ok: true });
  });

  it('runs parameterized project craftbooks and workflow modules through the built Windows CLI', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'gezel-cli-craftbook-'));
    try {
      const dir = join(folder, '.gezel', 'craftbooks', 'batch-smoke');
      await mkdir(join(dir, 'versions', '1.0.0'), { recursive: true });
      await writeFile(
        join(dir, 'manifest.json'),
        JSON.stringify({
          schemaVersion: 1,
          kind: 'craftbook-template',
          id: 'batch-smoke',
          name: 'Batch Smoke',
          description: 'Deterministic CLI integration fixture.',
          tags: [],
          maintainer: { name: 'Tests' },
        }),
      );
      await writeFile(
        join(dir, 'versions', '1.0.0', 'craftbook.json'),
        JSON.stringify({
          id: 'batch-smoke',
          name: 'Batch Smoke',
          version: '1.0.0',
          releasedAt: '2026-09-16T00:00:00Z',
          entryStepId: 'write',
          defaultAssignee: { kind: 'user' },
          paramSchema: {
            type: 'object',
            required: ['region'],
            properties: { region: { type: 'string' }, count: { type: 'integer', default: 3 } },
          },
          steps: [
            {
              id: 'write',
              name: 'Write marker',
              terminal: true,
              onEnter: {
                name: 'marker',
                scope: 'craftbook',
                inputs: { region: '{{region}}', count: '{{count}}' },
                autoAdvanceOnSuccess: true,
              },
            },
          ],
          scripts: {
            marker: `import { gezel, defineScript } from '@bendyline/gezel-sdk';
export const meta = defineScript({ name: 'marker', description: 'Write an input marker.', requires: ['artifacts.write'], inputs: { region: { type: 'string', description: 'region' }, count: { type: 'string', description: 'count' } } });
await gezel.artifacts.write('cli-marker.json', JSON.stringify(gezel.input));
gezel.output({ ok: true });`,
          },
        }),
      );
      // A project book's scripts are trusted only on request: gezels can edit
      // them. Without the flag this run would need the OS boundary that
      // childEnv switches off on Windows.
      const invoked = await runCli(
        '--project',
        folder,
        'do',
        'Batch',
        'Smoke',
        'c23n',
        '--trust-scripts',
        '--wait',
        '--json',
      ).catch((error) => {
        throw new Error(`${error.message}\n${error.stdout}`);
      });
      const completed = JSON.parse(invoked.stdout);
      expect(completed.outcome).toBe('complete');
      expect(completed.task.craftbookParams).toMatchObject({ region: 'c23n', count: '3' });
      expect(completed.task.cliTrustedScriptHashes).toHaveLength(1);
      const artifact = await client.readProjectArtifact(
        completed.task.projectId,
        'cli-marker.json',
      );
      expect(JSON.parse(artifact.content)).toEqual({ region: 'c23n', count: '3' });
      await mkdir(join(folder, '.gezel', 'workflows'), { recursive: true });
      await writeFile(
        join(folder, '.gezel', 'workflows', 'smoke.mjs'),
        `export async function run({ args, runCraftbook }) { return runCraftbook('batch-smoke', { region: args[0] }); }`,
      );
      const workflow = await runCli('--project', folder, 'workflow', 'smoke', 'c23', '--json');
      expect(JSON.parse(workflow.stdout).outcome).toBe('complete');
      const metaDir = join(folder, '.gezel', 'craftbooks', 'batch-meta');
      await mkdir(join(metaDir, 'versions', '1.0.0'), { recursive: true });
      await writeFile(
        join(metaDir, 'manifest.json'),
        JSON.stringify({ id: 'batch-meta', name: 'Batch Meta' }),
      );
      await writeFile(
        join(metaDir, 'versions', '1.0.0', 'craftbook.json'),
        JSON.stringify({
          id: 'batch-meta',
          name: 'Batch Meta',
          version: '1.0.0',
          cliWorkflow: { module: '.gezel/workflows/meta.mjs' },
          paramSchema: {
            type: 'object',
            required: ['region'],
            properties: { region: { type: 'string' } },
          },
          defaultAssignee: { kind: 'user' },
          steps: [{ id: 'batch', name: 'Batch', terminal: true }],
        }),
      );
      await writeFile(
        join(folder, '.gezel', 'workflows', 'meta.mjs'),
        `
export async function run({ client, projectId, craftbook, params, runCraftbook }) {
  const parent = await client.createTask(projectId, { title: 'Batch parent', description: 'Run a linked child and finish only after its output passes.', craftbookId: craftbook.id, craftbookSourceId: 'project', craftbookParams: params });
  const child = await runCraftbook('batch-smoke', { region: params.region }, { parentTaskRef: parent.ref, title: 'Write dp04 subject' });
  if (child.exitCode) return child;
  await client.completeTaskStep(projectId, parent.num, parent.activeStepId);
  return { parentRef: parent.ref, childRef: child.task.ref, exitCode: 0 };
}`,
      );
      const meta = JSON.parse(
        (await runCli('--project', folder, 'do', 'batch-meta', 'dp04', '--wait', '--json')).stdout,
      );
      expect((await client.getTaskByRef(meta.parentRef)).status).toBe('complete');
      expect((await client.getTaskByRef(meta.childRef)).parentTaskRef).toBe(meta.parentRef);
      expect((await client.getTaskByRef(meta.childRef)).title).toBe('Write dp04 subject');
      expect((await client.getTaskByRef(meta.childRef)).craftbookParams?.region).toBe('dp04');
      // The module completed its parent's user-assigned step itself, so the
      // person was never asked to approve it, not even by a withdrawn card.
      const parentProject = (await client.getTaskByRef(meta.parentRef)).projectId;
      const parentCards = await client.listQuestions({
        projectId: parentProject,
        taskRefs: [meta.parentRef],
      });
      expect(parentCards.questions.filter((q) => q.intent?.kind === 'step-awaits-owner')).toEqual(
        [],
      );
      await expect(
        runCli('--project', folder, 'do', 'batch-meta', 'dp04', '--strict-sandbox'),
      ).rejects.toMatchObject({ code: 1 });
      // Linux can enforce denyNet through systemd on some hosts. Probe the
      // actual runner; Windows is explicitly disabled in childEnv above.
      let boundaryAvailable = false;
      if (process.platform !== 'win32') {
        const { runInSandbox } = await import('@bendyline/gezel-service');
        await writeFile(join(folder, 'sandbox-probe.mjs'), "console.log('sandbox probe');\n");
        const probe = await runInSandbox({
          entry: 'sandbox-probe.mjs',
          timeoutMs: 10_000,
          cwd: folder,
          input: '',
          denyNet: true,
        });
        boundaryAvailable = probe.exitCode === 0;
        if (!boundaryAvailable) {
          expect(probe.stderr).toContain('denyNet requires an enforceable OS network boundary');
        }
      }
      const strictRun = runCli(
        '--project',
        folder,
        'do',
        'batch-smoke',
        'c2',
        '--strict-sandbox',
        '--wait',
        '--json',
      );
      if (boundaryAvailable) {
        const strict = JSON.parse((await strictRun).stdout);
        expect(strict.outcome).toBe('complete');
        expect(strict.task.cliTrustedScriptHashes ?? []).toEqual([]);
      } else {
        await expect(strictRun).rejects.toMatchObject({ code: 2 });
      }
    } finally {
      daemonWorkspaceDirs.push(folder);
    }
  }, 90_000);

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
      expect(result.stdout.trim().length).toBeGreaterThan(0);
      const runtime = await readRuntime(headlessHome);
      expect(runtime).not.toBeNull();
      // No approval prompt: the only stderr is the notice that the daemon
      // this command started keeps running.
      expect(result.stderr).toBe(spawnedDaemonNotice(runtime?.pid));
      expect(runtime?.port).not.toBe(6228);
      expect(runtime ? isProcessAlive(runtime.pid) : false).toBe(true);

      const hardStopped = await runCliAtHome(headlessHome, 'stop', '--keep-running');
      expect(hardStopped.stderr).toBe('');
      expect(hardStopped.stdout).toContain('Hard stop complete:');
      expect(hardStopped.stdout).toContain('Local engines unloaded; Gezel is Reactive.');
      expect(hardStopped.stdout).toContain(
        `gezeld is still running (pid ${runtime?.pid}); run \`gezel stop\``,
      );
      expect(runtime ? isProcessAlive(runtime.pid) : false).toBe(true);

      const stopped = await runCliAtHome(headlessHome, 'stop');
      expect(stopped.stderr).toBe('');
      expect(stopped.stdout).toContain('stopped gezeld pid=');
      expect(runtime ? isProcessAlive(runtime.pid) : true).toBe(false);

      // With the daemon gone, status reports it AND fails, so scripts can gate on it.
      const down = await runCliAtHome(headlessHome, 'status').then(
        () => null,
        (err: { code?: number; stdout?: string }) => err,
      );
      expect(down?.code).toBe(1);
      expect(down?.stdout).toMatch(/gezeld is not running|alive=false/);
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

  it('rejects an empty run command before opening a provider session', async () => {
    await expect(runCli('run')).rejects.toMatchObject({
      stderr: expect.stringContaining('usage: gezel run'),
    });
  });

  it.each(['', ' \r\n\t '])('rejects empty stdin (%j) before starting a service', async (input) => {
    const runHome = await mkdtemp(join(tmpdir(), 'gezel-cli-run-empty-'));
    try {
      const command = execFileAsync(process.execPath, [cliEntry, '--home', runHome, 'run', '-'], {
        cwd: workspaceCwd,
        env: childEnv({ GEZEL_HOME: runHome, GEZEL_MOCK_PROVIDER: '1' }),
        timeout: 25_000,
      });
      command.child.stdin?.end(input);
      await expect(command).rejects.toMatchObject({
        code: 1,
        stdout: '',
        stderr: expect.stringContaining('empty input'),
      });
      expect(await readdir(runHome)).toEqual([]);
    } finally {
      await rm(runHome, { recursive: true, force: true });
    }
  });

  it.each(['arguments', 'stdin'])(
    'keeps stdout reply-only when run reads %s and owns an in-process service',
    async (source) => {
      const runHome = await mkdtempHomeWithoutRetrieval('gezel-cli-run-output-');
      const runCwd = await mkdtemp(join(tmpdir(), 'gezel-cli-run-workspace-'));
      const prompt = 'Summarize these notes:\nThe launch is Friday.\n';
      try {
        const command = execFileAsync(
          process.execPath,
          [cliEntry, '--home', runHome, '--standalone', 'run', source === 'stdin' ? '-' : prompt],
          {
            // This case verifies the CLI's stdout/stderr boundary, not workspace
            // retrieval. Keep the empty project cwd separate from the service
            // home so the indexer cannot ingest state the daemon is still writing.
            cwd: runCwd,
            env: childEnv({
              GEZEL_HOME: runHome,
              GEZEL_MOCK_PROVIDER: '1',
              GEZEL_DISABLE_MACHINE_ENGINE: '1',
              GEZEL_SKIP_SYSTEM_BOOTSTRAP: '1',
              GEZEL_SECRETS_BACKEND: 'file',
              GEZEL_LOG_LEVEL: 'info',
            }),
            // Cold service startup and shutdown contend with the other
            // integration workers in a full package run. Keep the child
            // deadline below the test deadline so failures surface from the
            // command itself and the finally block still has time to clean up.
            timeout: 75_000,
          },
        );
        command.child.stdin?.end(source === 'stdin' ? prompt : undefined);
        const result = await command;

        expect(result.stdout).toBe(`Mock reply: ${source === 'stdin' ? prompt : prompt.trim()}\n`);
        // The terminal is the person's: the service's records go to its log
        // file, as a daemon's do.
        expect(result.stderr).not.toContain('INFO ');
        expect(result.stderr).not.toContain('[service]');
        const logs = await readdir(join(runHome, 'logs'));
        const serviceLog = logs.find((name) => name.startsWith('service-'));
        expect(serviceLog).toBeDefined();
        const logged = await readFile(join(runHome, 'logs', serviceLog ?? ''), 'utf8');
        expect(logged).toContain('INFO  [service]');
        expect(logged).not.toContain('[service] [service]');
        expect(await readRuntime(runHome)).toBeNull();
      } finally {
        const runtime = await readRuntime(runHome).catch(() => null);
        if (runtime && isProcessAlive(runtime.pid)) await stopProcessByPid(runtime.pid);
        await rm(runHome, { recursive: true, force: true });
        await rm(runCwd, { recursive: true, force: true });
      }
    },
    90_000,
  );

  /**
   * The warm path, and the one that used to deadlock. Any command that starts
   * a daemon — `gezel start`, or a read-only `gezel agent list` — leaves one
   * running, and `run` then has to adopt it. It used to open an app
   * consent handshake instead and block for the full five-minute approval
   * timeout on a code that can only be typed into the desktop app, which an
   * npm-only install does not have. The cold-path case above cannot see that:
   * `run` only owns an in-process service when nothing is already running.
   */
  it('adopts an already-running daemon for run instead of asking for desktop approval', async () => {
    const runHome = await mkdtempHomeWithoutRetrieval('gezel-cli-run-adopt-');
    const runCwd = await mkdtemp(join(tmpdir(), 'gezel-cli-run-adopt-workspace-'));
    const prompt = 'Reply exactly with: cli-adopted-daemon';
    const env = childEnv({
      GEZEL_HOME: runHome,
      GEZEL_MOCK_PROVIDER: '1',
      GEZEL_DISABLE_MACHINE_ENGINE: '1',
      GEZEL_SKIP_SYSTEM_BOOTSTRAP: '1',
      GEZEL_SECRETS_BACKEND: 'file',
      GEZEL_LOG_LEVEL: 'warn',
    });
    try {
      // Arm the trap exactly as a person does: an ordinary read-only command.
      await execFileAsync(
        process.execPath,
        [cliEntry, '--home', runHome, '--standalone', 'agent', 'list'],
        { cwd: runCwd, env, timeout: 40_000 },
      );
      const runtime = await readRuntime(runHome);
      expect(runtime && isProcessAlive(runtime.pid)).toBe(true);

      const result = await execFileAsync(
        process.execPath,
        [cliEntry, '--home', runHome, '--standalone', 'run', prompt],
        // Well under the 300s approval timeout: a regression must fail here
        // rather than quietly spend five minutes waiting for a human.
        { cwd: runCwd, env, timeout: 60_000 },
      );

      expect(result.stdout).toBe(`Mock reply: ${prompt}\n`);
      expect(result.stderr).not.toContain('Open the Gezel app');
      expect(result.stderr).not.toContain('Waiting for approval');
      // Adopted, not replaced: the daemon `agent list` started is still the
      // one serving, and `run` left it alone.
      const after = await readRuntime(runHome);
      expect(after?.pid).toBe(runtime?.pid);
    } finally {
      const runtime = await readRuntime(runHome).catch(() => null);
      if (runtime && isProcessAlive(runtime.pid)) await stopProcessByPid(runtime.pid);
      await rm(runHome, { recursive: true, force: true });
      await rm(runCwd, { recursive: true, force: true });
    }
  }, 120_000);

  it('wires the settings commands into the built CLI', async () => {
    // Their logic and validation are pinned in settings-command.test.ts.
    expect((await runCli('growth')).stdout.trim()).toMatch(
      /^Growth \(XP and level-ups\): (on|off)$/,
    );
  });
});
