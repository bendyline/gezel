import { createLogger } from '@bendyline/gezel';
import { PersistentShell, type PersistentShellRunResult } from './persistent-shell.js';

const log = createLogger('terminal/shell-pool');

const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60_000;
/**
 * How long `shutdown()` waits for a killed shell's PTY to actually
 * exit before giving up on it. `kill()` sends SIGHUP and an
 * interactive bash dies well within this; the cap only guards against
 * a wedged PTY hanging teardown forever.
 */
const SHUTDOWN_EXIT_GRACE_MS = 2_000;

export interface ShellPoolRunOptions {
  /**
   * Initial cwd for the shell. Used ONLY on first spawn for this
   * threadId — once the shell exists, the user's commands (notably
   * `cd`) own the cwd from then on. Subsequent calls with a
   * different `initialCwd` do NOT relocate an existing shell; the
   * caller is expected to use a different threadId if they want a
   * different shell.
   */
  initialCwd: string;
  /** Raw shell command to write to the shell's stdin. */
  command: string;
  /** Client output width. Programs use this to choose their column layout. */
  columns?: number;
  /**
   * Streaming sink — fires for each block of real command output
   * as it arrives from the PTY, before the final result resolves.
   * Plumbed through to `PersistentShell.run`. Optional; the pool
   * does not buffer or batch chunks itself.
   */
  onChunk?: (chunk: string) => void;
  /** Plumbed through to `PersistentShell.run` — fires when the
   *  shell looks like it's waiting on stdin. */
  onPromptDetected?: (info: { promptLine: string; mode: 'text' | 'password' | 'yes-no' }) => void;
}

interface PoolEntry {
  shell: PersistentShell;
  idleTimer: NodeJS.Timeout | null;
}

/**
 * Owns the per-thread PersistentShells. Lazy-spawns on first `run`
 * for a given threadId, kills a shell after `idleTimeoutMs` of
 * inactivity, and re-spawns on the next call. `shutdown()` kills
 * everything — called from the daemon shutdown hook.
 *
 * Concurrency: relies on the caller (TerminalManager's per-thread
 * queue) to serialize. If two `run` calls land for the same
 * threadId simultaneously, the second one's `shell.run()` will
 * reject — the manager's queue prevents this from happening in
 * practice.
 */
export class PersistentShellPool {
  private readonly entries = new Map<string, PoolEntry>();
  private readonly idleTimeoutMs: number;
  private shuttingDown = false;

  constructor(opts: { idleTimeoutMs?: number } = {}) {
    this.idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  }

  async run(threadId: string, opts: ShellPoolRunOptions): Promise<PersistentShellRunResult> {
    if (this.shuttingDown) {
      throw new Error('Shell pool is shutting down; refusing new commands.');
    }

    let entry = this.entries.get(threadId);

    // Stale-shell collection: if the entry's shell died (idle kill
    // hadn't fired yet, or crash mid-run), evict it before
    // dispatching.
    if (entry && !entry.shell.isAlive()) {
      this.clearIdleTimer(entry);
      this.entries.delete(threadId);
      entry = undefined;
    }

    if (!entry) {
      log.info(`spawning shell for thread=${threadId} (cwd=${opts.initialCwd})`);
      const shell = await PersistentShell.start({ cwd: opts.initialCwd, columns: opts.columns });
      entry = { shell, idleTimer: null };
      this.entries.set(threadId, entry);
    }

    this.clearIdleTimer(entry);

    try {
      const result = await entry.shell.run(opts.command, {
        ...(opts.columns !== undefined ? { columns: opts.columns } : {}),
        ...(opts.onChunk ? { onChunk: opts.onChunk } : {}),
        ...(opts.onPromptDetected ? { onPromptDetected: opts.onPromptDetected } : {}),
      });
      // Only re-arm the idle timer if the shell is still alive. A
      // shell that died during the command shouldn't get a timer
      // pointing at a stale entry.
      if (entry.shell.isAlive()) {
        this.armIdleTimer(threadId, entry);
      } else {
        this.entries.delete(threadId);
      }
      return result;
    } catch (err) {
      if (!entry.shell.isAlive()) {
        this.entries.delete(threadId);
      } else {
        this.armIdleTimer(threadId, entry);
      }
      throw err;
    }
  }

