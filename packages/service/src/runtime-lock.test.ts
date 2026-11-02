import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type LockIdentity,
  SingleInstanceError,
  acquireSingleInstanceLock,
  parseLockFile,
  sharesPidNamespace,
} from '@bendyline/gezel-inference/internal/runtime-lock';
import { afterEach, describe, expect, it } from 'vitest';

const dirs: string[] = [];
async function freshRuntimeDir(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'gezel-lock-'));
  dirs.push(home);
  return join(home, 'runtime');
}
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const firstLine = async (path: string) => (await readFile(path, 'utf8')).split('\n')[0];

function identity(overrides: Partial<LockIdentity> = {}): LockIdentity {
  return {
    pid: 4242,
    hostname: 'gezel',
    bootId: 'boot-a',
    pidNs: 'pid:[1]',
    startTicks: '100',
    instance: 'me',
    ...overrides,
  };
}

async function writeHolder(lockPath: string, holder: LockIdentity): Promise<void> {
  await writeFile(lockPath, `${holder.pid}\n${JSON.stringify({ v: 1, ...holder })}\n`, 'utf8');
}

describe('acquireSingleInstanceLock', () => {
  it('acquires a free lock, writing our identity, and releases it', async () => {
    const runtimeDir = await freshRuntimeDir();
    const lockPath = join(runtimeDir, 'lock');
    const lock = await acquireSingleInstanceLock({ runtimeDir, lockPath });
    expect(existsSync(lockPath)).toBe(true);
    // The pid stays on the first line, which is all older daemons read.
    expect(await firstLine(lockPath)).toBe(String(process.pid));
    const parsed = parseLockFile(await readFile(lockPath, 'utf8'));
    expect(parsed?.pid).toBe(process.pid);
    expect(parsed?.instance).toBeTruthy();
    await lock.release();
    expect(existsSync(lockPath)).toBe(false);
  });

  it('refuses when a LIVE foreign holder owns the lock', async () => {
    const runtimeDir = await freshRuntimeDir();
    const lockPath = join(runtimeDir, 'lock');
    // Simulate a different, still-running daemon: a foreign pid the
    // liveness probe reports alive. (We can't use the real acquire here —
    // a same-process holder shares our pid and is treated as reclaimable.)
    await mkdir(runtimeDir, { recursive: true });
    await writeFile(lockPath, '999999\n', 'utf8');
    await expect(
      acquireSingleInstanceLock({ runtimeDir, lockPath, isAlive: () => true }),
    ).rejects.toBeInstanceOf(SingleInstanceError);
    // The foreign lock is left intact — we must not steal it.
    expect((await readFile(lockPath, 'utf8')).trim()).toBe('999999');
    await rm(lockPath, { force: true });
  });

  it('reclaims a stale lock whose holder is dead', async () => {
    const runtimeDir = await freshRuntimeDir();
    const lockPath = join(runtimeDir, 'lock');
    await mkdir(runtimeDir, { recursive: true });
    await writeFile(lockPath, '999999\n', 'utf8');
    const lock = await acquireSingleInstanceLock({ runtimeDir, lockPath, isAlive: () => false });
    // Reclaimed — the lock now holds OUR pid.
    expect(await firstLine(lockPath)).toBe(String(process.pid));
    await lock.release();
  });

  it("release() does not delete a lock that's no longer ours", async () => {
    const runtimeDir = await freshRuntimeDir();
    const lockPath = join(runtimeDir, 'lock');
    const lock = await acquireSingleInstanceLock({ runtimeDir, lockPath });
    // Simulate another process reclaiming the lock.
    await writeFile(lockPath, '999999\n', 'utf8');
    await lock.release();
    expect(existsSync(lockPath)).toBe(true);
    await rm(lockPath, { force: true });
  });

  it('reclaims a same-namespace lock whose pid was reused by another process', async () => {
    const runtimeDir = await freshRuntimeDir();
    const lockPath = join(runtimeDir, 'lock');
    await mkdir(runtimeDir, { recursive: true });
    await writeHolder(lockPath, identity({ pid: 77, instance: 'old', startTicks: '100' }));
    const lock = await acquireSingleInstanceLock({
      runtimeDir,
      lockPath,
      identity: identity(),
      isAlive: () => true,
      startTicksOf: () => '999',
    });
    expect(parseLockFile(await readFile(lockPath, 'utf8'))?.instance).toBe('me');
    await lock.release();
  });

  describe('a holder in another container (another pid namespace)', () => {
    it('refuses while its heartbeat moves, even when it shares our pid', async () => {
      const runtimeDir = await freshRuntimeDir();
      const lockPath = join(runtimeDir, 'lock');
      await mkdir(runtimeDir, { recursive: true });
      // Both daemons are pid 4242 in their own namespace: the old pid-only
      // check treated that as "our own stale lock" and took it.
      await writeHolder(lockPath, identity({ pidNs: 'pid:[2]', instance: 'serving' }));
      let elapsed = 0;
      const error = await acquireSingleInstanceLock({
        runtimeDir,
        lockPath,
        identity: identity(),
        isAlive: () => false,
        now: () => Date.now() + elapsed,
        // The serving daemon's heartbeat lands while we wait.
        sleep: async (ms) => {
          elapsed += ms;
          const at = new Date(Date.now() + elapsed);
          await utimes(lockPath, at, at);
        },
      }).catch((err: unknown) => err);
      expect(error).toBeInstanceOf(SingleInstanceError);
      expect((error as SingleInstanceError).holderHost).toBe('gezel');
      expect((error as Error).message).toContain('docker exec');
      expect(parseLockFile(await readFile(lockPath, 'utf8'))?.instance).toBe('serving');
    });

    it('reclaims once its heartbeat is older than the stale bound', async () => {
      const runtimeDir = await freshRuntimeDir();
      const lockPath = join(runtimeDir, 'lock');
      await mkdir(runtimeDir, { recursive: true });
      await writeHolder(lockPath, identity({ pidNs: 'pid:[2]', instance: 'crashed' }));
      const mtime = (await stat(lockPath)).mtimeMs;
      const lock = await acquireSingleInstanceLock({
        runtimeDir,
        lockPath,
        identity: identity(),
        now: () => mtime + 60_000,
        staleAfterMs: 40_000,
      });
      expect(parseLockFile(await readFile(lockPath, 'utf8'))?.instance).toBe('me');
      await lock.release();
    });

    it('reclaims a fresh lock whose heartbeat never moves (a killed container restarting)', async () => {
      const runtimeDir = await freshRuntimeDir();
      const lockPath = join(runtimeDir, 'lock');
      await mkdir(runtimeDir, { recursive: true });
      await writeHolder(lockPath, identity({ hostname: 'old-container', instance: 'killed' }));
      const mtime = (await stat(lockPath)).mtimeMs;
      let clock = mtime;
      const lock = await acquireSingleInstanceLock({
        runtimeDir,
        lockPath,
        identity: identity(),
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
        staleAfterMs: 5_000,
      });
      expect(parseLockFile(await readFile(lockPath, 'utf8'))?.instance).toBe('me');
      await lock.release();
    });
  });

  it('touches the lock while held, and stops once the lock is no longer ours', async () => {
    const runtimeDir = await freshRuntimeDir();
    const lockPath = join(runtimeDir, 'lock');
    const lock = await acquireSingleInstanceLock({ runtimeDir, lockPath, heartbeatIntervalMs: 20 });
    const old = new Date(Date.now() - 600_000);
    await utimes(lockPath, old, old);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect((await stat(lockPath)).mtimeMs).toBeGreaterThan(old.getTime() + 1_000);
    await lock.release();
  });
});

describe('sharesPidNamespace', () => {
  it('treats a legacy pid-only record as ours, as before', () => {
    expect(sharesPidNamespace({ pid: 1 }, identity())).toBe(true);
  });

  it('separates containers that share a hostname but not a pid namespace', () => {
    expect(sharesPidNamespace(identity({ pidNs: 'pid:[2]' }), identity())).toBe(false);
  });

  it('separates boots and hosts', () => {
    expect(sharesPidNamespace(identity({ bootId: 'boot-b' }), identity())).toBe(false);
    expect(sharesPidNamespace(identity({ hostname: 'laptop' }), identity())).toBe(false);
  });
});
