import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SingleInstanceError, acquireSingleInstanceLock } from './runtime-lock.js';

const dirs: string[] = [];
async function freshRuntimeDir(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'gezel-lock-'));
  dirs.push(home);
  return join(home, 'runtime');
}
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

describe('acquireSingleInstanceLock', () => {
  it('acquires a free lock, writing our pid, and releases it', async () => {
    const runtimeDir = await freshRuntimeDir();
    const lockPath = join(runtimeDir, 'lock');
    const lock = await acquireSingleInstanceLock({ runtimeDir, lockPath });
    expect(existsSync(lockPath)).toBe(true);
    expect((await readFile(lockPath, 'utf8')).trim()).toBe(String(process.pid));
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
    expect((await readFile(lockPath, 'utf8')).trim()).toBe(String(process.pid));
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
});
