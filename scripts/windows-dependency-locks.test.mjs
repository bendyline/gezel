import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  electronLockCandidates,
  inspectWindowsDependencyLocks,
} from './windows-dependency-locks.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'gezel-windows-lock-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'scripts'), { recursive: true });
  await writeFile(join(root, 'scripts', 'find-windows-file-locks.ps1'), '');
  return root;
}

test('finds Electron assets that make pnpm package replacement lock-sensitive', async (t) => {
  const root = await fixture(t);
  const asar = join(
    root,
    'node_modules',
    '.pnpm',
    'electron@43.2.0_supports-color@8.1.1',
    'node_modules',
    'electron',
    'dist',
    'resources',
    'default_app.asar',
  );
  await mkdir(join(asar, '..'), { recursive: true });
  await writeFile(asar, 'fixture');
  assert.deepEqual(electronLockCandidates(root), [asar]);
});

test('normalizes Restart Manager output for an actionable install failure', async (t) => {
  const root = await fixture(t);
  const asar = join(
    root,
    'node_modules',
    '.pnpm',
    'electron@43.2.0',
    'node_modules',
    'electron',
    'dist',
    'resources',
    'default_app.asar',
  );
  await mkdir(join(asar, '..'), { recursive: true });
  await writeFile(asar, 'fixture');

  const owners = inspectWindowsDependencyLocks(root, {
    platform: 'win32',
    spawnSyncFn: () => ({
      status: 0,
      stdout: JSON.stringify({
        ProcessId: 27956,
        ProcessName: 'Code',
        AppName: 'Visual Studio Code',
      }),
    }),
  });
  assert.deepEqual(owners, [
    {
      file: asar,
      processId: 27956,
      processName: 'Code',
      appName: 'Visual Studio Code',
    },
  ]);
});

test('ignores unavailable lock diagnostics instead of blocking pnpm', async (t) => {
  const root = await fixture(t);
  const asar = join(
    root,
    'node_modules',
    '.pnpm',
    'electron@43.2.0',
    'node_modules',
    'electron',
    'dist',
    'resources',
    'default_app.asar',
  );
  await mkdir(join(asar, '..'), { recursive: true });
  await writeFile(asar, 'fixture');
  assert.deepEqual(
    inspectWindowsDependencyLocks(root, {
      platform: 'win32',
      spawnSyncFn: () => ({ status: 1, stdout: '', stderr: 'unavailable' }),
    }),
    [],
  );
});

test(
  'the Windows probe identifies a real exclusive file handle',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const root = await fixture(t);
    const lockedFile = join(root, 'locked.asar');
    await writeFile(lockedFile, 'fixture');
    const holdCommand = [
      "$stream=[IO.File]::Open($env:GEZEL_TEST_LOCK_FILE,'Open','Read','None')",
      'Write-Output ready',
      'Start-Sleep -Seconds 30',
    ].join('; ');
    const holder = spawn(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', holdCommand],
      {
        env: { ...process.env, GEZEL_TEST_LOCK_FILE: lockedFile },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    try {
      await new Promise((resolveReady, rejectReady) => {
        holder.once('error', rejectReady);
        holder.stdout.once('data', resolveReady);
        holder.once('exit', (code) =>
          rejectReady(new Error(`lock holder exited early: ${code}`)),
        );
      });

      const probeScript = fileURLToPath(
        new URL('./find-windows-file-locks.ps1', import.meta.url),
      );
      const result = spawnSync(
        'powershell.exe',
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          probeScript,
          '-Path',
          lockedFile,
        ],
        { encoding: 'utf8', windowsHide: true },
      );
      assert.equal(result.status, 0, result.stderr);
      const owners = JSON.parse(result.stdout);
      assert.ok(owners, 'probe must report an owner or its safe generic fallback');
    } finally {
      if (holder.exitCode === null) {
        holder.kill('SIGKILL');
        await once(holder, 'exit');
      }
    }
  },
);
