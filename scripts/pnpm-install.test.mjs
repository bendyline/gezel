import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { runBootstrap } from './bootstrap.mjs';
import { dependencyLeasePath, withDependencyReadLease } from './dependency-lease.mjs';
import {
  dependencyStatus,
  parsePnpmInstallArgs,
  pnpmInstallLockPath,
  runPnpmFetchChild,
  runPnpmInstallChild,
  runPreparedFrozenInstall,
  runSerializedPnpmInstall,
  withPnpmInstallLock,
  workspaceDependenciesReady,
} from './pnpm-install.mjs';
import {
  runNodeWithDependencyReadLease,
  runWithDependencyReadLease,
} from './run-with-dependency-lease.mjs';
import { parseWorkspaceValidationArgs, runWorkspaceValidation } from './validate-workspace.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'gezel-pnpm-install-test-'));
  const leaseRoot = await dependencyLeasePath(root);
  t.after(async () => {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(leaseRoot, { recursive: true, force: true }),
    ]);
  });
  return root;
}

test('serializes dependency mutations for one checkout', async (t) => {
  const root = await fixture(t);
  const events = [];
  let releaseFirst;
  let markStarted;
  const started = new Promise((resolveStarted) => {
    markStarted = resolveStarted;
  });
  const gate = new Promise((resolveGate) => {
    releaseFirst = resolveGate;
  });

  const first = withPnpmInstallLock(
    root,
    async () => {
      events.push('first:start');
      markStarted();
      await gate;
      events.push('first:end');
    },
    { timeoutMs: 2_000, pollMs: 10 },
  );
  await started;
  const second = withPnpmInstallLock(
    root,
    async () => {
      events.push('second:start');
    },
    { timeoutMs: 2_000, pollMs: 10 },
  );

  await new Promise((resolveWait) => setTimeout(resolveWait, 30));
  assert.deepEqual(events, ['first:start']);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ['first:start', 'first:end', 'second:start']);
});

test('allows concurrent dependency readers and makes a mutation wait', async (t) => {
  const root = await fixture(t);
  const events = [];
  let releaseReaders;
  let readersStarted = 0;
  let markReadersStarted;
  const readersReady = new Promise((resolveReaders) => {
    markReadersStarted = resolveReaders;
  });
  const gate = new Promise((resolveGate) => {
    releaseReaders = resolveGate;
  });
  const reader = (name) =>
    withDependencyReadLease(
      root,
      async () => {
        events.push(`${name}:start`);
        readersStarted += 1;
        if (readersStarted === 2) markReadersStarted();
        await gate;
        events.push(`${name}:end`);
      },
      { timeoutMs: 2_000, pollMs: 10 },
    );

  const readers = [reader('reader-1'), reader('reader-2')];
  await readersReady;
  const mutation = withPnpmInstallLock(root, async () => events.push('mutation'), {
    timeoutMs: 2_000,
    pollMs: 10,
  });
  await new Promise((resolveWait) => setTimeout(resolveWait, 30));
  assert.equal(events.includes('mutation'), false);
  releaseReaders();
  await Promise.all([...readers, mutation]);
  assert.deepEqual(new Set(events.slice(0, 2)), new Set(['reader-1:start', 'reader-2:start']));
  assert.equal(events.at(-1), 'mutation');
});

test('refuses to upgrade an inherited read lease to a dependency mutation', async (t) => {
  const root = await fixture(t);
  await withDependencyReadLease(root, async ({ leaseEnv }) => {
    await assert.rejects(
      withPnpmInstallLock(root, async () => {}, { env: leaseEnv }),
      /Cannot upgrade a live dependency read lease/,
    );
  });
});

test('allows a mutation descendant to re-enter its live checkout lease', async (t) => {
  const root = await fixture(t);
  const events = [];

  await withPnpmInstallLock(root, async ({ leaseEnv }) => {
    events.push('outer:start');
    await withPnpmInstallLock(
      root,
      async () => {
        events.push('inner');
      },
      { env: leaseEnv, timeoutMs: 100, pollMs: 10 },
    );
    events.push('outer:end');
  });

  assert.deepEqual(events, ['outer:start', 'inner', 'outer:end']);
});

