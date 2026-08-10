import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  parsePnpmInstallArgs,
  pnpmInstallLockPath,
  runSerializedPnpmInstall,
  withPnpmInstallLock,
} from './pnpm-install.mjs';

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
  const code = await runSerializedPnpmInstall({
    repoRoot: root,
    ifMissing: true,
    spawnPnpmFn: () => {
      throw new Error('pnpm should not start when another bootstrap completed the install');
    },
  });
  assert.equal(code, 0);
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

test('parses wrapper-only flags without leaking them to pnpm', () => {
  assert.deepEqual(parsePnpmInstallArgs(['--if-missing', '--', '--frozen-lockfile']), {
    ifMissing: true,
    args: ['--frozen-lockfile'],
  });
});
