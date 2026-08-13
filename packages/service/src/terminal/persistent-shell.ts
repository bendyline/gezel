import { randomUUID } from 'node:crypto';
import { createLogger } from '@bendyline/gezel';
import type { IPty } from 'node-pty';
import { OutputRingBuffer } from '../fs/ring.js';
import { ensureNodePtyExecutable } from '../node-pty-permissions.js';
import { sandboxEnv } from '../sandbox/runner.js';

const log = createLogger('terminal/persistent-shell');

const OUTPUT_CAP_BYTES = 200_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 5 * 60_000;
/**
 * Idle window before we check whether the shell is waiting on
 * stdin. Long enough that small inter-output pauses (a slow
 * `git clone` pulling refs, a few-ms disk flush) don't false-fire;
 * short enough that a real `sudo` prompt feels responsive.
 */
const INPUT_PROMPT_IDLE_MS = 600;
/**
 * Patterns we recognize on the last (un-newline-terminated)
 * output line. ANSI escapes are stripped before matching so a
 * colored `Password:` still detects.
 */
const PROMPT_PASSWORD_RE = /\b(password|passphrase)\b[^:?]*[:?]\s*$/i;
const PROMPT_YESNO_RE =
  /\(\s*(y|yes)\s*[/|]\s*(n|no)\s*\)\s*\??\s*$|\[\s*y\s*[/|]\s*n\s*\]\s*\??\s*$|\[\s*Y\s*[/|]\s*n\s*\]\s*\??\s*$|\[\s*y\s*[/|]\s*N\s*\]\s*\??\s*$/i;
const PROMPT_GENERIC_RE = /[:?]\s*$/;

type NodePtyRuntime = Pick<typeof import('node-pty'), 'spawn'>;
type NodePtyImporter = () => Promise<NodePtyRuntime>;

/** Stable error surfaced by terminal clients when the optional PTY runtime is absent or broken. */
export class NodePtyUnavailableError extends Error {
  readonly code = 'GEZEL_NODE_PTY_UNAVAILABLE';

  constructor(cause: unknown) {
    super(
      'Interactive terminal support requires node-pty, but it is not installed or could not be loaded. Install it alongside Gezel, then retry: npm install node-pty',
      { cause },
    );
    this.name = 'NodePtyUnavailableError';
  }
}

/**
 * Load the native PTY bridge only when the first terminal shell starts.
 *
 * `node-pty` loads its native addon at module evaluation time. Keeping this a
 * dynamic import is therefore the boundary that lets the rest of gezeld boot
 * and run when optional dependencies were omitted or the addon cannot load on
 * this machine. Node caches a successful module evaluation, so later terminal
 * threads do not pay another native-load cost.
 *
 * The importer argument is a test seam for the unavailable-runtime path.
 */
export async function loadNodePty(
  importer: NodePtyImporter = () => import('node-pty'),
): Promise<NodePtyRuntime> {
  try {
    const runtime = await importer();
    if (typeof runtime.spawn !== 'function') {
      throw new TypeError('node-pty did not export spawn()');
    }
    return runtime;
  } catch (cause) {
    if (cause instanceof NodePtyUnavailableError) throw cause;
    throw new NodePtyUnavailableError(cause);
  }
}

/**
 * Match the ANSI escape sequences a shell or program emits — CSI
 * (`ESC [ ... letter`), OSC (`ESC ] ... BEL`), and the standalone
 * `ESC <single>` form. Exported so the history logger and any
 * future "plain text" toggle can call `stripAnsi(s)`; the
 * `cleanOutput` path no longer uses it because the UI now renders
 * colors via `AnsiOutput`.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control chars is the point
const ANSI_REGEX = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g;

/** Drop every ANSI escape sequence from `s`. Idempotent. */
export function stripAnsi(s: string): string {
  return s.replace(ANSI_REGEX, '');
}

export interface PersistentShellRunResult {
  /**
   * Combined stdout+stderr (PTYs merge them). LF-normalized. ANSI
   * escape sequences pass through — the UI's `AnsiOutput`
   * component renders colors / styles client-side.
   */
  output: string;
  /** Exit status of the LAST command in the user input (`$?` / `$LASTEXITCODE`). */
  exitCode: number;
  /** Wall-clock milliseconds from write-to-stdin to sentinel-arrival. */
  durationMs: number;
  /** Absolute path the shell's cwd is at after the command. */
  newCwd: string;
  /** True when the 200KB output ring rolled over and dropped older bytes. */
  truncated: boolean;
}

export interface PersistentShellOptions {
  /** Initial cwd for the shell. Must be an absolute path. */
  cwd: string;
  /** Initial PTY width. Defaults to the desktop terminal surface's legacy width. */
  columns?: number;
  /** Per-command wall-clock timeout. Default 5 min. */
  commandTimeoutMs?: number;
  /** Test seam: override the platform shell selection. */
  shell?: { file: string; args: string[]; initLines: string[]; platform: 'posix' | 'win32' };
}

