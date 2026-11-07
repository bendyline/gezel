import { type ChildProcess, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { type ElectronApplication, test } from '@playwright/test';

const run = promisify(execFile);

/**
 * The daemon's graceful-shutdown wall — `DEFAULT_SHUTDOWN_TIMEOUT_MS` in
 * [quit-coordinator.ts](../../src/quit-coordinator.ts). A close that has real
 * work to drain (in-flight chat turns, MCP bridges, an index write) is
 * entitled to every millisecond of it before the second quit is let through.
 */
const SHUTDOWN_WALL_MS = 30_000;

/**
 * How long past the wall Electron gets to exit. Once the wall lets the second
 * quit through the process is gone within a second, so an app still running
 * after this never will be, and the rest of the hook budget goes to finding
 * out why: a stack sample, the leftover processes, and a kill.
 */
const EXIT_GRACE_MS = 10_000;

export interface CloseAppOptions {
  /** When to stop waiting for the app to exit. A test seam; specs omit it. */
  exitDeadlineMs?: number;
}

/**
 * Close the Electron app from a test or `afterAll`, leaving Electron's real
 * before-quit path room to finish.
 *
 * Playwright's default hook budget is *also* 30s, so any spec that leaves the
 * daemon something to drain races that wall exactly and reports a teardown
 * failure for a shutdown that was proceeding normally — with every assertion
 * in the spec already green. That is not a signal anyone can act on, and it
 * masks the failures that are. Budgeting past the wall is what separates "the
 * app would not exit" from "the app was still exiting".
 *
 * Deliberately not solved by raising the global `timeout` in
 * [playwright.config.ts](../../playwright.config.ts): that is the per-*test*
 * budget, and relaxing it would slacken every assertion in the suite to buy
 * headroom that only teardown needs.
 *
 * Playwright's `close()` itself has no bound: it resolves when Electron's
 * stdio closes, not when its main process exits. A close that outlived the
 * hook used to surface as a bare `"afterAll" hook timeout` with nothing to
 * debug (request-tracker, 2026-11-06, a spec whose shutdowns take 2.4s). Past
 * the wall plus grace, this tells the two cases apart. A main process that
 * exited while a leftover held its output is cleaned up with a warning. One
 * still running is sampled, killed and failed, with its native stacks
 * attached, since a blocked main thread is a real app bug.
 */
export async function closeApp(
  app: ElectronApplication | undefined,
  options: CloseAppOptions = {},
): Promise<void> {
  // A restart test closes midway through its lifecycle budget. Replacing
  // that budget with 60s can time out an otherwise healthy second launch.
  const timeout = test.info().timeout;
  if (timeout !== 0) test.setTimeout(Math.max(timeout, SHUTDOWN_WALL_MS + 30_000));
  if (!app) return;
  const deadlineMs = options.exitDeadlineMs ?? SHUTDOWN_WALL_MS + EXIT_GRACE_MS;
  const closed = app.close();
  if (await settlesWithin(closed, deadlineMs)) return;
  await recoverStuckClose(app.process(), closed, deadlineMs);
}

async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([promise.then(() => true), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

async function recoverStuckClose(
  child: ChildProcess,
  closed: Promise<void>,
  waitedMs: number,
): Promise<void> {
  const pid = child.pid;
  const exited = child.exitCode !== null || child.signalCode !== null;
  // Both are read before the kill: afterwards there is nothing left to see.
  const leftovers = pid ? await processGroup(pid) : '';
  const stacks = !exited && pid ? await sampleStacks(pid) : undefined;
  killTree(child);
  await settlesWithin(
    closed.catch(() => {}),
    5_000,
  );
  const remaining = leftovers ? `\nProcess group before the kill:\n${leftovers}` : '';
  if (exited) {
    const note = `Electron (pid ${pid}) exited, but its output stayed open ${waitedMs / 1000}s after close(); killed the processes left in its group.${remaining}`;
    test.info().annotations.push({ type: 'warning', description: note });
    console.warn(`[closeApp] ${note}`);
    return;
  }
  const evidence = stacks
    ? 'Its native stacks are attached as electron-main-stacks.'
    : 'No stack sampler on this platform.';
  throw new Error(
    `Electron (pid ${pid}) was still running ${waitedMs / 1000}s after close(), past the app's ${SHUTDOWN_WALL_MS / 1000}s shutdown wall: its main thread was blocked, or the quit never reached it. ${evidence} It was killed so the next spec starts clean.${remaining}`,
  );
}

async function processGroup(pid: number): Promise<string> {
  // Playwright starts Electron as a process-group leader everywhere but Windows.
  if (process.platform === 'win32') return '';
  try {
    const { stdout } = await run('pgrep', ['-g', String(pid)]);
    const pids = stdout.trim().split(/\s+/).filter(Boolean);
    if (pids.length === 0) return '';
    const { stdout: rows } = await run('ps', ['-o', 'pid=,stat=,command=', '-p', pids.join(',')]);
    return rows
      .trimEnd()
      .split('\n')
      .map((row) => row.slice(0, 200))
      .join('\n');
  } catch {
    // pgrep exits 1 when nothing in the group is left.
    return '';
  }
}

async function sampleStacks(pid: number): Promise<string | undefined> {
  if (process.platform !== 'darwin') return undefined;
  const path = test.info().outputPath(`electron-${pid}.sample.txt`);
  try {
    await run('/usr/bin/sample', [String(pid), '2', '-mayDie', '-file', path], {
      timeout: 10_000,
    });
    await test.info().attach('electron-main-stacks', { path, contentType: 'text/plain' });
    return path;
  } catch {
    return undefined;
  }
}

function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) return;
  try {
    if (process.platform === 'win32') execFile('taskkill', ['/pid', String(pid), '/T', '/F']);
    else process.kill(-pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}
