import { spawn } from 'node:child_process';
import { OutputRingBuffer } from '../fs/ring.js';
import { winShellSafe } from '../packages/win-shell.js';
import { runUnderMacSandbox } from '../sandbox/macos.js';
import { canApplyMacSandbox, sandboxEnv } from '../sandbox/runner.js';

/**
 * Run an approved workspace/package command (pnpm for `npm run`, a
 * `node_modules/.bin/*` binary for npx). Unlike `runInSandbox` this
 * does NOT apply Node's `--permission` flag — real build tools
 * (webpack, vite, vitest) spawn workers and use native addons, which
 * `--permission` blocks. Our real boundary here is:
 *
 *   - `cwd` is the project workspace; the caller has already passed the
 *     `assertWorkspaceWritable` gate.
 *   - Env is allowlist-scrubbed — tokens and API keys never reach the
 *     child. `GEZEL_PNPM_PATH` and `GEZEL_NODE_PATH` are preserved so
 *     nested pnpm calls resolve the bundled script and runtime.
 *   - Wall-clock timeout with process-group kill, so a runaway
 *     `tsc --watch` can't outlive its deadline.
 *   - 200KB output caps per stream so a chatty build can't flood the
 *     MCP channel.
 *   - macOS `sandbox-exec` wraps the whole thing as defense-in-depth:
 *     writes scoped to workspace + scratch; network intentionally open.
 *
 * Does NOT gate the workspace itself. The caller is responsible for
 * resolving `cwd` through `Store.assertWorkspaceWritable` and bailing
 * on the locked-external-workspace case.
 */

const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const OUTPUT_CAP_BYTES = 200_000;

export interface RunWorkspaceCommandOptions {
  bin: string;
  args: string[];
  cwd: string;
  /** Extra env vars layered on top of the scrubbed base. */
  extraEnv?: Record<string, string>;
  timeoutMs?: number;
}

export interface RunWorkspaceCommandResult {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
  durationMs: number;
  error?: string;
}