/**
 * One persistent shell process — `bash` on POSIX, `powershell.exe` on
 * Windows — driven through `node-pty`. Commands are written to the
 * PTY's stdin followed by a per-command sentinel that echoes the
 * exit code and the shell's PWD; output collected between the write
 * and the sentinel-arrival becomes one `PersistentShellRunResult`.
 *
 * Concurrency: ONE in-flight command per shell. `run()` rejects if
 * called while another command is mid-flight — the pool above is
 * responsible for serializing (today via the existing per-thread
 * queue in `TerminalManager`).
 *
 * Trade-offs (intentional, per the v1 plan):
 *  - PTY merges stdout and stderr; we surface a single `output`
 *    string. The on-disk schema's `stderr` field is left empty.
 *  - Output streams best-effort through `onChunk`, then resolves with
 *    the canonical capped buffer when the sentinel arrives.
 *  - We advertise `xterm-256color` and preserve ANSI for the UI's
 *    lightweight renderer. Cursor-heavy full-screen TUIs still need a
 *    dedicated terminal emulator rather than a timeline bubble.
 *  - On per-command timeout we kill the entire shell — the pool
 *    spawns a fresh one on the next call. The user loses any shell
 *    state (env vars, cwd) accumulated in this session. The
 *    assumption is that a timed-out command means the shell is
 *    wedged on an interactive prompt and there's no graceful
 *    recovery from outside.
 */
export class PersistentShell {
  private readonly pty: IPty;
  private readonly platform: 'posix' | 'win32';
  private readonly commandTimeoutMs: number;
  /**
   * Per-shell sentinel woven into the shell's PROMPT_COMMAND
   * (POSIX) / function-prompt machinery (Windows). Each shell
   * spawns a fresh uuid. Pattern looked for in stdout:
   * `<shellSentinel>|<exit>|<cwd>`. The shell emits this after
   * every command completes — no need for us to append a trailing
   * printf to the user's command, which is the load-bearing
   * difference for interactive commands (`read`, `sudo`) that
   * would otherwise consume our trailing line as their stdin.
   */
  private readonly shellSentinel: string;
  private exited = false;
  private exitInfo: { exitCode: number; signal?: number } | null = null;
  /**
   * Flipped only inside the native `onExit` handler — i.e. when the
   * PTY process has genuinely died and node-pty has reaped it. This
   * is deliberately distinct from `exited`, which `kill()` sets
   * synchronously the instant we ask the shell to die (before the OS
   * has actually delivered the signal). `whenExited()` keys off this.
   */
  private nativeExited = false;
  /** Resolved once `nativeExited` flips. See `whenExited()`. */
  private readonly exitBarrier: Promise<void>;
  private signalExit: () => void = () => {};
  /**
   * Absolute path the shell is currently sitting in. Seeded from
   * the spawn cwd; updated after every successful run from the
   * sentinel's cwd echo. The pool / manager use this to label each
   * outgoing command bubble with the cwd the command will run from
   * — so after `cd foo`, the next `ls` bubble shows `/foo` in its
   * folder pill instead of the thread-anchor `/`.
   */
  private currentCwd: string;
  private currentRun: {
    sentinel: string;
    /** Exact text written to the shell for this run. On Windows the
     *  interactive line editor echoes it; we use this to keep prompt/input
     *  paint out of both live chunks and the final transcript. */
    command: string;
    ring: OutputRingBuffer;
    started: number;
    timer: NodeJS.Timeout;
    resolve: (r: PersistentShellRunResult) => void;
    reject: (e: Error) => void;
    discardOutput: boolean;
    /** Streaming sink — fires for every chunk past the echo of our
     *  written command, up to the start of the OUTPUT sentinel. */
    onChunk?: (chunk: string) => void;
    /**
     * Fires once per "idle-with-prompt-shape" detection. We don't
     * re-fire if the same prompt persists; once the user sends
     * input (or any new chunk arrives) the detector flag clears
     * and a NEW prompt detection can re-fire.
     */
    onPromptDetected?: (info: {
      promptLine: string;
      mode: 'text' | 'password' | 'yes-no';
    }) => void;
    /** Set while a fired-but-not-yet-cleared prompt notification
     *  is outstanding — prevents repeat events for the same
     *  prompt. Cleared on next inbound chunk. */
    promptPending: boolean;
    /** Idle timer that fires the prompt-detection scan. Reset on
     *  every inbound chunk. */
    promptIdleTimer: NodeJS.Timeout | null;
    /**
     * Streaming state machine:
     *   - `streaming`: new bytes past `streamCursor` are real command
     *     output (slave-side echo is suppressed at shell-init) and
     *     get fired through `onChunk`, stopping at the OUTPUT
     *     sentinel.
     *   - `done`: OUTPUT sentinel reached; no more chunks.
     *   - `disabled`: ring buffer rolled over (output > 200KB) so
     *     streamCursor positions are unreliable — fall back to
     *     batched-only delivery via the final resolve.
     */
    streamState: 'streaming' | 'done' | 'disabled';
    /** Position in cumulative ring text past which we haven't streamed. */
    streamCursor: number;
    /** Windows-only offset immediately after the echoed input line. */
    windowsOutputStart?: number;
  } | null = null;

