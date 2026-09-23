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
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { resolveSecurityPolicy } from '@bendyline/gezel';
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
  systemServiceHome,
} from '@bendyline/gezel-client/node';
import { activeMachineSharedHome } from '@bendyline/gezel/paths';
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
function childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  for (const key of Object.keys(env)) {
    if (key.startsWith('VITEST')) delete env[key];
  }
  return env;
}

async function runCliAtHome(
  home: string,
  ...args: string[]
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(process.execPath, [cliEntry, '--home', home, ...args], {
    cwd: process.cwd(),
    env: childEnv({ GEZEL_HOME: home, GEZEL_MOCK_PROVIDER: '1' }),
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

  it('sets, lists, and removes write-only provider credentials through the built CLI', async () => {
    const value = 'integration-only-credential-value';
    const saved = await execFileAsync(
      process.execPath,
      [
        cliEntry,
        '--home',
        gezelHome,
        'secret',
        'set',
        'braveSearchApiKey',
        '--env',
        'GEZEL_TEST_SECRET_INPUT',
        '--use-for-search',
        '--json',
      ],
      {
        env: childEnv({
          GEZEL_HOME: gezelHome,
          GEZEL_MOCK_PROVIDER: '1',
          GEZEL_TEST_SECRET_INPUT: value,
        }),
        timeout: 25_000,
      },
    );
    expect(JSON.parse(saved.stdout)).toEqual({
      name: 'braveSearchApiKey',
      configured: true,
      searchProvider: 'brave',
    });
    const config = await client.getConfig();
    expect(config.hasBraveSearchApiKey).toBe(true);
    expect(config.webSearch?.provider).toBe('brave');
    const listed = await runCli('secret', 'list', '--json');
    expect(JSON.parse(listed.stdout).credentials).toContainEqual({
      name: 'braveSearchApiKey',
      configured: true,
    });
    expect(saved.stdout + saved.stderr + listed.stdout + listed.stderr).not.toContain(value);
    const piped = execFileAsync(
      process.execPath,
      [cliEntry, '--home', gezelHome, 'secret', 'set', 'tavilyApiKey', '--stdin', '--json'],
      {
        env: childEnv({ GEZEL_HOME: gezelHome, GEZEL_MOCK_PROVIDER: '1' }),
        timeout: 25_000,
      },
    );
    piped.child.stdin?.end(`${value}\r\n`);
    expect(JSON.parse((await piped).stdout)).toEqual({ name: 'tavilyApiKey', configured: true });
    await runCli('secret', 'remove', 'braveSearchApiKey');
    await runCli('secret', 'remove', 'tavilyApiKey');
    expect((await client.getConfig()).hasBraveSearchApiKey).toBe(false);
    expect((await client.getConfig()).hasTavilyApiKey).toBe(false);
    await client.updateConfig({ webSearch: { provider: 'mock' } });
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
      const invoked = await runCli(
        '--project',
        folder,
        'do',
        'Batch',
        'Smoke',
        'c23n',
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
      await expect(
        runCli('--project', folder, 'do', 'batch-meta', 'dp04', '--strict-sandbox'),
      ).rejects.toMatchObject({ code: 1 });
      if (process.platform !== 'darwin') {
        await expect(
          runCli(
            '--project',
            folder,
            'do',
            'batch-smoke',
            'c2',
            '--strict-sandbox',
            '--wait',
            '--json',
          ),
        ).rejects.toMatchObject({ code: 2 });
      }
    } finally {
      await rm(folder, { recursive: true, force: true });
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
      expect(hardStopped.stdout).toContain(
        `gezeld is still running (pid ${runtime?.pid}); run \`gezel stop --daemon\``,
      );
      expect(runtime ? isProcessAlive(runtime.pid) : false).toBe(true);

      const stopped = await runCliAtHome(headlessHome, 'stop', '--daemon');
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

  it('sets, reads, and clears a gezel output limit without erasing its other tuning', async () => {
    const gezel = await client.createGezel({ name: 'Output budget test', about: 'Test only.' });
    const tuning = {
      sampling: { temperature: 0.35, maxTokens: 8192 },
      reasoning: { thinkingBudget: 2048 },
    };
    await client.updateGezelSettings(gezel.id, { tuning });
    const args = ['agent', 'output-limit', gezel.id];
    expect(JSON.parse((await runCli(...args, '--json')).stdout)).toEqual({
      gezelId: gezel.id,
      outputTokens: 8192,
    });
    expect(JSON.parse((await runCli(...args, '16384', '--json')).stdout)).toEqual({
      gezelId: gezel.id,
      outputTokens: 16384,
    });
    expect((await client.getGezel(gezel.id)).parsed.frontmatter.tuning).toEqual({
      ...tuning,
      sampling: { ...tuning.sampling, maxTokens: 16384 },
    });
    expect(JSON.parse((await runCli(...args, 'auto', '--json')).stdout).outputTokens).toBeNull();
    expect((await client.getGezel(gezel.id)).parsed.frontmatter.tuning).toEqual({
      sampling: { temperature: 0.35 },
      reasoning: tuning.reasoning,
    });
    for (const value of ['0', '-1', '1.5', '1e4', '9007199254740992']) {
      await expect(runCli(...args, value)).rejects.toMatchObject({
        stderr: expect.stringContaining('positive integer'),
      });
    }
    const plain = await client.createGezel({
      name: 'Inherited output budget test',
      about: 'Test only.',
    });
    await runCli('agent', 'output-limit', plain.id, '1024');
    await runCli('agent', 'output-limit', plain.id, 'auto');
    expect((await client.getGezel(plain.id)).parsed.frontmatter.tuning).toBeUndefined();
  }, 30_000);

  it('sets, reads, and clears model context through the CLI without changing other models', async () => {
    await client.updateModelContextOverride('llama-cpp', 'unrelated-model', 98304);
    const args = ['model', 'context', 'test-model'];
    const set = JSON.parse(
      (await runCli(...args, '65536', '--provider', 'llama-cpp', '--json')).stdout,
    );
    expect(set).toEqual({ provider: 'llama-cpp', modelId: 'test-model', contextTokens: 65536 });
    expect(JSON.parse((await runCli(...args, '--provider', 'llama-cpp', '--json')).stdout)).toEqual(
      set,
    );
    await expect(runCli(...args, '1e5')).rejects.toMatchObject({ code: 1 });
    await expect(runCli(...args, '1024')).rejects.toMatchObject({ code: 1 });
    await runCli(...args, 'auto', '--provider', 'llama-cpp');
    expect((await client.getModelContextOverrides('llama-cpp')).overrides).toEqual({
      'unrelated-model': 98304,
    });
    await client.updateModelContextOverride('llama-cpp', 'unrelated-model', null);
  });

  it('pauses one task idempotently through the CLI while preserving other task work', async () => {
    const create = (title: string) =>
      client.createTask('default', {
        title,
        description: 'Manual task for the CLI pause integration check.',
        assignee: { kind: 'user' },
        steps: [{ name: 'Main' }],
      });
    const target = await create('Pause target');
    const neighbor = await create('Unaffected neighbor');
    const before = (await client.getConfig()).aiEngagementMode;
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(JSON.parse((await runCli('task', 'pause', target.ref, '--json')).stdout)).toEqual({
        taskRef: target.ref,
        status: 'paused',
      });
    }
    expect((await client.getTaskByRef(neighbor.ref)).status).toBe('active');
    expect((await client.getConfig()).aiEngagementMode).toBe(before);
    await client.setTaskStatus(neighbor.projectId, neighbor.num, 'canceled');
    await expect(runCli('task', 'pause', neighbor.ref)).rejects.toMatchObject({
      stderr: expect.stringContaining('pause requires an active or paused task'),
    });
  });

  it('sets and clears inference concurrency while preserving other providers', async () => {
    const before = await client.getConfig();
    try {
      await client.updateConfig({
        providerConcurrency: { ...before.providerConcurrency, openai: 7 },
      });
      const args = ['model', 'concurrency'];
      expect(
        JSON.parse((await runCli(...args, '1', '--provider', 'llama-cpp', '--json')).stdout),
      ).toEqual({ provider: 'llama-cpp', slots: 1 });
      expect(
        JSON.parse((await runCli(...args, '--provider', 'llama-cpp', '--json')).stdout).slots,
      ).toBe(1);
      await expect(runCli(...args, '0')).rejects.toMatchObject({ code: 1 });
      await expect(runCli(...args, '1.5')).rejects.toMatchObject({ code: 1 });
      await runCli(...args, 'auto', '--provider', 'llama-cpp');
      expect((await client.getConfig()).providerConcurrency).toEqual({
        ...before.providerConcurrency,
        openai: 7,
      });
    } finally {
      await client.updateConfig({ providerConcurrency: before.providerConcurrency ?? {} });
    }
  });

  it('configures external services and project indexing through explicit CLI settings', async () => {
    const before = await client.getConfig();
    try {
      const result = await runCli('security', 'external-services', 'on', '--json');
      expect(JSON.parse(result.stdout)).toEqual({ allowExternalServices: true });
      const after = await client.getConfig();
      expect(after.securityPolicy?.allowExternalServices).toBe(true);
      expect(after.securityPolicy?.allowFileEdits).toBe(
        resolveSecurityPolicy(before).allowFileEdits,
      );
      await expect(runCli('security', 'external-services', 'yes')).rejects.toMatchObject({
        stderr: expect.stringContaining('Use on or off'),
      });
      const indexing = JSON.parse((await runCli('env', 'indexing', 'off', '--json')).stdout);
      expect(indexing.indexingEnabled).toBe(false);
      expect((await client.getProject(indexing.projectId)).indexingEnabled).toBe(false);
      await runCli('env', 'indexing', 'on');
    } finally {
      if (before.securityPolicy)
        await client.updateConfig({ securityPolicy: before.securityPolicy });
    }
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
    const runCwd = await mkdtemp(join(tmpdir(), 'gezel-cli-run-workspace-'));
    const prompt = 'Reply exactly with: cli-stdout-only';
    try {
      const result = await execFileAsync(
        process.execPath,
        [cliEntry, '--home', runHome, '--standalone', 'run', prompt],
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

      expect(result.stdout).toBe(`Mock reply: ${prompt}\n`);
      expect(result.stderr).toContain('INFO ');
      expect(result.stderr).toContain('[service]');
      expect(await readRuntime(runHome)).toBeNull();
    } finally {
      const runtime = await readRuntime(runHome).catch(() => null);
      if (runtime && isProcessAlive(runtime.pid)) await stopProcessByPid(runtime.pid);
      await rm(runHome, { recursive: true, force: true });
      await rm(runCwd, { recursive: true, force: true });
    }
  }, 90_000);

  /**
   * The warm path, and the one that used to deadlock. Any command that starts
   * a daemon — `gezel start`, or a read-only `gezel agent list` — leaves one
   * running, and `run` then has to adopt it. It used to open a Connected Apps
   * consent handshake instead and block for the full five-minute approval
   * timeout on a code that can only be typed into the desktop app, which an
   * npm-only install does not have. The cold-path case above cannot see that:
   * `run` only owns an in-process service when nothing is already running.
   */
  it('adopts an already-running daemon for run instead of asking for desktop approval', async () => {
    const runHome = await mkdtemp(join(tmpdir(), 'gezel-cli-run-adopt-'));
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

  it('adds, lists, toggles, and removes an AI App through the app subcommand', async () => {
    // Build the fixture .gezapp through the daemon's own exporter — the
    // export route writes it into the default project's artifacts drawer,
    // and this test owns that home directory.
    const exported = await client.exportAiApp('default', { typeId: 'just-chat' });
    const fixturePath = join(gezelHome, 'projects', 'default', 'artifacts', exported.artifactPath);

    const added = await runCli('app', 'add', fixturePath, '--yes');
    expect(added.stderr).toBe('');
    expect(added.stdout).toContain('Installed just-chat@');

    const again = await runCli('app', 'add', fixturePath, '--yes');
    expect(again.stdout).toContain('already installed — no changes');

    const list = await runCli('app', 'list');
    expect(list.stdout).toContain('just-chat');
    expect(list.stdout).toContain('enabled');

    const folder = await mkdtemp(join(tmpdir(), 'gezel-app-apply-'));
    try {
      const applied = await runCliAtHome(
        gezelHome,
        '--project',
        folder,
        'app',
        'apply',
        'just-chat',
        '--yes',
      );
      expect(applied.stdout).toContain('Applied just-chat@');

      const status = await runCliAtHome(gezelHome, '--project', folder, 'app', 'status');
      expect(status.stdout).toContain('just-chat');
      expect(status.stdout).not.toContain('Update available');

      const noop = await runCliAtHome(
        gezelHome,
        '--project',
        folder,
        'app',
        'apply',
        'just-chat',
        '--yes',
      );
      expect(noop.stdout).toContain('already applied');
    } finally {
      await rm(folder, { recursive: true, force: true });
    }

    const disabled = await runCli('app', 'disable', 'just-chat');
    expect(disabled.stdout).toContain('Disabled just-chat@');

    const show = await runCli('app', 'show', 'just-chat');
    expect(show.stdout).toContain('state: disabled');

    const removed = await runCli('app', 'remove', 'just-chat', '--yes');
    expect(removed.stdout).toContain('Uninstalled just-chat');

    const empty = await runCli('app', 'list');
    expect(empty.stdout).toContain('No AI Apps installed');
  }, 90_000);
});