test('recovers an orphaned dependency mutation lease', async (t) => {
  const root = await fixture(t);
  const lockDir = join(await pnpmInstallLockPath(root), 'writer');
  await mkdir(lockDir, { recursive: true });
  await writeFile(
    join(lockDir, 'owner.json'),
    JSON.stringify({ token: 'orphan', pid: 2_147_483_647, command: 'old install' }),
  );
  let entered = false;
  await withPnpmInstallLock(
    root,
    async () => {
      entered = true;
    },
    { timeoutMs: 2_000, pollMs: 10 },
  );
  assert.equal(entered, true);
});

test('missing-dependency install is a no-op when another task completed it', async (t) => {
  const root = await fixture(t);
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ name: 'fixture', version: '1.0.0' }),
  );
  await mkdir(join(root, 'node_modules', '.pnpm'), { recursive: true });
  await writeFile(join(root, 'node_modules', '.modules.yaml'), 'layoutVersion: 5\n');
  await writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  await writeFile(join(root, 'node_modules', '.pnpm', 'lock.yaml'), 'lockfileVersion: 9\n');
  await writeFile(
    join(root, 'node_modules', '.pnpm-workspace-state-v1.json'),
    JSON.stringify({
      lastValidatedTimestamp: Date.now() + 10_000,
      projects: { [root]: { name: 'fixture', version: '1.0.0' } },
    }),
  );
  const binSuffix = process.platform === 'win32' ? '.cmd' : '';
  const viteBin = `vite${binSuffix}`;
  const vitePath = join(root, 'packages', 'ui', 'node_modules', '.bin', viteBin);
  await mkdir(join(root, 'packages', 'ui', 'node_modules', '.bin'), { recursive: true });
  await writeFile(vitePath, '');
  const electronBin = `electron${binSuffix}`;
  const electronPath = join(root, 'packages', 'app', 'node_modules', '.bin', electronBin);
  await mkdir(join(root, 'packages', 'app', 'node_modules', '.bin'), { recursive: true });
  await writeFile(electronPath, '');
  const code = await runSerializedPnpmInstall({
    repoRoot: root,
    ifMissing: true,
    spawnPnpmFn: () => {
      throw new Error('pnpm should not start when another bootstrap completed the install');
    },
  });
  assert.equal(code, 0);
});

test('bootstrap diagnoses incomplete dependencies without launching an installer', async () => {
  const messages = [];
  const code = runBootstrap({
    repoRoot: 'unused',
    statusFn: () => ({
      usable: false,
      markersReady: false,
      missingLinks: [],
      workspaceStructureIssue: null,
    }),
    reportFn: () => messages.push('diagnosed'),
    error: (message) => messages.push(message),
  });
  assert.equal(code, 1);
  const source = await readFile(new URL('bootstrap.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /spawnSync|runSerializedPnpmInstall|pnpm-install\.mjs'\),/);
  assert.equal(messages[0], 'diagnosed');
  assert.match(messages.join('\n'), /no install was started/);
});

test('does not mistake a partial virtual store for a complete workspace install', async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, 'node_modules', '.pnpm'), { recursive: true });
  assert.equal(workspaceDependenciesReady(root), false);
});

test('installs a missing direct dependency link only in the affected workspace package', async (t) => {
  const root = await fixture(t);
  const binSuffix = process.platform === 'win32' ? '.cmd' : '';
  await mkdir(join(root, 'node_modules', '.pnpm'), { recursive: true });
  await writeFile(join(root, 'node_modules', '.modules.yaml'), 'layoutVersion: 5\n');
  await mkdir(join(root, 'packages', 'ui', 'node_modules', '.bin'), { recursive: true });
  await writeFile(join(root, 'packages', 'ui', 'node_modules', '.bin', `vite${binSuffix}`), '');
  await mkdir(join(root, 'packages', 'app', 'node_modules', '.bin'), { recursive: true });
  await writeFile(
    join(root, 'packages', 'app', 'node_modules', '.bin', `electron${binSuffix}`),
    '',
  );
  await mkdir(join(root, 'packages', 'client'), { recursive: true });
  await writeFile(
    join(root, 'packages', 'client', 'package.json'),
    JSON.stringify({ name: '@bendyline/gezel-client', dependencies: { undici: '8.9.0' } }),
  );

  let childArgs;
  const code = await runSerializedPnpmInstall({
    repoRoot: root,
    ifMissing: true,
    dependencyLockProbeFn: () => [],
    spawnPnpmFn: (args) => {
      childArgs = args;
      const child = new EventEmitter();
      child.pid = 2_147_483_647;
      child.killed = false;
      child.kill = () => true;
      queueMicrotask(() => child.emit('close', 0, null));
      return child;
    },
  });

  assert.equal(code, 0);
  assert.deepEqual(childArgs, [
    'install',
    '--config.optimistic-repeat-install=false',
    '--filter',
    './packages/client',
    '--offline',
    '--frozen-lockfile',
  ]);
});