  private constructor(
    pty: IPty,
    platform: 'posix' | 'win32',
    commandTimeoutMs: number,
    initialCwd: string,
    shellSentinel: string,
  ) {
    this.pty = pty;
    this.platform = platform;
    this.commandTimeoutMs = commandTimeoutMs;
    this.currentCwd = initialCwd;
    this.shellSentinel = shellSentinel;
    this.exitBarrier = new Promise<void>((resolve) => {
      this.signalExit = resolve;
    });

    this.pty.onData((data) => this.handleData(data));
    this.pty.onExit((info) => {
      this.exited = true;
      this.nativeExited = true;
      this.signalExit();
      this.exitInfo = { exitCode: info.exitCode, ...(info.signal ? { signal: info.signal } : {}) };
      log.info(`shell exited (code=${info.exitCode}, signal=${info.signal ?? 'none'})`);
      if (this.currentRun) {
        clearTimeout(this.currentRun.timer);
        const run = this.currentRun;
        this.currentRun = null;
        // The shell died WHILE running a command — surface whatever it
        // printed just before dying, which is usually the actual cause (a
        // crash message from the command, an OOM note, a `.cmd` that took
        // the shell down with it). Without this the user only sees an
        // opaque exit code — notably Windows ConPTY's -65536, which on its
        // own gives zero hint of why. Empty output points at a shell/PTY-
        // level failure (env, ConPTY, AV) rather than the command itself.
        const { text } = run.ring.value();
        const tail = stripAnsi(text).trimEnd().slice(-600);
        log.warn(
          tail
            ? `shell died mid-command; last output before exit:\n${tail}`
            : 'shell died mid-command with NO output captured — likely a shell/PTY-level failure, not the command',
        );
        run.reject(
          new Error(
            `Shell exited unexpectedly mid-command (exit=${info.exitCode}, signal=${info.signal ?? 'none'}).${
              tail
                ? `\n\nLast output before it died:\n${tail}`
                : ' No output was captured before it died.'
            }`,
          ),
        );
      }
    });
  }

