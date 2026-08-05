import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { stopOwnedDaemon } from './discover-or-spawn.js';
import { terminateWindowsProcessTree } from './processes.js';

interface FixturePids {
  daemonPid: number;
  workerPid: number;
}

const fixtures = (name: string) =>
  fileURLToPath(new URL(`./test-fixtures/${name}`, import.meta.url));

describe('owned daemon process lifecycle', () => {
  it('delivers stdin EOF when an owner exits abruptly and the daemon reaps its worker', async () => {
    const owner = spawn(process.execPath, [fixtures('spawn-stdin-owned-daemon.mjs')], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let pids: FixturePids | undefined;
    try {
      pids = await readFixturePids(owner);
      await once(owner, 'exit');
      await expect(waitForPidsGone([pids.daemonPid, pids.workerPid], 5_000)).resolves.toBe(true);
    } finally {
      if (pids) await cleanupPids([pids.daemonPid, pids.workerPid]);
    }
  });

  it.runIf(process.platform === 'win32')(
    'hard-stops a stubborn Windows daemon and descendant as one process tree',
    async () => {
      const child = spawn(process.execPath, [fixtures('stubborn-process-tree.mjs')], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let pids: FixturePids | undefined;
      try {
        pids = await readFixturePids(child);
        await stopOwnedDaemon(child, undefined, {
          platform: 'win32',
          graceMs: 50,
          forceMs: 2_000,
        });
        await expect(waitForPidsGone([pids.daemonPid, pids.workerPid], 2_000)).resolves.toBe(true);
      } finally {
        if (pids) await cleanupPids([pids.daemonPid, pids.workerPid]);
      }
    },
  );
});

async function readFixturePids(child: ChildProcess): Promise<FixturePids> {
  if (!child.stdout) throw new Error('fixture stdout is not piped');
  child.stdout.setEncoding('utf8');
  let pending = '';
  for await (const chunk of child.stdout) {
    pending += String(chunk);
    const newline = pending.indexOf('\n');
    if (newline < 0) continue;
    const value = JSON.parse(pending.slice(0, newline)) as FixturePids;
    if (!Number.isInteger(value.daemonPid) || !Number.isInteger(value.workerPid)) {
      throw new Error(`fixture returned invalid pids: ${pending.slice(0, newline)}`);
    }
    return value;
  }
  throw new Error('fixture exited before reporting pids');
}

async function waitForPidsGone(pids: number[], timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pids.every((pid) => !isAlive(pid))) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return pids.every((pid) => !isAlive(pid));
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function cleanupPids(pids: number[]): Promise<void> {
  const alive = pids.filter(isAlive);
  if (alive.length === 0) return;
  if (process.platform === 'win32') {
    // The daemon pid is first and owns the worker. If it already vanished,
    // taskkill the worker directly below.
    for (const pid of alive) {
      await terminateWindowsProcessTree(pid).catch(() => {});
    }
    return;
  }
  for (const pid of alive) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
}