test('a failed fetch leaves node_modules untouched', async (t) => {
  const root = await fixture(t);
  let installCalled = false;
  const code = await runPreparedFrozenInstall({
    repoRoot: root,
    runFetchFn: async () => 1,
    runInstallFn: async () => {
      installCalled = true;
      return 0;
    },
  });
  assert.equal(code, 1);
  assert.equal(installCalled, false);
});

test('fetch uses disposable modules paths outside the live workspace tree', async (t) => {
  const root = await fixture(t);
  let invocation;
  const code = await runPnpmFetchChild({
    repoRoot: root,
    stagingParent: dirname(root),
    spawnPnpmFn: (args, options) => {
      invocation = { args, options };
      const child = new EventEmitter();
      child.pid = 2_147_483_647;
      child.killed = false;
      child.kill = () => true;
      queueMicrotask(() => child.emit('close', 0, null));
      return child;
    },
  });

  assert.equal(code, 0);
  assert.equal(invocation.options.cwd, root);
  const modulesDir = invocation.args.at(invocation.args.indexOf('--modules-dir') + 1);
  const virtualStoreDir = invocation.args.at(invocation.args.indexOf('--virtual-store-dir') + 1);
  assert.notEqual(modulesDir, join(root, 'node_modules'));
  assert.equal(virtualStoreDir, join(modulesDir, '.pnpm'));
  assert.equal(relative(root, modulesDir).startsWith('..'), true);
  assert.equal(existsSync(dirname(modulesDir)), false);
});

test('only the explicit repair path disables the purge interlock', async (t) => {
  const root = await fixture(t);
  const installs = [];
  const runInstallFn = async ({ args }) => {
    installs.push(args);
    return 0;
  };
  await runPreparedFrozenInstall({
    repoRoot: root,
    runFetchFn: async () => 0,
    runInstallFn,
  });
  await runPreparedFrozenInstall({
    repoRoot: root,
    allowPurge: true,
    runFetchFn: async () => 0,
    runInstallFn,
  });
  assert.equal(installs[0].includes('--config.confirm-modules-purge=false'), false);
  assert.equal(installs[1].includes('--config.confirm-modules-purge=false'), true);
});

test('reports stale workspace structure as metadata without claiming tools are unusable', async (t) => {
  const root = await fixture(t);
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ name: 'fixture', version: '1.0.0' }),
  );
  await mkdir(join(root, 'node_modules'), { recursive: true });
  await writeFile(
    join(root, 'node_modules', '.pnpm-workspace-state-v1.json'),
    JSON.stringify({ lastValidatedTimestamp: 1, projects: {} }),
  );
  await writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  const status = dependencyStatus(root);
  assert.match(status.workspaceStructureIssue, /project count changed/);
  assert.match(status.installedLockfileIssue, /installed dependency lock is missing/);
  assert.match(status.lockfileValidationIssue, /timestamp is newer/);
});

test('detects an installed lock that differs from the committed lockfile', async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, 'node_modules', '.pnpm'), { recursive: true });
  await writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n# wanted\n');
  await writeFile(join(root, 'node_modules', '.pnpm', 'lock.yaml'), 'lockfileVersion: 9\n');
  assert.match(dependencyStatus(root).installedLockfileIssue, /differs from pnpm-lock/);
});

test('stops before pnpm when Windows reports a locked dependency asset', async (t) => {
  const root = await fixture(t);
  const code = await runSerializedPnpmInstall({
    repoRoot: root,
    dependencyLockProbeFn: () => [
      {
        appName: 'Visual Studio Code',
        processName: 'Code',
        processId: 123,
        file: 'default_app.asar',
      },
    ],
    spawnPnpmFn: () => {
      throw new Error('pnpm must not start while a dependency file is locked');
    },
  });
  assert.equal(code, 1);
});