  /**
   * Spawn a shell and run the platform-specific init script (suppress
   * prompt + local echo + force UTF-8). Returns once the init
   * sentinel has been observed — i.e. the shell is ready to accept
   * the first real command.
   */
  static async start(options: PersistentShellOptions): Promise<PersistentShell> {
    const spec = options.shell ?? pickPlatformShell();
    const env = {
      ...sandboxEnv(process.env),
      // `xterm-256color` is the de-facto-standard terminfo name; tools
      // that probe `TERM` will emit color codes (which the UI's
      // AnsiOutput renders) but typically suppress full-TUI behavior
      // (alt-screen, cursor save/restore) — which is exactly what
      // our batched-bubble surface can render cleanly today.
      TERM: 'xterm-256color',
      GEZEL_SANDBOX: '1',
      ...(process.env.GEZEL_PNPM_PATH ? { GEZEL_PNPM_PATH: process.env.GEZEL_PNPM_PATH } : {}),
      ...(process.env.GEZEL_NODE_PATH ? { GEZEL_NODE_PATH: process.env.GEZEL_NODE_PATH } : {}),
    } as { [key: string]: string };

    // node-pty shells out to a `spawn-helper` binary that npm's macOS prebuild
    // can land without its execute bit. Repair it here rather than from an
    // install hook, which npm 11.16 no longer runs by default.
    ensureNodePtyExecutable();

    // Deliberately after every non-native setup step: importing node-pty loads
    // its native addon immediately. A daemon that never opens a terminal never
    // loads (or requires) that optional runtime.
    const { spawn: ptySpawn } = await loadNodePty();

    log.info(`spawning shell ${spec.file} ${spec.args.join(' ')} (cwd=${options.cwd})`);
    const pty = ptySpawn(spec.file, spec.args, {
      name: 'xterm-256color',
      cols: options.columns ?? 200,
      rows: 50,
      cwd: options.cwd,
      env,
    });

    const shellSentinel = `__GEZEL_END_${randomUUID().replace(/-/g, '')}__`;
    const shell = new PersistentShell(
      pty,
      spec.platform,
      options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
      options.cwd,
      shellSentinel,
    );

    // POSIX-only: suppress slave-side echo before init runs so
    // user-command bytes don't bounce back into the output
    // stream. Done as a standalone write + brief settle delay
    // because batching `stty -echo` with the rest of init doesn't
    // work — the driver echoes the WHOLE write before bash reads
    // the stty line. By splitting, the driver echoes only
    // `stty -echo\n`, bash reads + processes it, and subsequent
    // writes are unechoed. Streaming output and the PROMPT_COMMAND
    // sentinel both rely on this; without echo suppression, the
    // user's command bytes would interleave with their own output
    // and stripping becomes brittle.
    if (spec.platform === 'posix') {
      pty.write('stty -echo 2>/dev/null\n');
      await new Promise((r) => setTimeout(r, 100));
    }

    // Build the init script: prompt suppression + the
    // PROMPT_COMMAND (POSIX) / prompt function (Windows) that
    // emits our per-shell sentinel after every command's
    // completion + a trailing no-op so the LAST line of init
    // also produces a sentinel (which is how we know init has
    // completed). Per-command trailing lines are GONE — the
    // shell's prompt machinery fires the sentinel naturally,
    // which is what lets interactive `read`/`sudo` work without
    // accidentally consuming our marker as stdin.
    // POSIX init is ONE line on purpose: PROMPT_COMMAND fires
    // once-per-prompt, so a multi-line init produces multiple
    // sentinels — the second of which lands in the NEXT run's
    // ring and falsely resolves it with empty output. By
    // collapsing the four statements onto one shell line with
    // `;` separators, the prompt cycle fires exactly once at the
    // end and we observe a single sentinel.
    // `bind 'set enable-bracketed-paste off'` is load-bearing on
    // bash >= 5.1, where bracketed-paste is on by default: readline
    // wraps every line it reads in `\x1b[?2004h` / `\x1b[?2004l`
    // toggles, and those mode-control escapes (plus the stray
    // newlines that ride with them) leak into the front of every
    // command's captured output. They're terminal input-mode
    // control, not display styling, so we kill them at the source
    // rather than stripping downstream — keeping `cleanOutput`'s
    // "preserve ANSI for AnsiOutput" contract intact.
    const initLine =
      spec.platform === 'posix'
        ? `bind 'set enable-bracketed-paste off' 2>/dev/null; export PS1=''; export PS2=''; PROMPT_COMMAND='printf "\\n%s|%s|%s\\n" "${shellSentinel}" "$?" "$PWD"'; :`
        : [
            // PowerShell must receive initialization as ONE logical line.
            // A multi-line write prompts after each completed line, so the
            // prompt-function definition used to emit the readiness sentinel
            // while a trailing `$null` line was still queued. The first user
            // command then consumed that stale prompt and appeared to finish
            // successfully in a few milliseconds while its real output was
            // dropped with no active run.
            ...spec.initLines,
            // Capture `$?` before the prompt body itself changes it. Reset
            // `$LASTEXITCODE` after every prompt so a later failing cmdlet
            // cannot inherit the exit code of an older native executable.
            `function global:prompt { $gezelSuccess = $?; $gezelLastExit = $global:LASTEXITCODE; $gezelExit = if ($gezelSuccess) { 0 } elseif ($null -ne $gezelLastExit -and $gezelLastExit -ne 0) { [int]$gezelLastExit } else { 1 }; $global:LASTEXITCODE = 0; [Console]::Write("\`n${shellSentinel}|$gezelExit|$((Get-Location).Path)\`n"); return '' }`,
            '$global:LASTEXITCODE = 0',
          ].join('; ');

    // Drive the init script through the same run pipeline so we get
    // sentinel-gated readiness with no extra special-casing. The
    // banner + echoback noise from spawn lands in the ring and is
    // discarded when the sentinel fires.
    await shell.runInternal(initLine, { discardOutput: true });
    return shell;
  }

  isAlive(): boolean {
    return !this.exited;
  }

  /**
   * Resolves once the PTY process has ACTUALLY exited — the native
   * `onExit` has fired, so node-pty has reaped the child and released
   * its master fd. Distinct from `kill()`/`isAlive()`, which flip a
   * synchronous flag the instant we ask the shell to die. Shutdown
   * paths await this so node-pty's native teardown completes before
   * the owning process exits: a half-torn-down PTY racing the exit of
   * a vitest fork worker (or the daemon) aborts that process with an
   * opaque "Worker exited unexpectedly". Resolves immediately if the
   * shell has already exited.
   */
  whenExited(): Promise<void> {
    return this.nativeExited ? Promise.resolve() : this.exitBarrier;
  }

  /**
   * Absolute path the shell is currently in. Seeded from the spawn
   * cwd; advanced by the sentinel's cwd echo on every successful
   * run. Stays stable when commands fail or time out (we only
   * advance on a clean parse). Pool consumers ask this to label
   * outgoing command bubbles with where the command will run.
   */
  get cwd(): string {
    return this.currentCwd;
  }

