import { type ChildProcess, spawn as nodeSpawn } from 'node:child_process';
import { join } from 'node:path';
import { createLogger, stripMcpPrefix, toolActivityLabel } from '@bendyline/gezel';
import { windowsHeadlessSpawnOptions } from '@bendyline/gezel/native';
import { SessionResumeError } from '../types.js';
import type { SessionOpts, ToolArgsDeltaMeta, ToolCallEvent, TurnUsage } from '../types.js';
import { buildTurnUsage } from '../usage-builder.js';
import type { ClaudePermissionMode } from './provider.js';
import {
  claudeRateLimitBuckets,
  recordClaudeRateLimitWindow,
  writeClaudeQuotaCaptureFiles,
} from './quota.js';
import { formatRateLimitNotice } from './rate-limit-notice.js';
import type { ClaudeReasoningEffort } from './reasoning.js';
import {
  type ClaudeMcpServerEntry,
  writeRuntimeMcpConfig,
  writeRuntimeTextFile,
} from './runtime-files.js';
import { isResumeFailureSignal } from './session.js';
import { type StreamEvent, parseStreamLine } from './stream-parser.js';

const log = createLogger('anthropic-cli');

/**
 * One long-lived `claude` subprocess pinned to a single chat session.
 *
 * Replaces the original per-turn-spawn loop with a stream-json input mode:
 *   `claude --input-format stream-json --output-format stream-json …`
 *
 * Each user turn is one NDJSON line written to stdin; the worker reads
 * stream-json events from stdout and resolves the per-turn promise on the
 * first `result` event. The process stays alive between turns so the
 * cold-start cost (~1-2s of bundle parse + auth probe + MCP discovery) is
 * paid once per session, not once per turn.
 *
 * Lifecycle is driven by the surrounding `ClaudeWorkerPool`. Workers report
 * idle eviction (timer-based) and crash exits (child-died-mid-turn) back to
 * the pool via callbacks; the pool decides whether to dispose or keep them.
 */

const TURN_TIMEOUT_DEFAULT_MS = 600_000; // 10 min — long tool loops can be slow.
const KILL_GRACE_MS = 3_000;
const STDIN_CLOSE_GRACE_MS = 3_000;
const STDERR_RING_CAP = 64 * 1024;
/**
 * Cadence at which we fire synthetic `heartbeat` events with the current
 * turn phase label. The CLI is silent during MCP server initialization,
 * model cold-start, and long-running tool calls (browser_navigate, Bash
 * commands that take a while); without periodic heartbeats the UI's
 * "silent for Xs" banner climbs and the user can't tell whether the
 * turn is alive. 3s is short enough to feel responsive without
 * spamming the chat event bus.
 */
const HEARTBEAT_INTERVAL_MS = 3_000;

/**
 * Once a turn has gone {@link SILENCE_THRESHOLD_MS} without any stream
 * event from the CLI (no thinking-delta, no text-delta, no tool-use,
 * etc), the heartbeat starts annotating its label with "(silent Ns)"
 * so the user can tell "Claude is genuinely reasoning" from "the
 * worker is wedged on something." Below this threshold we keep the
 * label clean — momentary gaps between deltas shouldn't read as
 * silence to the user.
 */
const SILENCE_THRESHOLD_MS = 15_000;

/**
 * Minimum accumulated argument text before a tool's streamed arguments
 * become visible as a live "working" block. The CLI fires tool calls
 * constantly and most carry trivial arguments — a `Read` path or a
 * `Grep` pattern is complete in one fragment, so surfacing it would
 * flash a block for a few hundred milliseconds before the finished tool
 * row supersedes it. The channel exists for the opposite case: a long
 * `write_file` whose content is the only thing happening for minutes.
 * Fragments below the threshold are buffered, and flushed in full the
 * moment a call crosses it, so nothing is lost from what we do show.
 */
const TOOL_ARGS_VISIBILITY_THRESHOLD = 400;

/**
 * Heartbeat label for a thinking phase. Once the CLI has reported any
 * thinking-token estimate, the count rides along so a long deliberation
 * reads as measurable progress rather than an unexplained pause.
 */
function thinkingPhaseLabel(thinkingTokens: number): string {
  return thinkingTokens > 0 ? `thinking · ${thinkingTokens} tokens` : 'thinking';
}

/**
 * State machine. Transitions:
 *   stopped → starting → running.idle ⇄ running.busy
 *                            ↓ (crash / timeout / abort)
 *                          crashed
 *   any → shutting-down → stopped
 */
export type WorkerState =
  | { kind: 'stopped' }
  | { kind: 'starting' }
  | { kind: 'running.idle' }
  | { kind: 'running.busy' }
  | { kind: 'crashed'; reason: string }
  | { kind: 'shutting-down' };

/**
 * Hooks the surrounding session passes per-turn. The worker itself is
 * stateless w.r.t. event subscribers — the session class owns the
 * `StreamingSessionBase` subscription plumbing and just forwards `emit*`
 * methods through here.
 */
export interface WorkerTurnHooks {
  emitDelta(text: string): void;
  /**
   * Private chain-of-thought. Routed to the session's reasoning channel,
   * NOT `emitDelta` — the trace must stay out of the committed reply
   * body, the abort-salvage buffer, and the OpenAI-/Ollama-compat
   * forwarders that serve Connected Apps from these same sessions.
   */
  emitReasoningDelta(text: string): void;
  emitHeartbeat(label?: string): void;
  emitToolArgsDelta(name: string, chunk: string, meta?: ToolArgsDeltaMeta): void;
  emitWarning(message: string): void;
  emitUsage(usage: TurnUsage): void;
  onToolCall?: (ev: ToolCallEvent) => void | Promise<void>;
  knownSecretValues?: Set<string>;
}