test('observes a pnpm child that exits while lock metadata is being written', async (t) => {
  const root = await fixture(t);
  const code = await runSerializedPnpmInstall({
    repoRoot: root,
    spawnPnpmFn: () => {
      const child = new EventEmitter();
      child.pid = 2_147_483_647;
      child.killed = false;
      child.kill = () => true;
      queueMicrotask(() => child.emit('close', 0, null));
      return child;
    },
  });
  assert.equal(code, 0);
});

test('marks pnpm children as serialized so the dev-preinstall guard admits them', async () => {
  let childEnv;
  const code = await runPnpmInstallChild({
    env: { PATH: 'test-path' },
    spawnPnpmFn: (_args, options) => {
      childEnv = options.env;
      const child = new EventEmitter();
      child.pid = 2_147_483_647;
      child.killed = false;
      child.kill = () => true;
      queueMicrotask(() => child.emit('close', 0, null));
      return child;
    },
  });
  assert.equal(code, 0);
  assert.equal(childEnv.GEZEL_SERIALIZED_PNPM_INSTALL, '1');
  assert.equal(childEnv.PATH, 'test-path');
});

test('parses wrapper-only flags without leaking them to pnpm', () => {
  assert.deepEqual(parsePnpmInstallArgs(['--if-missing', '--', '--frozen-lockfile']), {
    args: ['--frozen-lockfile'],
    confirmRepair: false,
    repair: false,
    status: false,
  });
  assert.deepEqual(parsePnpmInstallArgs(['--repair', '--confirm-repair']), {
    args: [],
    confirmRepair: true,
    repair: true,
    status: false,
  });
});

test('non-interactive dependency repair requires an explicit confirmation flag', () => {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('pnpm-install.mjs', import.meta.url)), '--repair'],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /dependency repair was not authorized/);
});

test('repository command wrapper passes a live read lease to pnpm', async (t) => {
  const root = await fixture(t);
  let invocation;
  const code = await runWithDependencyReadLease({
    repoRoot: root,
    script: 'lint:unleased',
    spawnPnpmFn: (args, options) => {
      invocation = { args, env: options.env };
      const child = new EventEmitter();
      child.pid = 2_147_483_647;
      child.killed = false;
      child.kill = () => true;
      queueMicrotask(() => child.emit('close', 0, null));
      return child;
    },
  });
  assert.equal(code, 0);
  assert.deepEqual(invocation.args, ['run', 'lint:unleased']);
  assert.equal(invocation.env.GEZEL_DEPENDENCY_LEASE_MODE, 'read');
});

test('repository command wrapper forwards script arguments without a literal separator', async (t) => {
  const root = await fixture(t);
  const invocations = [];
  const spawnPnpmFn = (args) => {
    invocations.push(args);
    const child = new EventEmitter();
    child.pid = 2_147_483_647;
    child.killed = false;
    child.kill = () => true;
    queueMicrotask(() => child.emit('close', 0, null));
    return child;
  };

  for (const args of [['--list'], ['--', '--list']]) {
    const code = await runWithDependencyReadLease({
      repoRoot: root,
      script: 'eval:all:unleased',
      args,
      spawnPnpmFn,
    });
    assert.equal(code, 0);
  }

  assert.deepEqual(invocations, [
    ['run', 'eval:all:unleased', '--list'],
    ['run', 'eval:all:unleased', '--list'],
  ]);
});

test('direct-node repository wrapper runs eval entries without a nested pnpm process', async (t) => {
  const root = await fixture(t);
  let invocation;
  const code = await runNodeWithDependencyReadLease({
    repoRoot: root,
    entry: 'evals/src/bin/run.ts',
    args: ['--', '--list'],
    tsxImport: 'tsx-test-entry',
    spawnNodeFn: (command, args, options) => {
      invocation = { command, args, options };
      const child = new EventEmitter();
      child.pid = 2_147_483_647;
      child.killed = false;
      child.kill = () => true;
      queueMicrotask(() => child.emit('close', 0, null));
      return child;
    },
  });

  assert.equal(code, 0);
  assert.equal(invocation.command, process.execPath);
  assert.deepEqual(invocation.args, [
    '--import',
    'tsx-test-entry',
    join(root, 'evals/src/bin/run.ts'),
    '--list',
  ]);
  assert.equal(invocation.options.env.GEZEL_DEPENDENCY_LEASE_MODE, 'read');
});