  /**
   * Run one user command. Rejects if the shell is dead, busy, or the
   * command exceeds the per-command timeout (in which case the
   * shell is killed before rejecting). `onChunk`, when provided,
   * fires for each block of real command output as it arrives from
   * the PTY — past the echo of our composed write, stopping at the
   * OUTPUT sentinel. Chunks are raw UTF-8 with ANSI escapes intact;
   * the client's stateful `AnsiOutput` buffers partial sequences.
   * `onPromptDetected`, when provided, fires when the shell has
   * been quiet for `INPUT_PROMPT_IDLE_MS` AND the last output line
   * matches a prompt-shape pattern — the strong heuristic for
   * "command is waiting on stdin."
   */
  async run(
    command: string,
    opts: {
      columns?: number;
      onChunk?: (chunk: string) => void;
      onPromptDetected?: (info: {
        promptLine: string;
        mode: 'text' | 'password' | 'yes-no';
      }) => void;
    } = {},
  ): Promise<PersistentShellRunResult> {
    if (opts.columns !== undefined) {
      // Keep a long-lived shell in sync with whichever client submits the
      // next command. This also updates COLUMNS inside the shell process.
      this.pty.resize(opts.columns, 50);
    }
    return this.runInternal(command, {
      discardOutput: false,
      onChunk: opts.onChunk,
      onPromptDetected: opts.onPromptDetected,
    });
  }