export interface ClaudeWorkerOpts {
  binaryPath: string;
  model: string;
  reasoningEffort?: ClaudeReasoningEffort;
  permissionMode: ClaudePermissionMode;
  systemMessage: string;
  context: NonNullable<SessionOpts['claudeCliContext']>;
  runtimeDir: string;
  manageRuntimeFiles: boolean;
  mcpServer?: SessionOpts['mcpServer'];
  extraMcpServers?: SessionOpts['extraMcpServers'];
  /** Captured `claudeSessionId` from a prior worker, if any. Threaded as `--resume <id>` on the initial spawn. */
  initialResumeId?: string;
  /** Idle timeout: after this many ms with no turn activity, the worker self-evicts. */
  idleTimeoutMs?: number;
  /** Pool callback fired when the idle timer expires (the worker calls `kill()` first). */
  onIdleEvict?: () => void;
  /** Pool callback fired when the child crashes outside a turn (or mid-turn after the pending turn rejects). */
  onCrash?: (err: Error) => void;
  /** Test seam — defaults to `node:child_process.spawn`. */
  spawnImpl?: typeof nodeSpawn;
  /** Test seam — defaults to `Date.now`. */
  now?: () => number;
}

export interface SendTurnOpts {
  timeoutMs?: number;
  signal?: AbortSignal;
}

interface PendingToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  startedAt: number;
}

/**
 * Per-`tool_use`-block argument streaming state. Keyed by content-block
 * index, which restarts at 0 on every assistant message — hence the
 * `content-block-stop` cleanup rather than a turn-lifetime map.
 */
interface ToolArgsBlock {
  name: string;
  id: string;
  /** Withheld fragments, flushed once the block crosses the visibility threshold. */
  buffered: string;
  charCount: number;
  visible: boolean;
}

interface TurnState {
  assistantText: string;
  finalText: string | undefined;
  pendingTools: Map<string, PendingToolCall>;
  toolArgBlocks: Map<number, ToolArgsBlock>;
  thinking: boolean;
  /**
   * Running total of the CLI's own thinking-token estimates, summed from
   * `estimated_tokens_delta`. Summing the deltas rather than trusting the
   * cumulative field keeps the total correct whether or not the counter
   * restarts on each assistant message.
   */
  thinkingTokens: number;
  usage?: {
    inputTokens: number;
    cachedInputTokens?: number;
    outputTokens: number;
    costUsd?: number;
  };
  success: boolean;
  /**
   * Set as soon as we receive any `partial-text-delta` /
   * `partial-thinking-delta` event. While set, block-granularity
   * snapshot events are suppressed to avoid double-emitting the same
   * content the partial deltas already streamed.
   */
  usingPartialStream: boolean;
}

interface PendingTurn {
  startedAt: number;
  hooks: WorkerTurnHooks;
  state: TurnState;
  resolve: (text: string) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout | null;
  /**
   * Periodic timer firing every {@link HEARTBEAT_INTERVAL_MS} that emits
   * a synthetic `heartbeat` carrying {@link PendingTurn.currentPhase}.
   * Cleared in {@link ClaudeWorker.completePendingTurn} /
   * {@link ClaudeWorker.failPendingTurn}.
   */
  heartbeatTimer: NodeJS.Timeout | null;
  /**
   * Human-readable label of what the worker is currently doing. Drives
   * the heartbeat label and lets the chat UI show concrete status text
   * during the gaps between stream events. Updated as new events
   * arrive — see {@link ClaudeWorker.dispatchTurnEvent}.
   */
  currentPhase: string;
  /**
   * Wall-clock of the last stream event received from the CLI for this
   * turn. Drives the "silent for Ns" suffix on the heartbeat label —
   * the periodic heartbeat keeps the same `currentPhase` while the
   * model reasons internally, so without this the user can't tell
   * "Claude is thinking" from "the worker is wedged." Reset on
   * spawn (turn start) and refreshed in {@link ClaudeWorker.dispatchTurnEvent}.
   */
  lastEventAt: number;
  signal?: AbortSignal;
  onAbort?: () => void;
  /** True when the spawn was launched with `--resume <id>` and we haven't seen `system.init` yet. Drives `SessionResumeError` mapping. */
  attemptedResumeId: string | null;
}

export class ClaudeWorker {
  private state: WorkerState = { kind: 'stopped' };
  private child: ChildProcess | null = null;
  private capturedSessionId: string | null;
  private mcpConfigPath: string | null = null;
  private quotaSettingsPath: string | null = null;
  private systemPromptPath: string | null = null;
  private pending: PendingTurn | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private startupAttemptedResumeId: string | null = null;
  /**
   * Set as soon as we observe a `result` event for any turn — i.e. the
   * worker has successfully completed at least one user turn. Drives the
   * "is this an early-exit-before-first-turn?" classification in
   * onChildClose: a process that dies without ever producing a result is
   * a likely resume-id failure or startup-args failure, and stderr is
   * matched against `isResumeFailureSignal` accordingly.
   */
  private seenFirstResult = false;
  /**
   * Set when the child exits unexpectedly outside of a turn (so there's
   * no pending promise to reject). The next `sendTurn` throws this
   * verbatim — preserves SessionResumeError classification across the
   * gap between close-event and the subsequent send.
   */
  private lastCrashError: Error | null = null;
  /**
   * Posture key of the last rate-limit notice shown to the user. The CLI
   * repeats `rate_limit_event` on every turn for as long as the window
   * stays in the same state; without this the chat would carry the same
   * banner on every reply until the window reset. Workers are keyed by
   * session, so this is session-scoped suppression.
   */
  private lastRateLimitKey: string | null = null;
  private stdoutBuffer = '';
  private stderrChunks: string[] = [];
  private stderrSize = 0;
  private lastUsedAtMs: number;
  private readonly idleTimeoutMs: number;
  private readonly nowFn: () => number;
  private readonly spawn: typeof nodeSpawn;