  /**
   * Send Ctrl+C to whatever command the shell for this thread is
   * currently running. No-op if no shell exists or the shell is
   * dead. See `PersistentShell.interrupt` for semantics — the
   * shell stays alive; only the foreground command sees SIGINT.
   */
  interrupt(threadId: string): void {
    const entry = this.entries.get(threadId);
    if (!entry || !entry.shell.isAlive()) return;
    entry.shell.interrupt();
  }

  /**
   * Feed text to the foreground command of the shell for this
   * thread as if the user had typed it at the terminal. Returns
   * `true` if the write succeeded, `false` if no shell exists or
   * the write failed. Used by the interactive-prompt UI to deliver
   * password / Y-N / free-text replies.
   */
  feedInput(threadId: string, text: string): boolean {
    const entry = this.entries.get(threadId);
    if (!entry || !entry.shell.isAlive()) return false;
    return entry.shell.feedInput(text);
  }

  /** Force-kill the shell for a thread. Safe if no entry exists. */
  kill(threadId: string): void {
    const entry = this.entries.get(threadId);
    if (!entry) return;
    this.clearIdleTimer(entry);
    entry.shell.kill();
    this.entries.delete(threadId);
  }

  /** Whether there's a live shell for this thread. */
  isAlive(threadId: string): boolean {
    const entry = this.entries.get(threadId);
    return !!entry && entry.shell.isAlive();
  }

  /**
   * Absolute cwd of the live shell for this thread, or `undefined`
   * if no shell exists yet. The manager calls this before emitting
   * a command bubble so the bubble can be labeled with the folder
   * the command will actually run from — important after `cd`
   * commands move the shell off the thread anchor.
   */
  currentCwd(threadId: string): string | undefined {
    const entry = this.entries.get(threadId);
    if (!entry || !entry.shell.isAlive()) return undefined;
    return entry.shell.cwd;
  }

  /**
   * Kill all shells and wait for their PTYs to actually exit.
   * Idempotent; safe to call from shutdown hooks. Awaiting the real
   * exit (not just the synchronous `kill()`) lets node-pty finish its
   * native teardown before the owning process goes away — otherwise a
   * half-reaped PTY racing process exit aborts a vitest fork worker
   * ("Worker exited unexpectedly") or leaves the daemon's exit noisy.
   * Each wait is bounded by `SHUTDOWN_EXIT_GRACE_MS` so a wedged shell
   * can't hang teardown.
   */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const draining: Array<Promise<void>> = [];
    for (const [tid, entry] of this.entries) {
      this.clearIdleTimer(entry);
      try {
        entry.shell.kill();
        draining.push(drainExit(entry.shell, tid));
      } catch (err) {
        log.warn(
          `kill threw for thread=${tid}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    this.entries.clear();
    await Promise.all(draining);
  }

  private clearIdleTimer(entry: PoolEntry): void {
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
  }

  private armIdleTimer(threadId: string, entry: PoolEntry): void {
    this.clearIdleTimer(entry);
    const timer = setTimeout(() => {
      log.info(`idle timeout — killing shell for thread=${threadId}`);
      this.kill(threadId);
    }, this.idleTimeoutMs);
    timer.unref?.();
    entry.idleTimer = timer;
  }
}

/**
 * Wait for a just-killed shell's PTY to fire its native exit, bounded
 * by `SHUTDOWN_EXIT_GRACE_MS`. Resolves (never rejects) either way so
 * `shutdown()` can't hang on a wedged shell.
 */
async function drainExit(shell: PersistentShell, threadId: string): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const grace = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      log.warn(`thread=${threadId} PTY did not exit within ${SHUTDOWN_EXIT_GRACE_MS}ms of kill`);
      resolve();
    }, SHUTDOWN_EXIT_GRACE_MS);
    timer.unref?.();
  });
  await Promise.race([shell.whenExited(), grace]);
  if (timer) clearTimeout(timer);
}