  /**
   * Write user-supplied text to the shell's stdin, appending the
   * platform line terminator. Used by the interactive-prompt UI
   * to feed responses (passwords, Y/N answers, etc.) into a
   * mid-flight run. No-op if the shell has exited; otherwise
   * lets the shell handle the input — `pty.write` may throw if
   * the PTY is in an unusable state, in which case we log and
   * surface to the caller via the return value.
   */
  feedInput(text: string): boolean {
    if (this.exited) return false;
    try {
      // ConPTY's interactive input terminator is CR, matching the Enter key.
      // Sending CRLF submits on CR and then feeds LF into PSReadLine as a
      // second keypress, which surfaces a spurious `>>` continuation prompt.
      this.pty.write(text + (this.platform === 'win32' ? '\r' : '\n'));
      return true;
    } catch (err) {
      log.warn(`feedInput failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /**
   * Send Ctrl+C to the foreground command without killing the
   * shell. Writes the literal `\x03` byte to the PTY's master —
   * the slave's tty line discipline picks it up and delivers
   * SIGINT to the foreground process group (the running command),
   * leaving the shell itself alive and ready for the next
   * command. Same mechanism as pressing Ctrl+C in a real
   * terminal. Tested on macOS/Linux; Windows ConPTY should also
   * honor the byte but hasn't been validated end-to-end yet.
   *
   * Safe to call when no run is in flight (the byte is harmless
   * sitting in the shell's input — bash echoes it and prompts
   * again). Safe to call repeatedly.
   */
  interrupt(): void {
    if (this.exited) return;
    try {
      this.pty.write('\x03');
    } catch (err) {
      log.warn(`failed to send SIGINT: ${err instanceof Error ? err.message : String(err)}`);
    }
    // No trailing-line resend needed: the shell's PROMPT_COMMAND
    // (set in init) fires on every command completion, regardless
    // of whether the command exited cleanly or was killed by
    // SIGINT. The sentinel arrives in the output stream naturally
    // and the run resolves with a non-zero exit code.
  }

  /** Kill the shell. Safe to call repeatedly. */
  kill(): void {
    if (this.exited) return;
    // Mark dead synchronously so isAlive() doesn't keep returning
    // true between this call and the async onExit event — the pool
    // and tests treat post-kill as terminal even though the OS
    // signal delivery is asynchronous.
    this.exited = true;
    try {
      this.pty.kill();
    } catch (err) {
      log.warn(`pty.kill() threw: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async runInternal(
    command: string,
    opts: {
      discardOutput: boolean;
      onChunk?: (chunk: string) => void;
      onPromptDetected?: (info: {
        promptLine: string;
        mode: 'text' | 'password' | 'yes-no';
      }) => void;
    },
  ): Promise<PersistentShellRunResult> {
    if (this.exited) {
      throw new Error(
        `Shell has exited (code=${this.exitInfo?.exitCode ?? -1}); the pool should respawn.`,
      );
    }
    if (this.currentRun) {
      throw new Error('Shell is already running a command — serialize at the pool level.');
    }

    // No per-command sentinel: the shell's PROMPT_COMMAND already
    // emits `shellSentinel|<exit>|<cwd>` after every command, so
    // we just write the user's input and watch for that pattern.
    // This is the load-bearing difference vs. v1's per-command
    // trailing printf: nothing is queued in the shell's stdin
    // past the user command, so interactive `read` / `sudo` /
    // npm-init can't accidentally consume our sentinel line.
    const sentinel = this.shellSentinel;
    const composed = command + this.lineSeparator();
    const ring = new OutputRingBuffer(OUTPUT_CAP_BYTES);
    const started = Date.now();

    return new Promise<PersistentShellRunResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.currentRun?.sentinel !== sentinel) return;
        this.currentRun = null;
        log.warn(`command timed out after ${this.commandTimeoutMs}ms; killing shell`);
        this.kill();
        reject(new Error(`Command exceeded ${this.commandTimeoutMs}ms and the shell was killed.`));
      }, this.commandTimeoutMs);
      timer.unref?.();

      this.currentRun = {
        sentinel,
        command,
        ring,
        started,
        timer,
        resolve,
        reject,
        discardOutput: opts.discardOutput,
        ...(opts.onChunk ? { onChunk: opts.onChunk } : {}),
        ...(opts.onPromptDetected ? { onPromptDetected: opts.onPromptDetected } : {}),
        streamState: 'streaming',
        streamCursor: 0,
        promptPending: false,
        promptIdleTimer: null,
      };

      this.pty.write(composed);
    });
  }

  private handleData(data: string): void {
    if (!this.currentRun) {
      // Pre-init bytes (shell banner) or post-run trailing prompt —
      // both safe to drop. Nothing to do.
      return;
    }
    this.currentRun.ring.append(data);
    const { text } = this.currentRun.ring.value();

    // Any inbound chunk implicitly clears a pending prompt — the
    // command has produced more output, so it's no longer waiting
    // for stdin. Reset the idle timer to start the next wait.
    this.currentRun.promptPending = false;
    if (this.currentRun.promptIdleTimer) {
      clearTimeout(this.currentRun.promptIdleTimer);
      this.currentRun.promptIdleTimer = null;
    }
    if (this.currentRun.onPromptDetected && !this.currentRun.discardOutput) {
      this.armPromptIdleTimer();
    }

    // Streaming pass — best-effort live chunks for the UI, fired
    // before the final resolve. Skipped when `discardOutput` is set
    // (init script) since the caller doesn't want the noise. Falls
    // back silently if the ring rolled over.
    if (this.currentRun.onChunk && !this.currentRun.discardOutput) {
      this.tryStreamChunks(text);
    }

    // Match `<sentinel>|<digits>|<cwd-until-eol>`. The `\d+`
    // constraint is load-bearing: bash echoes the WRITE before
    // executing it, so the echo of our `printf` line contains the
    // literal sentinel but with `"$?"` (text) where the output line
    // has `0` (an actual digit). Without the digit anchor we'd
    // match the echo line first and try to parse a literal `$?`
    // as the exit code. The `[^\r\n]+?` is non-greedy so the cwd
    // capture stops at the first line terminator, not the last.
    //
    // The trailing `\r?\n` is REQUIRED (no `$` fallback) and is
    // load-bearing for two reasons. The PROMPT_COMMAND printf
    // always emits a trailing newline (`printf "\n%s|%s|%s\n"`,
    // and the Windows prompt fn likewise), so demanding it never
    // hangs. But the PTY may split a chunk right after the cwd,
    // before that `\n` arrives. A `$`-anchored fallback would (a)
    // truncate the cwd when the path itself spans the split, and
    // (b) resolve this run while the trailing `\n` is still in
    // flight — that stray `\n` then lands at the FRONT of the next
    // run's ring, surfacing as a spurious leading blank line.
    // Requiring the newline means the terminator is always consumed
    // as part of this match and can never leak into the next run.
    const re = new RegExp(
      `${escapeRegex(this.currentRun.sentinel)}\\|(\\d+)\\|([^\\r\\n]+?)\\r?\\n`,
    );
    const m = re.exec(text);
    if (!m) return;

    const exitCode = Number(m[1]);
    // PowerShell/PSReadLine may restore its input color immediately after
    // rendering `prompt`, before the marker's terminating newline reaches
    // ConPTY. Keep terminal styling bytes out of persistent cwd state and
    // folder labels (where they otherwise render literally as `�[93m`).
    const newCwd = stripControlCharacters(stripAnsi(m[2] ?? '')).trim();
    const sentinelStart = m.index;

    const rawBefore = text.slice(0, sentinelStart);
    // Strip the echo of the input we wrote. With `stty -echo`
    // applied (suppressing slave-side echo at shell init), the
    // echo path is usually empty and stripWriteEcho is a no-op;
    // we still call it as a defense against the rare edge case
    // where stty -echo didn't take effect.
    const echoCleaned =
      this.platform === 'win32'
        ? stripWindowsWriteEcho(rawBefore, this.currentRun.command)
        : stripWriteEcho(rawBefore, this.currentRun.sentinel);
    const output = this.cleanOutput(echoCleaned);
    const { truncated } = this.currentRun.ring.value();
    const durationMs = Date.now() - this.currentRun.started;

    const run = this.currentRun;
    this.currentRun = null;
    clearTimeout(run.timer);
    if (run.promptIdleTimer) {
      clearTimeout(run.promptIdleTimer);
      run.promptIdleTimer = null;
    }

    // Advance the shell's tracked cwd from the sentinel echo so the
    // next `run()` (or external `cwd` getter) sees the new value.
    // We only advance on a clean parse — failures and timeouts leave
    // `currentCwd` at its prior value.
    if (newCwd) this.currentCwd = newCwd;

    run.resolve({
      output: run.discardOutput ? '' : output,
      exitCode: Number.isFinite(exitCode) ? exitCode : -1,
      durationMs,
      newCwd,
      truncated,
    });
  }

  /**
   * Schedule the interactive-prompt detection scan. Called from
   * `handleData` on every inbound chunk, replacing any prior timer.
   * When it fires, scans the last line of the cumulative ring
   * text past `streamCursor` for one of the recognized prompt
   * patterns; if matched (and we haven't already notified for the
   * same idle window), invokes `onPromptDetected`.
   */
  private armPromptIdleTimer(): void {
    const run = this.currentRun;
    if (!run || !run.onPromptDetected) return;
    const timer = setTimeout(() => {
      if (this.currentRun !== run) return;
      if (run.promptPending) return;
      const { text } = run.ring.value();
      // Examine the LAST un-newline-terminated line in the ring.
      // An interactive prompt deliberately omits the trailing
      // newline (the program is waiting for the user to type
      // before flushing), so the prompt line is whatever sits
      // between the last `\n` and end-of-buffer. ANSI escapes
      // stripped so a colored `Password:` still detects.
      const lastNl = text.lastIndexOf('\n');
      const lastLine = (lastNl === -1 ? text : text.slice(lastNl + 1))
        .replace(ANSI_REGEX, '')
        .replace(/\r$/, '');
      if (lastLine === '') return;
      let mode: 'text' | 'password' | 'yes-no' | null = null;
      if (PROMPT_PASSWORD_RE.test(lastLine)) mode = 'password';
      else if (PROMPT_YESNO_RE.test(lastLine)) mode = 'yes-no';
      else if (PROMPT_GENERIC_RE.test(lastLine)) mode = 'text';
      if (!mode) return;
      run.promptPending = true;
      try {
        run.onPromptDetected?.({ promptLine: lastLine, mode });
      } catch (err) {
        log.warn(`onPromptDetected threw: ${err instanceof Error ? err.message : String(err)}`);
      }
    }, INPUT_PROMPT_IDLE_MS);
    timer.unref?.();
    run.promptIdleTimer = timer;
  }

  /**
   * Fire `onChunk` for any new bytes since the previous call,
   * stopping at the OUTPUT sentinel. With slave-side echo
   * suppressed by `stty -echo` (set up in `start()`), every byte
   * the master receives is real command output — no echo lines to
   * filter — so the logic is just "stream what's new, trim the
   * trailing sentinel when it arrives." Falls into a `disabled`
   * mode if the 200KB ring buffer rolls over; the batched final
   * message still delivers correctly via the resolve path.
   */
  private tryStreamChunks(text: string): void {
    const run = this.currentRun;
    if (!run || !run.onChunk) return;
    if (run.streamState === 'done' || run.streamState === 'disabled') return;
    if (text.length < run.streamCursor) {
      run.streamState = 'disabled';
      return;
    }
    if (text.length <= run.streamCursor) return;

    // PowerShell's interactive line editor paints the prompt + submitted
    // command into ConPTY before real process output. Hold live delivery
    // until that echoed line is complete, then begin after it. This also
    // absorbs any late prompt-color bytes emitted just after the preceding
    // sentinel.
    if (this.platform === 'win32' && run.windowsOutputStart === undefined) {
      const outputStart = findWindowsOutputStart(text, run.command);
      if (outputStart === null) return;
      run.windowsOutputStart = outputStart;
      run.streamCursor = outputStart;
      if (text.length <= run.streamCursor) return;
    }

    // If the OUTPUT sentinel is in the new bytes, stream only up
    // to its start (with the leading `\n` from the printf format
    // trimmed off too). Mark done so subsequent handleData calls
    // don't emit trailing prompt noise as late chunks.
    const newText = text.slice(run.streamCursor);
    const outputRe = new RegExp(`\\n?${escapeRegex(run.sentinel)}\\|\\d+\\|`);
    const sentinelMatch = outputRe.exec(newText);
    let chunk: string;
    if (sentinelMatch) {
      chunk = newText.slice(0, sentinelMatch.index);
      run.streamCursor += sentinelMatch.index;
      run.streamState = 'done';
    } else {
      chunk = newText;
      run.streamCursor = text.length;
    }
    if (chunk.length > 0) {
      // CRLF→LF normalization on the chunk for clean display. A
      // `\r` at the end of a chunk pairing with a `\n` at the
      // start of the next would produce `\n\n` — accepting the
      // rare double-newline trade rather than buffering trailing
      // `\r` bytes (most tools emit `\r\n` atomically).
      run.onChunk(chunk.replace(/\r\n/g, '\n').replace(/\r/g, '\n'));
    }
  }

  /**
   * Normalize CRLF to LF, trim trailing whitespace. ANSI escape
   * sequences are deliberately preserved — the client's
   * `AnsiOutput` component renders them into styled spans.
   * Callers that need a plain-text copy (history audit, log
   * exports, future "plain mode") can pass the result through
   * `stripAnsi()`.
   */
  private cleanOutput(raw: string): string {
    return raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\s+$/, '');
  }

  private lineSeparator(): string {
    // A PTY receives keystrokes, not a text file. Enter is CR on ConPTY;
    // CRLF injects a second PSReadLine keypress and can open a `>>` prompt.
    return this.platform === 'win32' ? '\r' : '\n';
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Remove the bash-echoed `printf …<sentinel>… ` line that precedes
 * the actual printf output in the PTY stream. Bash echoes input
 * before executing it, and our marker `printf` line contains the
 * sentinel verbatim — so the data buffer up to the sentinel
 * regex match looks like:
 *
 *   [optional command output]
 *   printf '\n%s|%s|%s\n' "<sentinel>" "$?" "$PWD"\r\n
 *
 * We need to drop everything from that `printf` line backward
 * through the closing newline. Finding it: look for the sentinel
 * substring in `rawBefore`; if found, slice past the next `\n`.
 * (The trailing sentinel match in `rawBefore` is the ECHO of our
 * write — the real output occurrence sits AFTER `sentinelStart`,
 * which we already excluded.)
 */
function stripWriteEcho(rawBefore: string, sentinel: string): string {
  const idx = rawBefore.lastIndexOf(sentinel);
  if (idx === -1) return rawBefore;
  const eol = rawBefore.indexOf('\n', idx);
  if (eol === -1) return ''; // echo line never closed — drop everything
  return rawBefore.slice(eol + 1);
}

/**
 * Locate real PowerShell output after PSReadLine's painted prompt + command
 * echo. Returns null until the echoed input line is complete so streaming
 * never flashes the prompt or ANSI-colored command before removing it.
 */
function findWindowsOutputStart(raw: string, command: string): number | null {
  const firstCommandLine = command.split(/\r?\n/, 1)[0]?.trim() ?? '';
  if (!firstCommandLine) return 0;

  let lineStart = 0;
  while (lineStart < raw.length) {
    const lineEnd = raw.indexOf('\n', lineStart);
    if (lineEnd === -1) return null;
    const line = stripControlCharacters(
      stripAnsi(raw.slice(lineStart, lineEnd)).replace(/\r/g, ''),
    );
    if (line.includes(firstCommandLine)) {
      let outputStart = lineEnd + 1;
      // Older CRLF writes could leave one or more continuation prompts.
      // Skip them in persisted history too, while preserving any real line.
      for (;;) {
        const nextEnd = raw.indexOf('\n', outputStart);
        if (nextEnd === -1) {
          const tail = stripAnsi(raw.slice(outputStart)).replace(/\r/g, '').trim();
          return tail === '>>' ? null : outputStart;
        }
        const nextLine = stripAnsi(raw.slice(outputStart, nextEnd)).replace(/\r/g, '').trim();
        if (nextLine !== '>>') return outputStart;
        outputStart = nextEnd + 1;
      }
    }
    lineStart = lineEnd + 1;
  }
  return null;
}

/** Remove PowerShell's prompt/input paint from the final transcript. */
function stripWindowsWriteEcho(rawBefore: string, command: string): string {
  const outputStart = findWindowsOutputStart(rawBefore, command);
  return outputStart === null ? rawBefore : rawBefore.slice(outputStart);
}

function stripControlCharacters(value: string): string {
  let clean = '';
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code >= 0x20 && code !== 0x7f) clean += char;
  }
  return clean;
}