test('direct-node wrapper waits for graceful signal cleanup before exiting', async (t) => {
  const temp = await fixture(t);
  const entry = join(temp, 'signal-child.ts');
  const ready = join(temp, 'ready');
  const finalized = join(temp, 'finalized');
  await writeFile(
    entry,
    `import { writeFile } from 'node:fs/promises';
const [ready, finalized] = process.argv.slice(2);
const hold = setInterval(() => {}, 1000);
process.on('SIGINT', () => {
  setTimeout(() => void writeFile(finalized, 'done').then(() => { process.exitCode = 7; clearInterval(hold); }), 75);
});
void writeFile(ready, 'ready');
`,
  );
  const wrapper = spawn(
    process.execPath,
    [
      fileURLToPath(new URL('run-with-dependency-lease.mjs', import.meta.url)),
      '--direct-node',
      entry,
      ready,
      finalized,
    ],
    {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  );
  let stderr = '';
  wrapper.stderr.setEncoding('utf8');
  wrapper.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  t.after(() => {
    if (wrapper.exitCode === null && !wrapper.killed) wrapper.kill('SIGKILL');
  });

  const deadline = Date.now() + 5_000;
  while (!existsSync(ready) && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  assert.equal(existsSync(ready), true, `signal child did not become ready: ${stderr}`);
  wrapper.kill('SIGINT');
  const exit = await new Promise((resolveExit, rejectExit) => {
    wrapper.once('error', rejectExit);
    wrapper.once('close', (code, signal) => resolveExit({ code, signal }));
  });

  assert.deepEqual(exit, { code: 7, signal: null });
  assert.equal(existsSync(finalized), true, 'wrapper exited before child cleanup completed');
});

test('build, test, typecheck, and lint entry points use dependency read leases', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  for (const script of ['build', 'test', 'typecheck', 'lint', 'dev', 'package']) {
    assert.match(pkg.scripts[script], /^node scripts\/run-with-dependency-lease\.mjs /);
  }
});

test('holds one checkout lock across install and validation', async (t) => {
  const root = await fixture(t);
  const events = [];
  let competingMutation;

  const code = await runWorkspaceValidation({
    repoRoot: root,
    install: true,
    runInstallFn: async ({ env }) => {
      events.push('install');
      await withPnpmInstallLock(root, async () => events.push('install:locked'), { env });
      return 0;
    },
    runValidationFn: async ({ env }) => {
      events.push('validate');
      await withPnpmInstallLock(root, async () => events.push('validate:locked'), { env });
      competingMutation = withPnpmInstallLock(root, async () => events.push('competitor'), {
        timeoutMs: 2_000,
        pollMs: 10,
      });
      await new Promise((resolveWait) => setTimeout(resolveWait, 30));
      assert.equal(events.includes('competitor'), false);
      return 0;
    },
  });
  await competingMutation;

  assert.equal(code, 0);
  assert.deepEqual(events, [
    'install',
    'install:locked',
    'validate',
    'validate:locked',
    'competitor',
  ]);
  assert.deepEqual(parseWorkspaceValidationArgs([]), { install: false });
  assert.deepEqual(parseWorkspaceValidationArgs(['--install']), { install: true });
});

test('link and release-update workflows lock config edits and prepare installs safely', async () => {
  for (const script of ['gilde-link.mjs', 'squisq-link.mjs', 'update-gilde.mjs']) {
    const source = await readFile(new URL(script, import.meta.url), 'utf8');
    const lockStart = source.indexOf('withPnpmInstallLock(');
    const lockedWorkspaceRead = source.indexOf("readFile(workspacePath, 'utf8')", lockStart);
    const lockedInstall = source.indexOf('runLockfileRefreshAndInstall({', lockStart);
    assert.notEqual(lockStart, -1, `${script} must acquire the checkout dependency lock`);
    assert.ok(
      lockedWorkspaceRead > lockStart,
      `${script} must read dependency config after acquiring the lock`,
    );
    assert.ok(lockedInstall > lockedWorkspaceRead, `${script} must install while holding the lock`);
  }
});