  constructor(private readonly opts: ClaudeWorkerOpts) {
    this.capturedSessionId = opts.initialResumeId ?? null;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 600_000;
    this.nowFn = opts.now ?? Date.now;
    this.spawn = opts.spawnImpl ?? nodeSpawn;
    this.lastUsedAtMs = this.nowFn();
  }

  // ── Accessors used by the pool ────────────────────────────────────────

  /** The Claude-side session id we captured from `system.init`. Stays `null` until that event arrives. */
  claudeSessionId(): string | null {
    return this.capturedSessionId;
  }

  /** Last-used timestamp for the pool's LRU. Updated on every turn entry / completion. */
  lastUsedAt(): number {
    return this.lastUsedAtMs;
  }

  /** True when state is `running.idle` or `running.busy`. */
  isAlive(): boolean {
    return this.state.kind === 'running.idle' || this.state.kind === 'running.busy';
  }

  /** True only when ready to accept another turn (no pending in-flight). */
  idle(): boolean {
    return this.state.kind === 'running.idle';
  }

  currentState(): WorkerState {
    return this.state;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  /**
   * Spawn the child and resolve as soon as the spawn syscall succeeds.
   *
   * Why we DON'T wait for `system.init`: the CLI in stream-json INPUT
   * mode (`--input-format stream-json`) doesn't emit any output until
   * it receives a user message on stdin — including `system.init`.
   * Waiting for it here would deadlock until our 30s startup timer
   * fired. Instead, we start lazily: the first `sendTurn` writes the
   * user message, and `system.init` (with the upstream session id we
   * persist to `claudeSessionId`) arrives as the first stream event
   * during that turn. Resume failures (`--resume <id>` for a stale
   * upstream session) surface as the child exiting before any `result`
   * event with stderr matching `isResumeFailureSignal` — the close
   * handler classifies that into a `SessionResumeError` thrown from
   * the first `sendTurn`. This matches the behavior of the original
   * per-turn-spawn implementation exactly.
   */
  async start(): Promise<void> {
    if (this.state.kind !== 'stopped') {
      throw new Error(`[anthropic-cli/worker] cannot start: state ${this.state.kind}`);
    }
    this.state = { kind: 'starting' };

    this.mcpConfigPath = await this.writeMcpConfigOnce();
    this.quotaSettingsPath = await this.writeQuotaSettingsOnce();
    this.systemPromptPath = await this.writeSystemPromptOnce();
    const initialResumeId = this.opts.initialResumeId ?? null;
    this.startupAttemptedResumeId = initialResumeId;
    const args = this.buildSpawnArgs(initialResumeId);

    let child: ChildProcess;
    try {
      child = this.spawn(this.opts.binaryPath, args, {
        cwd: this.opts.context.cwd,
        env: {
          ...process.env,
          ...(this.opts.reasoningEffort
            ? { CLAUDE_CODE_EFFORT_LEVEL: this.opts.reasoningEffort }
            : {}),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        ...windowsHeadlessSpawnOptions(),
      });
    } catch (err) {
      this.state = { kind: 'crashed', reason: 'spawn failed' };
      throw err instanceof Error ? err : new Error(String(err));
    }
    this.child = child;

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => this.onStdout(chunk));
    child.stderr?.on('data', (chunk: string) => this.onStderr(chunk));
    child.on('error', (err) => this.onChildError(err));
    child.on('close', (code) => this.onChildClose(code));

    // Transition to ready immediately. If the process dies before the
    // first turn writes anything, `onChildClose` captures the failure
    // into `lastCrashError` (or rejects a pending turn directly), and
    // the next `sendTurn` surfaces it.
    this.state = { kind: 'running.idle' };
    this.resetIdleTimer();
  }

  /**
   * Send one user turn. Worker must be in `running.idle`. Resolves with the
   * final assistant text when the CLI emits its `result` event; rejects on
   * timeout, abort, child crash, or a result with `success: false`.
   */
  async sendTurn(prompt: string, hooks: WorkerTurnHooks, opts?: SendTurnOpts): Promise<string> {
    // If the child died between turns (or right after spawn) the close
    // handler stashed the classified error here. Re-throw it as the
    // tool result for the asker. SessionResumeError specifically
    // propagates up through ChatManager's resume-fallback path.
    if (this.state.kind === 'crashed' && this.lastCrashError) {
      const err = this.lastCrashError;
      this.lastCrashError = null;
      throw err;
    }
    if (this.state.kind !== 'running.idle') {
      throw new Error(`[anthropic-cli/worker] cannot send turn: state ${this.state.kind}`);
    }
    if (!this.child || !this.child.stdin || this.child.stdin.destroyed) {
      throw new Error('[anthropic-cli/worker] no stdin available');
    }

    this.markUsed();
    this.cancelIdleTimer();
    this.state = { kind: 'running.busy' };

    return new Promise<string>((resolve, reject) => {
      const timeoutMs = opts?.timeoutMs ?? TURN_TIMEOUT_DEFAULT_MS;
      const startedAt = this.nowFn();
      const turn: PendingTurn = {
        startedAt,
        hooks,
        state: {
          assistantText: '',
          finalText: undefined,
          pendingTools: new Map(),
          toolArgBlocks: new Map(),
          thinking: false,
          thinkingTokens: 0,
          usage: undefined,
          success: true,
          usingPartialStream: false,
        },
        resolve,
        reject,
        timer: null,
        heartbeatTimer: null,
        currentPhase: 'preparing',
        lastEventAt: startedAt,
        attemptedResumeId: null, // resume only matters at startup; subsequent turns reuse the live process
      };
      this.pending = turn;

      // The CLI is silent until MCP servers initialize and the model
      // produces its first token — easily 5–30 s on a cold worker with
      // toolset extras. Fire an immediate heartbeat so the UI's silent-
      // watchdog doesn't climb during that window, then keep a
      // periodic heartbeat going for the rest of the turn. The
      // heartbeat label tracks the most recent phase (preparing /
      // thinking / streaming / a concrete tool name) and is transient — it
      // clears on the first delta. We deliberately do NOT emit a
      // `preparing` intent: intents persist as HR dividers on the
      // saved message, so a startup-state intent would carve
      // "PREPARING" into every assistant bubble at offset 0. The
      // ChatManager-side filter drops it as a belt-and-braces measure.
      hooks.emitHeartbeat(turn.currentPhase);
      turn.heartbeatTimer = setInterval(() => {
        if (this.pending !== turn) return;
        const silentMs = this.nowFn() - turn.lastEventAt;
        if (silentMs >= SILENCE_THRESHOLD_MS) {
          const silentSec = Math.round(silentMs / 1000);
          hooks.emitHeartbeat(`${turn.currentPhase} · silent ${silentSec}s`);
        } else {
          hooks.emitHeartbeat(turn.currentPhase);
        }
      }, HEARTBEAT_INTERVAL_MS);
      turn.heartbeatTimer.unref?.();

      // Wallclock-based deadline poll. Node `setTimeout(timeoutMs)`
      // pauses when macOS suspends the process during sleep, so a
      // turn started just before sleep won't abort `timeoutMs` later
      // — the timer effectively re-anchors to wake time and the user
      // sees a multi-thousand-second hang. setInterval also pauses,
      // but the first post-wake tick compares `Date.now()` to the
      // precomputed wallclock `turnDeadline` and aborts within the
      // poll period.
      const turnDeadline = this.nowFn() + timeoutMs;
      turn.timer = setInterval(() => {
        if (this.pending !== turn) return;
        if (this.nowFn() < turnDeadline) return;
        this.failPendingTurn(
          new Error(`[anthropic-cli/worker] turn timed out after ${Math.round(timeoutMs / 1000)}s`),
          { kill: true, reason: 'turn timeout' },
        );
      }, 2_000);
      turn.timer.unref?.();

      if (opts?.signal) {
        const onAbort = () => {
          if (this.pending !== turn) return;
          const err = new Error('[anthropic-cli/worker] aborted');
          (err as Error & { name: string }).name = 'AbortError';
          this.failPendingTurn(err, { kill: true, reason: 'aborted' });
        };
        if (opts.signal.aborted) {
          onAbort();
          return;
        }
        opts.signal.addEventListener('abort', onAbort, { once: true });
        turn.signal = opts.signal;
        turn.onAbort = onAbort;
      }

      const line = `${JSON.stringify({
        type: 'user',
        message: { role: 'user', content: prompt },
      })}\n`;
      this.child!.stdin!.write(line, 'utf8', (err) => {
        if (err && this.pending === turn) {
          this.failPendingTurn(err, { kill: true, reason: 'stdin write failed' });
        }
      });
    });
  }

  /**
   * Graceful shutdown — close stdin, wait briefly for the child to exit on
   * its own, then SIGTERM and finally SIGKILL.
   */
  async shutdown(): Promise<void> {
    if (this.state.kind === 'stopped') return;
    if (this.state.kind === 'shutting-down') return;
    this.state = { kind: 'shutting-down' };
    this.cancelIdleTimer();

    // Reject any in-flight turn so callers don't hang.
    if (this.pending) {
      this.failPendingTurn(new Error('[anthropic-cli/worker] worker shutting down'), {
        kill: false,
        reason: 'shutdown',
      });
    }

    const child = this.child;
    if (!child) {
      this.state = { kind: 'stopped' };
      return;
    }

    // Close stdin to signal graceful shutdown to the CLI.
    try {
      child.stdin?.end();
    } catch {
      /* already closed */
    }

    // Wait for natural exit, then escalate.
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      const onExit = () => finish();
      child.once('exit', onExit);

      setTimeout(() => {
        if (!done) {
          try {
            child.kill('SIGTERM');
          } catch {
            /* already exited */
          }
        }
      }, STDIN_CLOSE_GRACE_MS).unref?.();

      setTimeout(() => {
        if (!done) {
          try {
            child.kill('SIGKILL');
          } catch {
            /* already exited */
          }
        }
      }, STDIN_CLOSE_GRACE_MS + KILL_GRACE_MS).unref?.();
    });