function pickPlatformShell(): {
  file: string;
  args: string[];
  initLines: string[];
  platform: 'posix' | 'win32';
} {
  if (process.platform === 'win32') {
    return {
      file: 'powershell.exe',
      args: ['-NoLogo', '-NoProfile'],
      initLines: [
        '$ErrorActionPreference = "Continue"',
        '$OutputEncoding = [System.Text.Encoding]::UTF8',
        '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
      ],
      platform: 'win32',
    };
  }
  // Prefer /bin/bash for determinism. `--norc --noprofile` skips
  // user dotfiles so PS1, aliases, env vars don't poison the marker
  // protocol. `-i` ensures the shell behaves as interactive (keeps
  // job control, won't exit on EOF until we ask it to).
  return {
    file: '/bin/bash',
    args: ['--norc', '--noprofile', '-i'],
    // NOTE: we deliberately KEEP monitor mode (job control) on,
    // which is the bash `-i` default. With `set +m`, commands run
    // in the shell's own process group — so writing `\x03` to the
    // PTY would deliver SIGINT to both `sleep` AND `bash`, taking
    // out the shell on every Ctrl+C. With job control on (default),
    // each foreground command gets its own process group and
    // Ctrl+C only kills the command. The occasional `[1]+ Done`
    // line from a backgrounded command is a small price for
    // correct cancellation.
    initLines: ["export PS1=''", "export PS2=''"],
    platform: 'posix',
  };
}
