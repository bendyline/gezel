import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { PersistentShellPool } from './shell-pool.js';

const bashAvailable = process.platform !== 'win32' && existsSync('/bin/bash');
const itPosix = bashAvailable ? it : it.skip;

describe('PersistentShellPool (POSIX)', () => {
  itPosix('lazy-spawns one shell per threadId', async () => {
    const pool = new PersistentShellPool();
    try {
      expect(pool.isAlive('thread-a')).toBe(false);
      await pool.run('thread-a', { initialCwd: tmpdir(), command: 'echo a' });
      expect(pool.isAlive('thread-a')).toBe(true);
      expect(pool.isAlive('thread-b')).toBe(false);
    } finally {
      await pool.shutdown();
    }
  });

  itPosix('shell state persists across runs for the same threadId', async () => {
    const pool = new PersistentShellPool();
    try {
      await pool.run('thread-a', {
        initialCwd: tmpdir(),
        command: 'export POOL_TEST_VAR=zucchini',
      });
      const res = await pool.run('thread-a', {
        initialCwd: tmpdir(),
        command: 'echo $POOL_TEST_VAR',
      });
      expect(res.output).toBe('zucchini');
    } finally {
      await pool.shutdown();
    }
  });

  itPosix('two threadIds get independent shells', async () => {
    const pool = new PersistentShellPool();
    try {
      await pool.run('thread-a', {
        initialCwd: tmpdir(),
        command: 'export ONLY_IN_A=hello',
      });
      const res = await pool.run('thread-b', {
        initialCwd: tmpdir(),
        command: 'echo "[${ONLY_IN_A:-unset}]"',
      });
      expect(res.output).toBe('[unset]');
    } finally {
      await pool.shutdown();
    }
  });

  itPosix('idle timeout kills the shell; next run re-spawns', async () => {
    const pool = new PersistentShellPool({ idleTimeoutMs: 100 });
    try {
      await pool.run('thread-a', {
        initialCwd: tmpdir(),
        command: 'export RESPAWN_TEST=before',
      });
      expect(pool.isAlive('thread-a')).toBe(true);
      // Wait past the idle window — timer should fire and kill the shell.
      await new Promise((r) => setTimeout(r, 250));
      expect(pool.isAlive('thread-a')).toBe(false);
      // Next run on the same threadId spawns a fresh shell with no
      // memory of the prior env.
      const res = await pool.run('thread-a', {
        initialCwd: tmpdir(),
        command: 'echo "[${RESPAWN_TEST:-unset}]"',
      });
      expect(res.output).toBe('[unset]');
    } finally {
      await pool.shutdown();
    }
  });

  itPosix('shutdown kills all live shells and refuses new commands', async () => {
    const pool = new PersistentShellPool();
    await pool.run('thread-a', { initialCwd: tmpdir(), command: 'echo a' });
    await pool.run('thread-b', { initialCwd: tmpdir(), command: 'echo b' });
    expect(pool.isAlive('thread-a')).toBe(true);
    expect(pool.isAlive('thread-b')).toBe(true);
    await pool.shutdown();
    expect(pool.isAlive('thread-a')).toBe(false);
    expect(pool.isAlive('thread-b')).toBe(false);
    await expect(pool.run('thread-a', { initialCwd: tmpdir(), command: 'echo a' })).rejects.toThrow(
      /shutting down/i,
    );
  });
});
