import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const OWNER_GRACE_MS = 30 * 1000;
const LEASE_PATH_ENV = 'GEZEL_DEPENDENCY_LEASE_PATH';
const LEASE_TOKEN_ENV = 'GEZEL_DEPENDENCY_LEASE_TOKEN';
const LEASE_MODE_ENV = 'GEZEL_DEPENDENCY_LEASE_MODE';

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

export async function dependencyLeasePath(repoRoot) {
  let canonical;
  try {
    canonical = await realpath(repoRoot);
  } catch {
    canonical = resolve(repoRoot);
  }
  if (process.platform === 'win32') canonical = canonical.toLowerCase();
  const key = createHash('sha256').update(canonical).digest('hex').slice(0, 20);
  return join(tmpdir(), `gezel-dependency-lease-${key}`);
}

async function ownerSnapshot(ownerDir) {
  try {
    const [ownerRaw, ownerStat] = await Promise.all([
      readFile(join(ownerDir, 'owner.json'), 'utf8').catch(() => null),
      stat(ownerDir),
    ]);
    let owner = null;
    try {
      owner = ownerRaw ? JSON.parse(ownerRaw) : null;
    } catch {}
    return { owner, mtimeMs: ownerStat.mtimeMs };
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

async function removeStaleOwner(ownerDir, token) {
  const quarantine = `${ownerDir}.stale-${token}`;
  try {
    await rename(ownerDir, quarantine);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'EACCES' || error?.code === 'EPERM') {
      return false;
    }
    throw error;
  }
  await rm(quarantine, { recursive: true, force: true });
  return true;
}

async function acquireGate(leaseRoot, token, options) {
  const gateDir = join(leaseRoot, 'gate');
  while (true) {
    try {
      await mkdir(gateDir);
      await writeFile(
        join(gateDir, 'owner.json'),
        `${JSON.stringify({ token, pid: process.pid })}\n`,
        'utf8',
      );
      return gateDir;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    const snapshot = await ownerSnapshot(gateDir);
    if (snapshotIsStale(snapshot) && (await removeStaleOwner(gateDir, token))) continue;
    if (Date.now() - options.startedAt >= options.timeoutMs) {
      throw new Error('Timed out waiting to inspect the checkout dependency lease');
    }
    await delay(options.pollMs);
  }
}

async function liveReaderSnapshots(readersDir, quarantineToken) {
  if (!existsSync(readersDir)) return [];
  const entries = await readdir(readersDir, { withFileTypes: true });
  const readers = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const readerDir = join(readersDir, entry.name);
    const snapshot = await ownerSnapshot(readerDir);
    if (snapshotIsStale(snapshot)) {
      await removeStaleOwner(readerDir, quarantineToken);
      continue;
    }
    if (snapshot) readers.push({ dir: readerDir, ...snapshot });
  }
  return readers;
}

function inheritedLease(options, leaseRoot, requestedMode) {
  const env = options.env ?? process.env;
  if (resolve(env[LEASE_PATH_ENV] ?? '') !== resolve(leaseRoot)) return null;
  const token = env[LEASE_TOKEN_ENV];
  const mode = env[LEASE_MODE_ENV];
  if (!token || (mode !== 'read' && mode !== 'mutation')) return null;
  if (requestedMode === 'mutation' && mode === 'read') {
    throw new Error(
      'Cannot upgrade a live dependency read lease to a mutation lease. Finish the build/test command before repairing dependencies.',
    );
  }
  return { env, mode, token };
}

async function inheritedLeaseIsLive(leaseRoot, inherited) {
  const ownerDir =
    inherited.mode === 'mutation'
      ? join(leaseRoot, 'writer')
      : join(leaseRoot, 'readers', inherited.token);
  const snapshot = await ownerSnapshot(ownerDir);
  const ownerPids = [snapshot?.owner?.pid, snapshot?.owner?.childPid].filter(Number.isInteger);
  return snapshot?.owner?.token === inherited.token && ownerPids.some(processIsAlive);
}

async function withDependencyLease(repoRoot, mode, fn, options = {}) {
  const leaseRoot = await dependencyLeasePath(repoRoot);
  const inherited = inheritedLease(options, leaseRoot, mode);
  if (inherited && (await inheritedLeaseIsLive(leaseRoot, inherited))) {
    return fn({
      setChildPid: async () => {},
      leaseEnv: {
        [LEASE_PATH_ENV]: leaseRoot,
        [LEASE_TOKEN_ENV]: inherited.token,
        [LEASE_MODE_ENV]: inherited.mode,
      },
    });
  }

  await mkdir(join(leaseRoot, 'readers'), { recursive: true });
  const token = randomUUID();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = options.pollMs ?? 250;
  const startedAt = Date.now();
  let announcedWait = false;
  let ownerDir;

  while (!ownerDir) {
    const gateDir = await acquireGate(leaseRoot, token, { startedAt, timeoutMs, pollMs });
    try {
      const writerDir = join(leaseRoot, 'writer');
      const writer = await ownerSnapshot(writerDir);
      if (snapshotIsStale(writer)) await removeStaleOwner(writerDir, token);
      const liveWriter = await ownerSnapshot(writerDir);
      const readers = await liveReaderSnapshots(join(leaseRoot, 'readers'), token);
      if (!liveWriter && (mode === 'read' || readers.length === 0)) {
        ownerDir = mode === 'mutation' ? writerDir : join(leaseRoot, 'readers', token);
        await mkdir(ownerDir);
      }
    } finally {
      await rm(gateDir, { recursive: true, force: true });
    }

    if (ownerDir) break;
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(`Timed out waiting for a dependency ${mode} lease`);
    }
    if (!announcedWait) {
      console.log(
        mode === 'mutation'
          ? '[dependency-lease] waiting for builds/tests and another dependency mutation to finish'
          : '[dependency-lease] waiting for a dependency mutation to finish',
      );
      announcedWait = true;
    }
    await delay(pollMs);
  }

  const owner = {
    token,
    mode,
    pid: process.pid,
    childPid: null,
    command: options.command ?? `dependency ${mode}`,
    repoRoot: resolve(repoRoot),
    startedAt: new Date().toISOString(),
  };
  const ownerPath = join(ownerDir, 'owner.json');
  const writeOwner = () => writeFile(ownerPath, `${JSON.stringify(owner, null, 2)}\n`, 'utf8');
  await writeOwner();

  const leaseEnv = {
    [LEASE_PATH_ENV]: leaseRoot,
    [LEASE_TOKEN_ENV]: token,
    [LEASE_MODE_ENV]: mode,
  };
  try {
    return await fn({
      setChildPid: async (childPid) => {
        owner.childPid = childPid ?? null;
        await writeOwner();
      },
      leaseEnv,
    });
  } finally {
    const current = await ownerSnapshot(ownerDir);
    if (current?.owner?.token === token) await rm(ownerDir, { recursive: true, force: true });
  }
}

export function withDependencyReadLease(repoRoot, fn, options = {}) {
  return withDependencyLease(repoRoot, 'read', fn, options);
}

export function withDependencyMutationLease(repoRoot, fn, options = {}) {
  return withDependencyLease(repoRoot, 'mutation', fn, options);
}
