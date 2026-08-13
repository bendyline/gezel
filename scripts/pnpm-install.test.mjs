import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  parsePnpmInstallArgs,
  pnpmInstallLockPath,
  runPnpmInstallChild,
  runSerializedPnpmInstall,
  withPnpmInstallLock,
  workspaceDependenciesReady,
} from './pnpm-install.mjs';
import { parseWorkspaceValidationArgs, runWorkspaceValidation } from './validate-workspace.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'gezel-pnpm-install-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
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

test('allows a validation descendant to re-enter its live checkout lock', async (t) => {
  const root = await fixture(t);
  const events = [];

  await withPnpmInstallLock(root, async ({ lockEnv }) => {
    events.push('outer:start');
    await withPnpmInstallLock(
      root,
      async () => {
        events.push('inner');
      },
      { env: lockEnv, timeoutMs: 100, pollMs: 10 },
    );
    events.push('outer:end');
  });

  assert.deepEqual(events, ['outer:start', 'inner', 'outer:end']);
});

test('recovers an orphaned install lock', async (t) => {
  const root = await fixture(t);
  const lockDir = await pnpmInstallLockPath(root);
  await mkdir(lockDir);
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

test('bootstrap rechecks the dependency marker after taking the lock', async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, 'node_modules', '.pnpm'), { recursive: true });
  await writeFile(join(root, 'node_modules', '.modules.yaml'), 'layoutVersion: 5\n');
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

test('does not mistake a partial virtual store for a complete workspace install', async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, 'node_modules', '.pnpm'), { recursive: true });
  assert.equal(workspaceDependenciesReady(root), false);
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
    ifMissing: true,
    args: ['--frozen-lockfile'],
  });
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

test('link and release-update workflows lock config edits together with installs', async () => {
  for (const script of ['gilde-link.mjs', 'squisq-link.mjs', 'update-gilde.mjs']) {
    const source = await readFile(new URL(script, import.meta.url), 'utf8');
    const lockStart = source.indexOf('withPnpmInstallLock(');
    const lockedWorkspaceRead = source.indexOf("readFile(workspacePath, 'utf8')", lockStart);
    const lockedInstall = source.indexOf('runPnpmInstallChild({', lockStart);
    assert.notEqual(lockStart, -1, `${script} must acquire the checkout dependency lock`);
    assert.ok(
      lockedWorkspaceRead > lockStart,
      `${script} must read dependency config after acquiring the lock`,
    );
    assert.ok(lockedInstall > lockedWorkspaceRead, `${script} must install while holding the lock`);
  }
});
