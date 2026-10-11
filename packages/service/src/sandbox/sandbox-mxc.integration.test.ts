import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { type AddressInfo, createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ScriptExecutionOptions } from '@bendyline/gezel-script-runtime';
import {
  MXC_EXECUTOR_SHA256,
  MXC_VERIFIED_SENTINEL,
  MXC_VERSION,
  mxcArch,
  mxcInstallDir,
  mxcInstalledExecutor,
} from '@bendyline/gezel/native';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NodeScriptExecutor } from '../scripts/node-executor.js';
import { denyNetBoundaryAvailable, runInSandbox } from './runner.js';
import {
  MXC_EXEC_ENV,
  MXC_MAX_CONCURRENT_ENV,
  MXC_NODE_PATH_FLAGS,
  canApplyWindowsMxcSandbox,
  resetWindowsMxcProbeForTests,
  resolveMxcExecutor,
  resolveWindowsMxcState,
  setWindowsMxcEnabled,
  setWindowsMxcHome,
  windowsMxcLauncherForRun,
  windowsMxcState,
  wrapForWindowsMxc,
} from './windows-mxc.js';

// Runs on Windows with GEZEL_MXC_EXEC pointing at a wxc-exec.exe. Where the
// probe passes, the full suite runs; where it fails (Windows Server CI images,
// older builds, a session with no usable desktop), the second block proves
// the host fails closed instead. Nothing is skipped silently.
const enabled = process.platform === 'win32' && Boolean(process.env[MXC_EXEC_ENV]);
const probed = enabled ? await resolveWindowsMxcState(process.execPath) : null;
if (probed) console.info(`[mxc-it] probe: ${JSON.stringify(probed)}`);