    this.child = null;
    this.state = { kind: 'stopped' };
  }

  /** Synchronous SIGTERM → SIGKILL. Used by crash paths and pool eviction-on-error. */
  kill(): void {
    const child = this.child;
    if (!child) return;
    this.cancelIdleTimer();
    try {
      child.kill('SIGTERM');
    } catch {
      /* already exited */
    }
    const force = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already exited */
      }
    }, KILL_GRACE_MS);
    force.unref?.();
  }

  // ── Internals ────────────────────────────────────────────────────────

  private markUsed(): void {
    this.lastUsedAtMs = this.nowFn();
  }

  private resetIdleTimer(): void {
    this.cancelIdleTimer();
    if (this.idleTimeoutMs <= 0) return;
    this.idleTimer = setTimeout(() => {
      if (this.state.kind !== 'running.idle') return;
      // Fire onIdleEvict; pool will call shutdown() on us.
      this.opts.onIdleEvict?.();
    }, this.idleTimeoutMs);
    this.idleTimer.unref?.();
  }

  private cancelIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private buildSpawnArgs(resumeId: string | null): string[] {
    // `--print`/`-p` is what makes `--include-partial-messages` actually
    // emit `stream_event` content_block_delta events (per-token deltas).
    // Without it, the CLI silently downgrades to block-granularity
    // `assistant` events (one chunk per content block, when the block
    // completes), and the user sees replies arriving in paragraph-sized
    // jumps. The docs say `--include-partial-messages` "Requires
    // --print and --output-format stream-json" — meaning literally,
    // not just for the docs example.
    //
    // Combined with `--input-format stream-json`, the CLI in print mode
    // accepts a sequence of NDJSON user messages on stdin and processes
    // each as its own turn while staying alive between them. That's the
    // long-lived multi-turn pattern this worker is built around.
    const args: string[] = [
      '--print',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--model',
      this.opts.model,
      '--permission-mode',
      this.opts.permissionMode,
    ];
    // Deliver the gezel system prompt via a file, NOT inline. Full role
    // prompts routinely exceed Windows' ~32 KB `CreateProcessW` command-line
    // limit; passing them as `--append-system-prompt <huge>` overflows it and
    // the spawn dies with `ENAMETOOLONG`. `writeSystemPromptOnce` stages the
    // prompt under the runtime dir and we point the CLI at it with
    // `--append-system-prompt-file`, which keeps the command line tiny (and
    // keeps the prompt out of OS process listings). We fall back to the inline
    // flag only when runtime-file management is disabled
    // (`manageRuntimeFiles = false` — tests / opt-out installs, where prompts
    // are small).
    if (this.systemPromptPath) {
      args.push('--append-system-prompt-file', this.systemPromptPath);
    } else if (this.opts.systemMessage) {
      args.push('--append-system-prompt', this.opts.systemMessage);
    }
    if (this.mcpConfigPath) {
      args.push('--mcp-config', this.mcpConfigPath);
      args.push('--permission-prompt-tool', 'mcp__gezel__request_tool_permission');
    }
    if (this.quotaSettingsPath) {
      args.push('--settings', this.quotaSettingsPath);
    }
    if (resumeId) {
      args.push('--resume', resumeId);
    }
    // `--disallowedTools` blocks Claude CLI built-ins for delegation
    // roles whose toolset groups don't cover `workspace-fs-read` /
    // `workspace-fs-write` / `code-execution` / `web`. Without this, a
    // Meester would happily `Bash`/`Write` instead of routing the work
    // to a specialist via `ensure_gezel` + `message_gezel`.
    const disallowed = this.opts.context.disallowedBuiltinTools;
    if (disallowed && disallowed.length > 0) {
      args.push('--disallowedTools', disallowed.join(','));
    }
    // `--allowedTools` auto-approves both the role's allowed Claude
    // built-ins AND our own gezel-mcp tools (prefixed with
    // `mcp__gezel__`). The user already approved that surface
    // implicitly by giving the gezel its role; popping a permission
    // card on every `Bash`/`Write`/`Edit` or every `save_memory`/
    // `list_projects` is friction. Extra MCP servers (Playwright,
    // GitHub, …) keep flowing through the prompt-tool path — they
    // carry side effects beyond the trusted gezel-mcp surface.
    const allowed = [
      ...(this.opts.context.allowedBuiltinTools ?? []),
      ...(this.opts.context.allowedMcpTools ?? []),
    ];
    if (allowed.length > 0) {
      args.push('--allowedTools', allowed.join(','));
    }
    return args;
  }

  /**
   * Stage the gezel system prompt as a runtime file so it can be passed via
   * `claude --append-system-prompt-file <path>` instead of inline on the
   * command line. See the note in {@link buildSpawnArgs} for the
   * `ENAMETOOLONG` motivation.
   *
   * Returns the absolute path, or `null` when there's nothing to write
   * (empty prompt) or runtime-file management is disabled
   * (`manageRuntimeFiles = false`) — in which case `buildSpawnArgs` falls
   * back to the inline `--append-system-prompt` flag. Written to a sibling
   * of the `.mcp.json` under `<runtimeDir>/<projectId>/<sessionId>.system.md`.
   */
  private async writeSystemPromptOnce(): Promise<string | null> {
    if (!this.opts.manageRuntimeFiles) return null;
    if (!this.opts.systemMessage) return null;
    const path = join(
      this.opts.runtimeDir,
      this.opts.context.projectId,
      `${this.opts.context.sessionId}.system.md`,
    );
    return writeRuntimeTextFile({ path, contents: this.opts.systemMessage });
  }

  private async writeQuotaSettingsOnce(): Promise<string | null> {
    if (!this.opts.manageRuntimeFiles) return null;
    return writeClaudeQuotaCaptureFiles({
      runtimeDir: this.opts.runtimeDir,
      projectId: this.opts.context.projectId,
      sessionId: this.opts.context.sessionId,
    });
  }

  private async writeMcpConfigOnce(): Promise<string | null> {
    if (!this.opts.manageRuntimeFiles) return null;
    if (
      !this.opts.mcpServer &&
      (!this.opts.extraMcpServers || this.opts.extraMcpServers.length === 0)
    ) {
      return null;
    }
    const servers: Record<string, ClaudeMcpServerEntry> = {};
    if (this.opts.mcpServer) {
      servers.gezel = {
        command: this.opts.mcpServer.command,
        args: this.opts.mcpServer.args,
        env: this.opts.mcpServer.env,
      };
    }
    for (const extra of this.opts.extraMcpServers ?? []) {
      // Claude's `.mcp.json` only carries stdio MCPs in this writer;
      // http-mcp entries are silently skipped — supporting them here
      // would mean an http-shaped entry alongside the stdio ones, plus
      // header/auth plumbing the CLI handles differently.
      if (extra.kind === 'http') continue;
      servers[extra.id] = {
        command: extra.command,
        args: extra.args,
        env: extra.env,
        ...(extra.cwd ? { cwd: extra.cwd } : {}),
      };
    }
    const path = join(
      this.opts.runtimeDir,
      this.opts.context.projectId,
      `${this.opts.context.sessionId}.mcp.json`,
    );
    return writeRuntimeMcpConfig({ path, servers });
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let nl = this.stdoutBuffer.indexOf('\n');
    while (nl >= 0) {
      const line = this.stdoutBuffer.slice(0, nl);
      this.stdoutBuffer = this.stdoutBuffer.slice(nl + 1);
      this.handleStreamLine(line);
      nl = this.stdoutBuffer.indexOf('\n');
    }
  }

  private onStderr(chunk: string): void {
    if (this.stderrSize < STDERR_RING_CAP) {
      this.stderrChunks.push(chunk);
      this.stderrSize += chunk.length;
    }
  }

  private onChildError(err: Error): void {
    if (this.pending) {
      this.failPendingTurn(err, { kill: false, reason: 'child error' });
    } else {
      this.lastCrashError = err;
    }
    this.transitionToCrashed(`child error: ${err.message}`);
  }

  private onChildClose(code: number | null): void {
    // Drain any tail line that wasn't terminated with `\n`.
    if (this.stdoutBuffer.length > 0) {
      this.handleStreamLine(this.stdoutBuffer);
      this.stdoutBuffer = '';
    }

    const stderrText = this.stderrChunks.join('');

    if (this.state.kind === 'shutting-down') {
      // Expected — graceful shutdown completed. Nothing to do.
      return;
    }

    const err = this.classifyCloseError(stderrText, code);

    if (this.pending) {
      // Mid-turn exit. The pending promise is the source of truth for
      // this turn; reject it with the classified error.
      this.failPendingTurn(err, { kill: false, reason: 'mid-turn exit' });
    } else {
      // Crash between turns (or before any turn happened). Stash the
      // error so the next `sendTurn` re-throws it verbatim — preserves
      // SessionResumeError classification across the gap.
      this.lastCrashError = err;
    }
    this.transitionToCrashed(`unexpected exit ${code ?? 'null'}`);
  }

  /**
   * Classify a process-close into the right user-facing error. The
   * primary distinction: did the child die without ever producing a
   * `result` event AND was it launched with `--resume <id>` AND does
   * stderr match a known resume-failure signal? If so, surface as
   * `SessionResumeError` so ChatManager's resume-fallback path can
   * clear the stale id and rebuild a fresh session. Otherwise, a
   * generic exit error.
   */
  private classifyCloseError(stderrText: string, code: number | null): Error {
    if (
      !this.seenFirstResult &&
      this.startupAttemptedResumeId &&
      isResumeFailureSignal({ stderr: stderrText, exitCode: code })
    ) {
      this.capturedSessionId = null;
      return new SessionResumeError(
        `[anthropic-cli/worker] session ${this.startupAttemptedResumeId} not found upstream`,
      );
    }
    const detail = stderrText.trim() || `exit ${code ?? 'null'}`;
    return new Error(
      `[anthropic-cli/worker] claude exited${this.seenFirstResult ? ' mid-conversation' : ' before first turn'}: ${detail.slice(0, 1000)}`,
    );
  }

  private transitionToCrashed(reason: string): void {
    if (this.state.kind === 'crashed' || this.state.kind === 'stopped') return;
    this.state = { kind: 'crashed', reason };
    this.cancelIdleTimer();
    this.opts.onCrash?.(new Error(`[anthropic-cli/worker] ${reason}`));
  }

  /**
   * Drop the in-flight turn with `err`. If `kill` is true, the worker is
   * unsalvageable (timeout or abort) — kill the child and transition to
   * crashed so the pool replaces us. Otherwise we stay idle.
   */
  private failPendingTurn(err: Error, opts: { kill: boolean; reason: string }): void {
    const turn = this.pending;
    if (!turn) return;
    this.pending = null;
    if (turn.timer) clearInterval(turn.timer);
    if (turn.heartbeatTimer) clearInterval(turn.heartbeatTimer);
    if (turn.signal && turn.onAbort) {
      try {
        turn.signal.removeEventListener('abort', turn.onAbort);
      } catch {
        /* ignore */
      }
    }
    if (opts.kill) {
      this.kill();
      this.transitionToCrashed(opts.reason);
    } else if (this.state.kind === 'running.busy') {
      // Soft fail (shutdown). Don't keep the worker around as idle —
      // shutdown() owns the state transition to stopped.
    }
    turn.reject(err);
  }

  private handleStreamLine(line: string): void {
    const event = parseStreamLine(line);
    if (!event) return;
    if (event.kind === 'malformed') {
      log.warn(`[anthropic-cli/worker] malformed stream line: ${event.error}`);
      return;
    }

    if (event.kind === 'session-init') {
      // Arrives during the first turn (the CLI doesn't emit anything
      // until the first user message in stream-json input mode). The
      // `claudeSessionId` we capture here is what gets persisted on
      // `ChatSession.providerState` for next-process `--resume`.
      if (!this.capturedSessionId) {
        this.capturedSessionId = event.sessionId;
      }
      return;
    }

    // All non-init events flow into the pending turn. If we have no
    // pending turn (e.g., the CLI emitted something between turns), we
    // ignore them — but `result` arriving with no pending turn would be
    // weird, so we log it.
    const turn = this.pending;
    if (!turn) {
      if (event.kind === 'result') {
        log.warn('[anthropic-cli/worker] result event with no pending turn — ignoring');
      }
      return;
    }
    this.dispatchTurnEvent(event, turn);
  }

  private dispatchTurnEvent(
    event:
      | Exclude<StreamEvent, { kind: 'malformed' } | { kind: 'session-init' } | { kind: 'unknown' }>
      | { kind: 'unknown'; type: string },
    turn: PendingTurn,
  ): void {
    const state = turn.state;
    const hooks = turn.hooks;
    // Any event from the CLI counts as activity for the silence
    // watchdog — incl. tool-use, tool-result, partial-thinking-delta,
    // etc. The heartbeat tick reads `lastEventAt` to decide whether
    // to annotate its label with "silent Ns".
    turn.lastEventAt = this.nowFn();
    switch (event.kind) {
      case 'partial-text-delta':
        state.usingPartialStream = true;
        state.assistantText += event.text;
        turn.currentPhase = 'streaming';
        if (state.thinking) state.thinking = false;
        hooks.emitDelta(event.text);
        return;
      case 'partial-thinking-delta':
        state.usingPartialStream = true;
        turn.currentPhase = thinkingPhaseLabel(state.thinkingTokens);
        hooks.emitReasoningDelta(event.text);
        if (!state.thinking) {
          state.thinking = true;
          hooks.emitHeartbeat(turn.currentPhase);
        }
        return;
      case 'text-delta':
        if (state.usingPartialStream) return;
        state.assistantText += event.text;
        turn.currentPhase = 'streaming';
        if (state.thinking) state.thinking = false;
        hooks.emitDelta(event.text);
        return;
      case 'thinking-delta':
        if (state.usingPartialStream) return;
        turn.currentPhase = thinkingPhaseLabel(state.thinkingTokens);
        hooks.emitReasoningDelta(event.text);
        if (!state.thinking) {
          state.thinking = true;
          hooks.emitHeartbeat(turn.currentPhase);
        }
        return;
      case 'thinking-tokens':
        // The CLI's own running estimate. Worth surfacing even when the
        // reasoning text itself is not rendered: a climbing token count
        // is the difference between "deliberating" and "wedged".
        state.thinkingTokens += event.deltaTokens;
        if (state.thinking) turn.currentPhase = thinkingPhaseLabel(state.thinkingTokens);
        return;
      case 'status':
        // `requesting` fires as each API call goes out — after a tool
        // result the model is waiting on the wire, not running a tool.
        if (event.status === 'requesting' && !state.thinking) {
          turn.currentPhase = thinkingPhaseLabel(state.thinkingTokens);
        }
        return;
      case 'rate-limit': {
        // Silent on the happy path — `allowed` arrives on every turn and
        // a warning per turn would train the user to ignore the channel.
        // The same reasoning applies once the posture *is* worth saying:
        // the CLI repeats it every turn until the window rolls, so only
        // a change in posture earns a second banner.
        const notice = formatRateLimitNotice(event, this.nowFn());
        if (!notice) {
          this.lastRateLimitKey = null;
          return;
        }
        if (notice.key === this.lastRateLimitKey) return;
        this.lastRateLimitKey = notice.key;
        hooks.emitWarning(notice.text);
        return;
      }
      case 'tool-args-start':
        state.toolArgBlocks.set(event.index, {
          name: stripMcpPrefix(event.name),
          id: event.id,
          buffered: '',
          charCount: 0,
          visible: false,
        });
        return;
      case 'partial-tool-args-delta': {
        const block = state.toolArgBlocks.get(event.index);
        // A fragment with no preceding `tool-args-start` means we missed
        // the block header; without a name there is nothing useful to
        // label the live block with, so drop it rather than guess.
        if (!block) return;
        block.charCount += event.partialJson.length;
        turn.currentPhase = toolActivityLabel(block.name);
        if (block.visible) {
          hooks.emitToolArgsDelta(block.name, event.partialJson, { id: block.id });
          return;
        }
        block.buffered += event.partialJson;
        if (block.charCount < TOOL_ARGS_VISIBILITY_THRESHOLD) return;
        block.visible = true;
        hooks.emitToolArgsDelta(block.name, block.buffered, { id: block.id });
        block.buffered = '';
        return;
      }
      case 'content-block-stop':
        state.toolArgBlocks.delete(event.index);
        return;
      case 'tool-use': {
        if (state.thinking) {
          state.thinking = false;
          hooks.emitHeartbeat(undefined);
        }
        state.pendingTools.set(event.id, {
          id: event.id,
          name: event.name,
          input: event.input,
          startedAt: this.nowFn(),
        });
        // Strip Claude CLI's `mcp__<server>__` wire prefix and humanize
        // underscores so the heartbeat names the actual operation (for
        // example "read task notes") instead of leaking MCP jargon.
        //
        // We update `currentPhase` (transient — drives the live heartbeat
        // status line) but deliberately do NOT `emitIntent` here. Intents
        // persist on `message.intents[]` and render as permanent HR phase
        // dividers in the bubble; emitting one per tool-use carves a divider
        // for *every single command*, which is pure noise next to the
        // tool-call card we already surface via `onToolCall` (see the
        // `tool-result` case below). The CLI fires tool calls constantly, so
        // unlike Copilot's occasional `report_intent` phase announcements,
        // these never read as meaningful phase boundaries. The transient
        // Concrete live status is fully covered by the heartbeat.
        turn.currentPhase = toolActivityLabel(event.name);
        return;
      }
      case 'tool-result': {
        const pending = state.pendingTools.get(event.toolUseId);
        const durationMs = pending ? this.nowFn() - pending.startedAt : 0;
        const toolName = pending?.name ?? 'unknown';
        const args = pending?.input ?? {};
        const errorMessage = event.isError
          ? this.redact(event.text, hooks.knownSecretValues)
          : undefined;
        const resultText = this.redact(event.text, hooks.knownSecretValues);
        const ev: ToolCallEvent = {
          name: toolName,
          argKeys: Object.keys(args),
          args,
          durationMs,
          success: !event.isError,
          ...(errorMessage ? { errorMessage } : {}),
          ...(resultText ? { resultText } : {}),
        };
        if (hooks.onToolCall) {
          Promise.resolve(hooks.onToolCall(ev)).catch((err) => {
            log.warn(`[anthropic-cli/worker] onToolCall threw: ${err}`);
          });
        }
        state.pendingTools.delete(event.toolUseId);
        // After a tool result, the model resumes — flip phase back to a
        // generic "thinking" so the next heartbeat reads as in-progress
        // rather than still claiming we're using the (now-finished) tool.
        // Subsequent text/thinking/tool-use events overwrite this.
        turn.currentPhase = thinkingPhaseLabel(state.thinkingTokens);
        return;
      }
      case 'result': {
        // Mark that we've seen at least one successful turn-completion.
        // From here on, an unexpected close is "mid-conversation crash"
        // rather than "bad startup args / dead resume id" — the
        // classifier in onChildClose branches on this flag.
        this.seenFirstResult = true;
        state.success = event.success;
        state.finalText = event.finalText;
        state.usage = {
          inputTokens: event.inputTokens + event.cacheReadTokens + event.cacheCreationTokens,
          outputTokens: event.outputTokens,
          ...(event.cacheReadTokens > 0 ? { cachedInputTokens: event.cacheReadTokens } : {}),
          ...(event.costUsd !== undefined ? { costUsd: event.costUsd } : {}),
        };
        if (state.thinking) {
          state.thinking = false;
          hooks.emitHeartbeat(undefined);
        }
        this.completePendingTurn(turn);
        return;
      }
      case 'unknown':
        return;
    }
  }

  private completePendingTurn(turn: PendingTurn): void {
    if (this.pending !== turn) return;
    this.pending = null;
    if (turn.timer) clearInterval(turn.timer);
    if (turn.heartbeatTimer) clearInterval(turn.heartbeatTimer);
    if (turn.signal && turn.onAbort) {
      try {
        turn.signal.removeEventListener('abort', turn.onAbort);
      } catch {
        /* ignore */
      }
    }

    if (turn.state.usage) {
      // Every recorded window, not just the one this turn happened to
      // report: `TurnUsage.quotaBuckets` replaces the tracker's array
      // wholesale, so sending one window would blank out the other.
      const quotaBuckets = claudeRateLimitBuckets(this.nowFn());
      turn.hooks.emitUsage(
        buildTurnUsage({
          model: this.opts.model,
          inputTokens: turn.state.usage.inputTokens,
          outputTokens: turn.state.usage.outputTokens,
          durationMs: this.nowFn() - turn.startedAt,
          ...(turn.state.usage.cachedInputTokens !== undefined
            ? { cachedInputTokens: turn.state.usage.cachedInputTokens }
            : {}),
          ...(turn.state.usage.costUsd !== undefined ? { cost: turn.state.usage.costUsd } : {}),
          ...(quotaBuckets.length > 0 ? { quotaBuckets } : {}),
        }),
      );
    }

    const text = turn.state.finalText ?? turn.state.assistantText;
    if (turn.state.success) {
      this.markUsed();
      this.state = { kind: 'running.idle' };
      this.resetIdleTimer();
      turn.resolve(text);
    } else {
      // Result reported failure. Stay running.idle (process still alive)
      // but reject the turn — the model produced an error result, not a
      // crash. Caller can decide whether to retry.
      this.markUsed();
      this.state = { kind: 'running.idle' };
      this.resetIdleTimer();
      turn.reject(
        new Error(`[anthropic-cli/worker] turn ended with failure: ${text || 'unknown error'}`),
      );
    }
  }

  private redact(text: string, secrets: Set<string> | undefined): string {
    if (!secrets || secrets.size === 0) return text;
    let out = text;
    for (const value of secrets) {
      if (!value) continue;
      out = out.split(value).join('***');
    }
    return out;
  }
}
