#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { spawnPnpm } from './pnpm-cli.mjs';
import { inspectWindowsDependencyLocks } from './windows-dependency-locks.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = resolve(scriptsDir, '..');
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const OWNER_GRACE_MS = 30 * 1000;
const SERIALIZED_INSTALL_ENV = 'GEZEL_SERIALIZED_PNPM_INSTALL';

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH' && error?.code !== 'EINVAL';
  }
}

export async function pnpmInstallLockPath(repoRoot) {
  let canonical;
  try {
    canonical = await realpath(repoRoot);
  } catch {
    canonical = resolve(repoRoot);
  }
  if (process.platform === 'win32') canonical = canonical.toLowerCase();
  const key = createHash('sha256').update(canonical).digest('hex').slice(0, 20);
  return join(tmpdir(), `gezel-pnpm-install-${key}.lock`);
}

async function lockSnapshot(lockDir) {
  try {
    const [ownerRaw, lockStat] = await Promise.all([
      readFile(join(lockDir, 'owner.json'), 'utf8').catch(() => null),
      stat(lockDir),
    ]);
    let owner = null;
    try {
      owner = ownerRaw ? JSON.parse(ownerRaw) : null;
    } catch {}
    return { owner, mtimeMs: lockStat.mtimeMs };
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function snapshotIsStale(snapshot, now = Date.now()) {
  if (!snapshot) return false;
  if (!snapshot.owner) return now - snapshot.mtimeMs > OWNER_GRACE_MS;
  const pids = [snapshot.owner.pid, snapshot.owner.childPid].filter(Number.isInteger);
  return pids.length === 0 || pids.every((pid) => !processIsAlive(pid));
}

async function quarantineStaleLock(lockDir, token) {
  const quarantine = `${lockDir}.stale-${token}`;
  try {
    await rename(lockDir, quarantine);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'EACCES' || error?.code === 'EPERM') {
      return false;
    }
    throw error;
  }
  await rm(quarantine, { recursive: true, force: true });
  return true;
}

/** Serialize every operation that can rewrite this checkout's dependency tree. */
export async function withPnpmInstallLock(repoRoot, fn, options = {}) {
  const lockDir = await pnpmInstallLockPath(repoRoot);
  const token = randomUUID();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startedAt = Date.now();
  let announcedWait = false;

  while (true) {
    try {
      await mkdir(lockDir);
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }

    const snapshot = await lockSnapshot(lockDir);
    if (snapshotIsStale(snapshot) && (await quarantineStaleLock(lockDir, token))) continue;
    if (Date.now() - startedAt >= timeoutMs) {
      const owner = snapshot?.owner;
      const detail = owner?.command ? ` (held by ${owner.command}, pid ${owner.pid})` : '';
      throw new Error(`Timed out waiting for the shared pnpm install lock${detail}`);
    }
    if (!announcedWait) {
      const owner = snapshot?.owner;
      const detail = owner?.command ? `: ${owner.command} (pid ${owner.pid})` : '';
      console.log(`[pnpm-install] waiting for another dependency mutation${detail}`);
      announcedWait = true;
    }
    await delay(options.pollMs ?? 250);
  }

  const ownerPath = join(lockDir, 'owner.json');
  const owner = {
    token,
    pid: process.pid,
    childPid: null,
    command: options.command ?? 'pnpm install',
    repoRoot: resolve(repoRoot),
    startedAt: new Date().toISOString(),
  };
  const writeOwner = () => writeFile(ownerPath, `${JSON.stringify(owner, null, 2)}\n`, 'utf8');
  await writeOwner();

  try {
    return await fn({
      setChildPid: async (childPid) => {
        owner.childPid = childPid ?? null;
        await writeOwner();
      },
    });
  } finally {
    const current = await lockSnapshot(lockDir);
    if (current?.owner?.token === token) await rm(lockDir, { recursive: true, force: true });
  }
}

function waitForChild(child) {
  return new Promise((resolveChild, rejectChild) => {
    child.once('error', rejectChild);
    child.once('close', (code, signal) => resolveChild({ code, signal }));
  });
}

export function workspaceDependenciesReady(repoRoot) {
  const binSuffix = process.platform === 'win32' ? '.cmd' : '';
  return (
    existsSync(join(repoRoot, 'node_modules', '.pnpm')) &&
    existsSync(join(repoRoot, 'node_modules', '.modules.yaml')) &&
    existsSync(join(repoRoot, 'packages', 'ui', 'node_modules', '.bin', `vite${binSuffix}`)) &&
    existsSync(
      join(repoRoot, 'packages', 'app', 'node_modules', '.bin', `electron${binSuffix}`),
    )
  );
}

function reportDependencyLockOwners(owners) {
  if (owners.length === 0) return;
  console.error('[pnpm-install] Windows has a generated dependency file open:');
  for (const owner of owners) {
    console.error(
      `  ${owner.appName} (${owner.processName}, pid ${owner.processId}) holds ${owner.file}`,
    );
  }
  console.error('');
  console.error('Close the listed app or workspace, then rerun `pnpm deps:install`.');
  console.error('The install was stopped before pnpm could rewrite node_modules.');
}

/** Run pnpm install after the caller has acquired the checkout mutation lock. */
export async function runPnpmInstallChild(options = {}) {
  const repoRoot = options.repoRoot ?? defaultRepoRoot;
  const args = options.args ?? [];
  const command = `pnpm install${args.length > 0 ? ` ${args.join(' ')}` : ''}`;

  console.log(`[pnpm-install] ${command}`);
  const child = (options.spawnPnpmFn ?? spawnPnpm)(['install', ...args], {
    cwd: repoRoot,
    env: {
      ...(options.env ?? process.env),
      [SERIALIZED_INSTALL_ENV]: '1',
    },
    stdio: 'inherit',
  });
  const completion = waitForChild(child);
  await options.setChildPid?.(child.pid);
  const forwardSigint = () => {
    if (!child.killed) child.kill('SIGINT');
  };
  const forwardSigterm = () => {
    if (!child.killed) child.kill('SIGTERM');
  };
  process.once('SIGINT', forwardSigint);
  process.once('SIGTERM', forwardSigterm);
  try {
    const { code, signal } = await completion;
    if (signal) {
      console.error(`[pnpm-install] pnpm exited on ${signal}`);
      return 1;
    }
    return code ?? 1;
  } finally {
    process.off('SIGINT', forwardSigint);
    process.off('SIGTERM', forwardSigterm);
  }
}

export async function runSerializedPnpmInstall(options = {}) {
  const repoRoot = options.repoRoot ?? defaultRepoRoot;
  const args = options.args ?? [];
  const command = `pnpm install${args.length > 0 ? ` ${args.join(' ')}` : ''}`;

  return withPnpmInstallLock(
    repoRoot,
    async ({ setChildPid }) => {
      if (options.ifMissing && workspaceDependenciesReady(repoRoot)) {
        console.log('[pnpm-install] dependencies already present');
        return 0;
      }

      const lockOwners = (options.dependencyLockProbeFn ?? inspectWindowsDependencyLocks)(repoRoot);
      if (lockOwners.length > 0) {
        reportDependencyLockOwners(lockOwners);
        return 1;
      }

      return runPnpmInstallChild({
        repoRoot,
        args,
        env: options.env,
        spawnPnpmFn: options.spawnPnpmFn,
        setChildPid,
      });
    },
    {
      command,
      timeoutMs: options.timeoutMs,
      pollMs: options.pollMs,
    },
  );
}

export function parsePnpmInstallArgs(argv) {
  const args = [...argv];
  const ifMissingIndex = args.indexOf('--if-missing');
  const ifMissing = ifMissingIndex !== -1;
  if (ifMissing) args.splice(ifMissingIndex, 1);
  if (args[0] === '--') args.shift();
  return { args, ifMissing };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const { args, ifMissing } = parsePnpmInstallArgs(process.argv.slice(2));
  runSerializedPnpmInstall({ args, ifMissing }).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(`[pnpm-install] ${error?.message ?? error}`);
      process.exitCode = 1;
    },
  );
}