describe.runIf(enabled && probed?.state !== 'active')('Windows MXC sandbox unavailable', () => {
  it('reports why, and refuses denyNet work instead of running it bare', async () => {
    expect(probed).toMatchObject({ state: 'unavailable', reason: expect.any(String) });
    expect(await denyNetBoundaryAvailable()).toBe(false);
    const dir = await mkdtemp(join(tmpdir(), 'gezel-mxc-closed-'));
    try {
      await writeFile(join(dir, 'never.mjs'), "console.log('ran');\n", 'utf8');
      const result = await runInSandbox({ entry: 'never.mjs', cwd: dir, input: '', denyNet: true });
      expect(result.exitCode).toBe(126);
      expect(result.stdout).toBe('');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe.runIf(probed?.state === 'active')('Windows MXC sandbox', () => {
  let root = '';
  let work = '';
  let secret = '';

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'gezel-mxc-it-'));
    work = await mkdtemp(join(root, 'work-'));
    const outside = await mkdtemp(join(root, 'outside-'));
    secret = join(outside, 'secret.txt');
    await writeFile(secret, 'never-readable-from-the-script', 'utf8');
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('probes an enforcing container and reports a denyNet boundary', async () => {
    expect(await canApplyWindowsMxcSandbox(process.execPath)).toBe(true);
    expect(await denyNetBoundaryAvailable()).toBe(true);
  });

  it('runs denyNet work confined to its working folder', async () => {
    await writeFile(
      join(work, 'confined.mjs'),
      `import fs from 'node:fs';
const out = {};
try { fs.writeFileSync('written.txt', 'ok'); out.write = 'ok'; } catch (e) { out.write = e.code; }
try { out.secret = fs.readFileSync(${JSON.stringify(secret)}, 'utf8'); } catch (e) { out.secret = e.code; }
try { await fetch('https://registry.npmjs.org/-/ping'); out.net = 'reached'; } catch (e) { out.net = 'blocked'; }
console.log(JSON.stringify(out));
process.exit(5);
`,
      'utf8',
    );
    const started = performance.now();
    const result = await runInSandbox({
      entry: 'confined.mjs',
      cwd: work,
      input: '',
      denyNet: true,
      timeoutMs: 30_000,
    });
    const elapsed = Math.round(performance.now() - started);
    expect(result.exitCode).toBe(5);
    const out = JSON.parse(result.stdout.trim());
    expect(out.write).toBe('ok');
    expect(out.secret).not.toContain('never-readable');
    expect(out.net).toBe('blocked');
    expect(await readFile(join(work, 'written.txt'), 'utf8')).toBe('ok');
    console.info(`[mxc-it] confined denyNet run took ${elapsed}ms`);
  });

  it('holds without the permission model or the JS network neutralizer', async () => {
    const listener = createServer((socket) => socket.end('pong')).listen(0, '127.0.0.1');
    await new Promise((resolve) => listener.once('listening', resolve));
    const { port } = listener.address() as AddressInfo;
    const probe = `const fs = require('node:fs'); const net = require('node:net');
const out = {};
try { fs.readFileSync(${JSON.stringify(secret)}); out.secret = 'read'; } catch (e) { out.secret = e.code; }
try { fs.readdirSync(require('node:os').homedir()); out.home = 'listed'; } catch (e) { out.home = e.code; }
const s = net.connect(${port}, '127.0.0.1');
const done = (v) => { out.loopback = v; console.log(JSON.stringify(out)); process.exit(0); };
s.on('data', () => done('reached')); s.on('error', (e) => done(e.code)); setTimeout(() => done('timeout'), 3000);`;
    const executor = resolveMxcExecutor();
    if (!executor) throw new Error('GEZEL_MXC_EXEC must resolve');
    const { command, args } = wrapForWindowsMxc(executor, {
      command: process.execPath,
      args: [...MXC_NODE_PATH_FLAGS, '-e', probe],
      cwd: work,
      readwritePaths: [work],
      readonlyPaths: [process.execPath],
      env: { USERPROFILE: process.env.USERPROFILE ?? '' },
      denyNet: true,
    });
    const stdout = await new Promise<string>((resolve) => {
      const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'inherit'] });
      let text = '';
      child.stdout.on('data', (chunk: Buffer) => {
        text += chunk.toString('utf8');
      });
      child.on('close', () => resolve(text));
    });
    listener.close();
    expect(JSON.parse(stdout.trim())).toEqual({
      secret: 'EPERM',
      home: 'EPERM',
      loopback: 'EACCES',
    });
  });

  it('takes the container down when the runner times out', async () => {
    const pidFile = join(work, 'hang.pid');
    await writeFile(
      join(work, 'hang.mjs'),
      `import fs from 'node:fs';
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setInterval(() => {}, 1000);
`,
      'utf8',
    );
    const result = await runInSandbox({
      entry: 'hang.mjs',
      cwd: work,
      input: '',
      denyNet: true,
      timeoutMs: 3_000,
    });
    expect(result.timedOut).toBe(true);
    const pid = Number(await readFile(pidFile, 'utf8'));
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('carries SDK calls, replies and notifications over stdio', async () => {
    const result = await runScript({ useMxc: true });
    expect(result.exitCode).toBe(0);
    expect(result.requests).toEqual([{ method: 'fs.read', params: { path: 'greeting.txt' } }]);
    expect(result.notifications).toContainEqual({
      method: 'script.output',
      params: { value: { text: 'hello from the host', input: { n: 42 } } },
    });
    expect(result.stdout).toContain('unterminated printed line');
    expect(result.stdout).not.toContain('gezel-rpc');
  });

  it('keeps the fd-3 transport for the same SDK when MXC is off', async () => {
    const result = await runScript({ useMxc: false });
    expect(result.exitCode).toBe(0);
    expect(result.requests).toEqual([{ method: 'fs.read', params: { path: 'greeting.txt' } }]);
    expect(result.notifications).toContainEqual({
      method: 'script.output',
      params: { value: { text: 'hello from the host', input: { n: 42 } } },
    });
  });

  it('keeps 500 calls and a megabyte of output apart on one pipe', async () => {
    const result = await runScript({
      useMxc: true,
      source: `import { gezel } from '@bendyline/gezel-sdk';
const line = 'x'.repeat(2000);
let total = 0;
for (let i = 0; i < 500; i++) {
  console.log(line);
  total += Number(await gezel.fs.read('n' + i));
}
gezel.output({ total });
`,
      reply: (params) => String((params as { path: string }).path.slice(1)),
    });
    expect(result.exitCode).toBe(0);
    expect(result.requests).toHaveLength(500);
    expect(result.notifications).toContainEqual({
      method: 'script.output',
      params: { value: { total: 124_750 } },
    });
    expect(result.stdout.length).toBeGreaterThanOrEqual(500 * 2_001);
    expect(result.stdout).not.toContain('gezel-rpc');
  }, 60_000);

  it('exits normally when a script never calls the host, although stdin stays open', async () => {
    const result = await runScript({
      useMxc: true,
      source: `import { gezel } from '@bendyline/gezel-sdk';
console.log('quiet ' + gezel.runId);
`,
    });
    expect(result).toMatchObject({ exitCode: 0, timedOut: false });
    expect(result.stdout).toContain('quiet');
  });

  it('refuses, before starting anything, a run whose folder contains the home folder', async () => {
    const result = await runInSandbox({ entry: 'x.mjs', cwd: homedir(), input: '', denyNet: true });
    expect(result.exitCode).toBe(126);
    expect(result.stderr).toMatch(/\[sandbox error\] refusing to grant .*: it contains/);
  });

  it.each([0, 20, 100])('leaves no Node behind when cancelled %ims into a run', async (delayMs) => {
    const marker = `abort-${delayMs}-${Date.now()}`;
    await writeFile(join(work, `${marker}.mjs`), 'setInterval(() => {}, 1000);\n', 'utf8');
    const controller = new AbortController();
    const pending = runInSandbox({
      entry: `${marker}.mjs`,
      cwd: work,
      input: '',
      denyNet: true,
      timeoutMs: 30_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), delayMs);
    expect((await pending).exitCode).toBe(1);
    await sleep(1_000);
    expect(nodeProcessesMatching(marker)).toBe(0);
  });

  it('takes the container down with a daemon that dies outright', async () => {
    const pidFile = join(work, 'orphan.pid');
    await writeFile(
      join(work, 'orphan.mjs'),
      `import fs from 'node:fs';
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setInterval(() => {}, 1000);
`,
      'utf8',
    );
    const executor = resolveMxcExecutor();
    if (!executor) throw new Error('GEZEL_MXC_EXEC must resolve');
    const { command, args } = wrapForWindowsMxc(executor, {
      command: process.execPath,
      args: [...MXC_NODE_PATH_FLAGS, join(work, 'orphan.mjs')],
      cwd: work,
      readwritePaths: [work],
      readonlyPaths: [process.execPath],
      env: {},
      denyNet: true,
    });
    // Stands in for gezeld: spawns the launcher the way runInSandbox does,
    // then is terminated without a chance to clean up.
    const daemon = spawn(
      process.execPath,
      [
        '-e',
        `require('node:child_process').spawn(${JSON.stringify(command)}, ${JSON.stringify(args)}, { stdio: 'ignore' }); setInterval(() => {}, 1000);`,
      ],
      { stdio: 'ignore' },
    );
    for (let i = 0; i < 100 && !existsSync(pidFile); i++) await sleep(100);
    const pid = Number(await readFile(pidFile, 'utf8'));
    daemon.kill('SIGKILL');
    await sleep(1_500);
    expect(isAlive(pid)).toBe(false);
  });

  it('runs a burst through the slot cap without failures', async () => {
    const saved = process.env[MXC_MAX_CONCURRENT_ENV];
    process.env[MXC_MAX_CONCURRENT_ENV] = '4';
    try {
      await writeFile(join(work, 'burst.mjs'), "console.log('ok');\n", 'utf8');
      const results = await Promise.all(
        Array.from({ length: 12 }, () =>
          runInSandbox({
            entry: 'burst.mjs',
            cwd: work,
            input: '',
            denyNet: true,
            timeoutMs: 30_000,
          }),
        ),
      );
      expect(results.map((r) => [r.exitCode, r.stdout.trim()])).toEqual(
        Array.from({ length: 12 }, () => [0, 'ok']),
      );
    } finally {
      if (saved === undefined) delete process.env[MXC_MAX_CONCURRENT_ENV];
      else process.env[MXC_MAX_CONCURRENT_ENV] = saved;
    }
  }, 60_000);

  it("resolves a package's own dependencies through pnpm's junction layout", async () => {
    // node_modules/a → .pnpm/a@1/node_modules/a, which requires b, reachable
    // only beside it inside .pnpm — the layout `npm_install` produces.
    const app = await mkdtemp(join(work, 'pnpm-'));
    const store = join(app, 'node_modules', '.pnpm');
    const pkg = (name: string) => join(store, `${name}@1.0.0`, 'node_modules', name);
    for (const [name, body] of [
      ['a', "module.exports = 'a+' + require('b');\n"],
      ['b', "module.exports = 'b';\n"],
    ] as const) {
      await mkdir(pkg(name), { recursive: true });
      await writeFile(join(pkg(name), 'package.json'), `{"name":"${name}","main":"index.js"}`);
      await writeFile(join(pkg(name), 'index.js'), body);
    }
    await symlink(pkg('b'), join(store, 'a@1.0.0', 'node_modules', 'b'), 'junction');
    await symlink(pkg('a'), join(app, 'node_modules', 'a'), 'junction');
    await writeFile(join(app, 'use.mjs'), "import a from 'a';\nconsole.log(a);\n", 'utf8');

    const result = await runInSandbox({ entry: 'use.mjs', cwd: app, input: '', denyNet: true });
    expect(result).toMatchObject({ exitCode: 0, stdout: 'a+b\n' });
  });

  it('finds a verified launcher under the gezel home when no env var names one', async () => {
    const executor = resolveMxcExecutor();
    const arch = mxcArch();
    if (!executor || !arch) throw new Error('GEZEL_MXC_EXEC and a known arch are required');
    const home = await mkdtemp(join(root, 'home-'));
    await mkdir(mxcInstallDir(home), { recursive: true });
    await copyFile(executor, mxcInstalledExecutor(home));
    const saved = process.env[MXC_EXEC_ENV];
    delete process.env[MXC_EXEC_ENV];
    resetWindowsMxcProbeForTests();
    try {
      setWindowsMxcHome(home);
      expect(resolveMxcExecutor()).toBeNull();
      await writeFile(
        join(mxcInstallDir(home), MXC_VERIFIED_SENTINEL),
        JSON.stringify({
          engine: 'mxc',
          version: MXC_VERSION,
          arch,
          sha256: MXC_EXECUTOR_SHA256[arch],
          source: 'npm-download',
          verifiedAt: new Date().toISOString(),
        }),
      );
      expect(resolveMxcExecutor()).toBe(mxcInstalledExecutor(home));
      expect(await windowsMxcLauncherForRun(process.execPath)).toBe(mxcInstalledExecutor(home));
    } finally {
      if (saved !== undefined) process.env[MXC_EXEC_ENV] = saved;
      resetWindowsMxcProbeForTests();
    }
  });

  it('follows the Settings switch without a restart', async () => {
    await writeFile(join(work, 'switch.mjs'), "console.log('ran');\n", 'utf8');
    const run = () =>
      runInSandbox({ entry: 'switch.mjs', cwd: work, input: '', denyNet: true, timeoutMs: 30_000 });
    try {
      setWindowsMxcEnabled(false);
      expect(windowsMxcState(process.execPath)).toEqual({
        state: 'disabled',
        reason: 'turned off in Settings',
      });
      expect((await run()).exitCode).toBe(126);
      setWindowsMxcEnabled(true);
      expect(await run()).toMatchObject({ exitCode: 0, stdout: 'ran\n' });
      expect(windowsMxcState(process.execPath).state).toBe('active');
    } finally {
      setWindowsMxcEnabled(true);
    }
  });

  it('probes again when the launcher changes on disk, and fails closed if it broke', async () => {
    const executor = resolveMxcExecutor();
    if (!executor) throw new Error('GEZEL_MXC_EXEC must resolve');
    const copy = join(root, 'wxc-exec-copy.exe');
    await copyFile(executor, copy);
    const saved = process.env[MXC_EXEC_ENV];
    process.env[MXC_EXEC_ENV] = copy;
    resetWindowsMxcProbeForTests();
    try {
      expect(await windowsMxcLauncherForRun(process.execPath)).toBe(copy);
      const later = new Date(Date.now() + 60_000);
      await utimes(copy, later, later);
      expect(await windowsMxcLauncherForRun(process.execPath)).toBe(copy);
      await copyFile(join(process.env.SYSTEMROOT ?? 'C:\\Windows', 'System32', 'whoami.exe'), copy);
      expect(await windowsMxcLauncherForRun(process.execPath)).toBeNull();
      expect(windowsMxcState(process.execPath).state).toBe('unavailable');
    } finally {
      if (saved !== undefined) process.env[MXC_EXEC_ENV] = saved;
      resetWindowsMxcProbeForTests();
    }
  }, 60_000);
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function nodeProcessesMatching(marker: string): number {
  const out = execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      `@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*${marker}*' }).Count`,
    ],
    { encoding: 'utf8' },
  );
  return Number(out.trim());
}

async function runScript({
  useMxc,
  source = `import { gezel } from '@bendyline/gezel-sdk';
const text = await gezel.fs.read('greeting.txt');
process.stdout.write('unterminated ');
console.log('printed line');
gezel.output({ text, input: gezel.input });
`,
  reply = () => 'hello from the host',
}: {
  useMxc: boolean;
  source?: string;
  reply?: (params: unknown) => unknown;
}) {
  const saved = process.env[MXC_EXEC_ENV];
  if (!useMxc) delete process.env[MXC_EXEC_ENV];
  resetWindowsMxcProbeForTests();
  const requests: Array<{ method: string; params: unknown }> = [];
  const notifications: Array<{ method: string; params: unknown }> = [];
  const options: ScriptExecutionOptions = {
    source,
    scriptName: 'mxc-stdio-fixture',
    init: {
      runId: 'run-mxc',
      projectId: 'default',
      input: { n: 42 },
      engagementMode: 'off',
      engagementFlags: { llmAllowed: false },
    },
    timeoutMs: 30_000,
    // Without MXC there is no Windows boundary; trusted provenance is the
    // only lane that still runs, which is what exercises fd 3 here.
    provenanceTrusted: !useMxc,
    trustedReadOnlyStandard: false,
    onRequest: async (method, params) => {
      requests.push({ method, params });
      return reply(params);
    },
    onNotification: (method, params) => {
      notifications.push({ method, params });
    },
    onStdout: () => undefined,
    onStderr: () => undefined,
  };
  try {
    const result = await new NodeScriptExecutor().execute(options);
    return { ...result, requests, notifications };
  } finally {
    if (saved !== undefined) process.env[MXC_EXEC_ENV] = saved;
    resetWindowsMxcProbeForTests();
  }
}