export async function runWorkspaceCommand(
  opts: RunWorkspaceCommandOptions,
): Promise<RunWorkspaceCommandResult> {
  const timeout = clampTimeout(opts.timeoutMs);
  const stdoutRing = new OutputRingBuffer(OUTPUT_CAP_BYTES);
  const stderrRing = new OutputRingBuffer(OUTPUT_CAP_BYTES);

  const env: Record<string, string> = {
    ...sandboxEnv(process.env),
    GEZEL_SANDBOX: '1',
    ...(process.env.GEZEL_PNPM_PATH ? { GEZEL_PNPM_PATH: process.env.GEZEL_PNPM_PATH } : {}),
    ...(process.env.GEZEL_NODE_PATH ? { GEZEL_NODE_PATH: process.env.GEZEL_NODE_PATH } : {}),
    ...(opts.extraEnv ?? {}),
  };

  const { command, args } = await wrapForPlatform(opts.bin, opts.args, {
    workdir: opts.cwd,
    scratch: opts.cwd,
  });

  const startedAt = Date.now();
  const shell = process.platform === 'win32' && needsShellExpansion(command);
  let target: { command: string; args: string[] };
  try {
    target = winShellSafe(command, args, shell);
  } catch (err) {
    return {
      ok: false,
      code: -1,
      stdout: '',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: false,
      durationMs: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  return await new Promise<RunWorkspaceCommandResult>((resolve) => {
    const child = spawn(target.command, target.args, {
      cwd: opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
      // New process group on POSIX so a runaway child tree can be
      // killed with `process.kill(-pid)` on timeout. On Windows the same
      // option is DETACHED_PROCESS — not the no-op the previous comment
      // here claimed — and that is exactly what a console-subsystem build
      // tool needs under the machine service, whose restricted SID cannot
      // allocate a console. `killTree` is unaffected: detaching changes the
      // console and process group, not the parent PID `taskkill /T` walks.
      detached: true,
      // Windows: only force a shell when we're running a .cmd/.bat
      // shim that the loader can't exec directly. For absolute paths
      // to .exe binaries (pnpm, node, `.bin/*` after our resolution),
      // shell:true is actively wrong: cmd.exe re-tokenizes the
      // command line on whitespace, so an exe path like
      // `C:\Program Files\nodejs\node.exe` gets split and the loader
      // reports `'C:\Program' is not recognized as an internal or
      // external command`. The Node 24 deprecation DEP0190 also flags
      // shell:true with args as a quoting/injection footgun.
      // `.cmd` / `.bat` shims need cmd.exe, but the command line above is
      // already one atomic, safely quoted token stream. Its argv is empty,
      // so Node neither re-concatenates model-controlled values nor emits
      // DEP0190. Ordinary executables stay on the shell:false path.
      shell,
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeout);
    timer.unref?.();

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutRing.append(chunk.toString('utf8'));
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrRing.append(chunk.toString('utf8'));
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      const stdout = stdoutRing.value();
      const stderr = stderrRing.value();
      resolve({
        ok: false,
        code: -1,
        stdout: stdout.text,
        stderr: stderr.text,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
        timedOut: false,
        durationMs: Date.now() - startedAt,
        error: err.message,
      });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const stdout = stdoutRing.value();
      const stderr = stderrRing.value();
      const exit = code ?? -1;
      resolve({
        ok: exit === 0 && !timedOut,
        code: exit,
        stdout: stdout.text,
        stderr: stderr.text,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
        timedOut,
        durationMs: Date.now() - startedAt,
        ...(timedOut ? { error: `Command exceeded ${timeout}ms timeout and was killed.` } : {}),
      });
    });
  });
}

/**
 * Windows: only opt into `shell: true` when the command can't be exec'd
 * directly. The loader handles `.exe` natively but needs cmd.exe to
 * resolve `.cmd` / `.bat` / bare-name shims on PATH. Pure exe paths
 * with embedded spaces (Program Files) break under shell tokenization,
 * so we want shell:false in that case — the cost of a missed `.cmd`
 * lookup is an actionable spawn error, not a silent path corruption.
 */
function needsShellExpansion(command: string): boolean {
  const lower = command.toLowerCase();
  if (lower.endsWith('.cmd') || lower.endsWith('.bat')) return true;
  // No extension at all — can't tell what we're invoking, hand it to
  // the shell so PATHEXT resolution kicks in.
  if (!/\.[a-z0-9]{1,5}$/i.test(command)) return true;
  return false;
}

function clampTimeout(raw?: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_TIMEOUT_MS;
  if (raw < 30_000) return 30_000;
  if (raw > 30 * 60_000) return 30 * 60_000;
  return Math.floor(raw);
}

function killTree(child: import('node:child_process').ChildProcess): void {
  if (process.platform === 'win32') {
    const pid = child.pid;
    if (typeof pid !== 'number') {
      child.kill('SIGKILL');
      return;
    }
    // Node's ChildProcess.kill() terminates only the immediate process on
    // Windows. taskkill /T walks the descendant tree (watchers and compiler
    // workers included) before force-terminating it.
    // taskkill is itself a console-subsystem executable, so it needs the
    // same DETACHED_PROCESS treatment — a timeout kill that cannot spawn
    // its killer would leave the runaway tree running.
    const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      detached: true,
      stdio: 'ignore',
    });
    killer.once('error', () => child.kill('SIGKILL'));
    killer.once('close', (code) => {
      if (code !== 0 && child.exitCode === null) child.kill('SIGKILL');
    });
    killer.unref();
    return;
  }
  const pid = child.pid;
  if (typeof pid !== 'number') {
    child.kill('SIGKILL');
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

async function wrapForPlatform(
  command: string,
  args: string[],
  ctx: { workdir: string; scratch: string },
): Promise<{ command: string; args: string[] }> {
  if (process.platform === 'darwin' && (await canApplyMacSandbox())) {
    // Build tools read far more widely than a task script (icu data,
    // dyld caches, node_modules sources). Writes stay scoped to the
    // workspace — that's the real fence.
    return runUnderMacSandbox(command, args, ctx, { relaxReads: true });
  }
  // Approved repository scripts and installed package binaries are a
  // deliberately trusted execution class. On Windows/Linux, or on a
  // Mac where Seatbelt is unavailable, run them without an OS sandbox
  // instead of failing closed. They legitimately need subprocesses,
  // workers, native executables, and sometimes networking. Only
  // AI-authored standalone scripts go through runInSandbox's mandatory
  // denyNet boundary.
  return { command, args };
}
