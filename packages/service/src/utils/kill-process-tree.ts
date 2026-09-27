import { type ChildProcess, spawn } from 'node:child_process';
import { windowsHeadlessSpawnOptions } from '@bendyline/gezel/native';

/**
 * Force-terminate a child and everything it spawned.
 *
 * `ChildProcess.kill()` reaches only the immediate process, and launchers
 * such as pnpm exit without taking their children along: a Chromium download
 * outlived the daemon that started it that way. On POSIX the child must have
 * been spawned `detached` so it leads its own process group; on Windows
 * `taskkill /T` walks the descendant tree and needs no detachment.
 */
export function killProcessTree(child: ChildProcess): void {
  const pid = child.pid;
  if (typeof pid !== 'number') {
    child.kill('SIGKILL');
    return;
  }
  if (process.platform === 'win32') {
    // taskkill is itself a short-lived console executable; hide its window
    // while retaining ownership long enough to observe failure.
    const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      ...windowsHeadlessSpawnOptions(),
    });
    killer.once('error', () => child.kill('SIGKILL'));
    killer.once('close', (code) => {
      if (code !== 0 && child.exitCode === null) child.kill('SIGKILL');
    });
    killer.unref();
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}
