import { type ChildProcess, spawn as nodeSpawn } from 'node:child_process';
import { createLogger, prettifyToolName } from '@bendyline/gezel';
import { SessionResumeError } from '../types.js';
import type { ToolCallEvent, TurnUsage } from '../types.js';
import { salvageAgentMessage } from './salvage.js';
import { type CodexStreamEvent, parseCodexLine } from './stream-parser.js';

const log = createLogger('codex-cli');

/**
 * One Codex CLI turn = one subprocess invocation. Codex doesn't expose a
 * stream-json input mode like Claude's `--input-format stream-json`, so
 * a worker pool would only buy us cold-start savings (and the Rust
 * binary's startup cost is small enough that the savings are
 * negligible vs the model latency that dominates each turn).
 *
 * Spawn surface:
 *
 *   First turn:
 *     codex --sandbox workspace-write --ask-for-approval never \
 *       exec --json --skip-git-repo-check \
 *       --cd <cwd> -m <model> \
 *       --image <path> \
 *       -c model_reasoning_effort=<low|medium|high> \
 *       <prompt>
 *
 *   Follow-up turn (when we have a thread_id):
 *     codex --sandbox workspace-write --ask-for-approval never \
 *       exec resume --json --skip-git-repo-check \
 *       -m <model> \
 *       --image <path> \
 *       -c model_reasoning_effort=<low|medium|high> \
 *       <thread_id> <prompt>
 *
 *   NB1: `codex exec resume` does not accept `--cd`; the child
 *   process cwd still anchors file tools in the right workspace. It
 *   does accept `-m`, `-c`, `--image`, and top-level sandbox /
 *   approval flags, so we repeat them on every resumed turn. This
 *   matters in non-interactive evals: otherwise Codex can fall back to
 *   its default sandbox on follow-up turns and report a read-only
 *   workspace even though the first turn wrote successfully.
 *
 *   NB2: We deliberately do NOT pass `--ephemeral` even though it
 *   would skip the persistent rollout (a duplicate of state we already
 *   keep in `~/.gezel/.../sessions/<id>.json`). Without a rollout on
 *   disk, `codex exec resume <thread_id>` fails with `no rollout found`
 *   on every follow-up turn, breaking multi-turn entirely. The rollout
 *   lands under the per-session `CODEX_HOME` directory we set, so
 *   storage is bounded and torn down with the gezel session anyway.
 *
 * `--json` puts NDJSON events on stdout (`thread.started`, `turn.started`,
 * `item.*`, `turn.completed`, `error`). The invoker streams those, dispatches
 * them onto the caller's hooks, captures the `thread_id`, and resolves
 * with the assistant's final text when `turn.completed` arrives.
 *
 * Auth: no special handling — Codex picks up `OPENAI_API_KEY` /
 * `CODEX_API_KEY` from the inherited env, or follows `CODEX_HOME` (which
 * the caller sets) to find a `~/.codex/auth.json`-equivalent. Auth
 * failures surface as Codex stderr / non-zero exit; we map them through
 * to the rejection.
 */

const TURN_TIMEOUT_DEFAULT_MS = 600_000; // 10 min — long tool loops can be slow.
const KILL_GRACE_MS = 3_000;
const STDERR_RING_CAP = 64 * 1024;
const HEARTBEAT_INTERVAL_MS = 3_000;
const SILENCE_THRESHOLD_MS = 15_000;

export type CodexPermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';
export type CodexReasoningEffort = 'low' | 'medium' | 'high';

export interface CodexInvokerHooks {
  emitDelta(text: string): void;
  emitIntent(label: string): void;
  emitHeartbeat(label?: string): void;
  emitUsage(usage: TurnUsage): void;
  emitWarning(message: string): void;
  onToolCall?: (ev: ToolCallEvent) => void | Promise<void>;
  /**
   * Fired exactly once per invocation when Codex emits `thread.started`.
   * The session caches the id for follow-up turns and persists it on
   * `ChatSession.providerState.codexCliThreadId`.
   */
  onThreadStarted?: (threadId: string) => void;
}

export interface CodexInvokerOpts {
  binaryPath: string;
  /** Working dir passed via `--cd`. Should match the gezel's project workingDir / fallback workspace. */
  cwd: string;
  /** `CODEX_HOME` for the spawn — the per-session config dir. */
  codexHome: string;
  /** Inherited env. The invoker merges `CODEX_HOME` on top. */
  baseEnv: NodeJS.ProcessEnv;
  /** Model id forwarded as `-m`. */
  model: string;
  /** Permission mode → mapped to Codex's sandbox/approval flags. */
  permissionMode: CodexPermissionMode;
  /** Optional reasoning-effort knob — forwarded as `-c model_reasoning_effort=…`. */
  reasoningEffort?: CodexReasoningEffort;
  /** Extra `-c key=value` overrides appended verbatim. Power-user escape hatch. */
  extraConfigOverrides?: Record<string, string>;
  /** Paths to image files attached to the current prompt. */
  imagePaths?: string[];
  /** When set, the invoker uses `codex exec resume <id>` instead of starting a fresh thread. */
  resumeThreadId?: string;
  /** The user's turn prompt — passed positionally to `codex exec`. */
  prompt: string;
  /** Per-turn hooks for streaming feedback. */
  hooks: CodexInvokerHooks;
  /** Per-turn hard timeout. Default 600s. */
  timeoutMs?: number;
  /** Caller's abort signal. */
  signal?: AbortSignal;
  /** Test seam — defaults to `node:child_process.spawn`. */
  spawnImpl?: typeof nodeSpawn;
  /** Test seam — defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Map gezel's per-gezel `claudePermissionMode` enum onto Codex's
 * two-axis sandbox + approval flags. Codex separates these — we
 * collapse them to keep the gezel-frontmatter UX consistent across
 * `anthropic-cli` and `codex-cli`.
 */
export function permissionModeToCodexArgs(mode: CodexPermissionMode): string[] {
  switch (mode) {
    case 'default':
    case 'acceptEdits':
      // Non-interactive gezels need deterministic behavior: allow
      // workspace writes, but never block waiting for an approval UI
      // the service cannot provide.
      return ['--sandbox', 'workspace-write', '--ask-for-approval', 'never'];
    case 'plan':
      return ['--sandbox', 'read-only', '--ask-for-approval', 'never'];
    case 'bypassPermissions':
      // The CLI exposes both this long alias and `--yolo`. Use the
      // long form so the intent is clear in process listings.
      return ['--dangerously-bypass-approvals-and-sandbox'];
  }
}

/**
 * Build the full argv for one `codex exec` (or `codex exec resume`)
 * invocation. Exported so tests can assert flag composition without
 * spawning a subprocess.
 */
export function buildCodexArgs(opts: {
  prompt: string;
  model: string;
  permissionMode: CodexPermissionMode;
  cwd: string;
  reasoningEffort?: CodexReasoningEffort;
  extraConfigOverrides?: Record<string, string>;
  imagePaths?: string[];
  resumeThreadId?: string;
}): string[] {
  const globalArgs = permissionModeToCodexArgs(opts.permissionMode);
  if (opts.resumeThreadId) {
    // `codex exec resume` still does not accept `--cd`; the spawn cwd
    // anchors the process instead. Other execution-shaping flags are
    // accepted by current Codex and must be repeated so resumed eval
    // turns keep the same non-interactive write permissions.
    const args = [
      ...globalArgs,
      'exec',
      'resume',
      '--json',
      '--skip-git-repo-check',
      '-m',
      opts.model,
    ];
    if (opts.reasoningEffort) {
      args.push('-c', `model_reasoning_effort="${opts.reasoningEffort}"`);
    }
    for (const [key, value] of Object.entries(opts.extraConfigOverrides ?? {})) {
      args.push('-c', `${key}=${value}`);
    }
    for (const imagePath of opts.imagePaths ?? []) {
      args.push('--image', imagePath);
    }
    args.push(opts.resumeThreadId, opts.prompt);
    return args;
  }
  const args: string[] = [
    ...globalArgs,
    'exec',
    '--json',
    // Gezel workspaces aren't necessarily git repos. Without this,
    // Codex refuses to run in non-repo directories.
    '--skip-git-repo-check',
    '--cd',
    opts.cwd,
    '-m',
    opts.model,
  ];
  if (opts.reasoningEffort) {
    args.push('-c', `model_reasoning_effort="${opts.reasoningEffort}"`);
  }
  for (const [key, value] of Object.entries(opts.extraConfigOverrides ?? {})) {
    args.push('-c', `${key}=${value}`);
  }
  for (const imagePath of opts.imagePaths ?? []) {
    args.push('--image', imagePath);
  }
  args.push(opts.prompt);
  return args;
}

interface InvocationState {
  /** Per-item text seen so far. Diffed against fresh `item-updated` payloads to emit deltas. */
  textByItem: Map<string, string>;
  finalAssistantText: string;
  /** When the model is mid-tool, we suppress further text-delta emission until the tool completes. */
  pendingTools: Map<string, { name: string; args: Record<string, unknown>; startedAt: number }>;
  threadIdEmitted: boolean;
  warned: boolean;
  /** Set true on `turn.failed` / `error` so the close handler doesn't retry-classify it. */
  observedFailure: { message: string } | null;
  observedSuccess: { usage: TurnUsage } | null;
  currentPhase: string;
  lastEventAt: number;
}

/**
 * Run one Codex CLI turn end-to-end. Resolves with the assistant's
 * final text on success; rejects on timeout / abort / non-zero exit /
 * `turn.failed` / `error`. Resume failures (the upstream thread is
 * gone) surface as `SessionResumeError` so ChatManager's resume-fallback
 * path can clear the stale id and rebuild a fresh thread.
 */
export async function runCodexTurn(opts: CodexInvokerOpts): Promise<string> {
  const spawn = opts.spawnImpl ?? nodeSpawn;
  const now = opts.now ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? TURN_TIMEOUT_DEFAULT_MS;

  const argsBuild: Parameters<typeof buildCodexArgs>[0] = {
    prompt: opts.prompt,
    model: opts.model,
    permissionMode: opts.permissionMode,
    cwd: opts.cwd,
  };
  if (opts.reasoningEffort) argsBuild.reasoningEffort = opts.reasoningEffort;
  if (opts.extraConfigOverrides) argsBuild.extraConfigOverrides = opts.extraConfigOverrides;
  if (opts.imagePaths && opts.imagePaths.length > 0) argsBuild.imagePaths = opts.imagePaths;
  if (opts.resumeThreadId) argsBuild.resumeThreadId = opts.resumeThreadId;
  const args = buildCodexArgs(argsBuild);

  const env: NodeJS.ProcessEnv = { ...opts.baseEnv, CODEX_HOME: opts.codexHome };

  // Windows: `.cmd` / `.bat` shims (npm i -g @openai/codex installs
  // one) need `shell: true` to spawn since the Node 18.20+ CVE
  // mitigation. Plain `.exe` works without — keep the no-shell path
  // for predictable argv quoting wherever possible. Same gate as
  // `runVersionProbe` and `anthropic-cli/worker.ts`.
  const useShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(opts.binaryPath);
  let child: ChildProcess;
  try {
    // With `shell: true`, Node concatenates argv into a single command
    // string and hands it to cmd.exe without escaping. Any arg
    // containing spaces (cwd paths, multi-word prompts) gets word-split
    // by cmd.exe — codex sees the second word as an unexpected extra
    // positional. Quote ourselves before handoff. On the no-shell path
    // Node passes argv directly to CreateProcess, so no quoting is
    // needed (and would double-quote the args).
    const spawnArgs = useShell ? args.map(quoteForWindowsShell) : args;
    const spawnBinary = useShell ? quoteForWindowsShell(opts.binaryPath) : opts.binaryPath;
    child = spawn(spawnBinary, spawnArgs, {
      cwd: opts.cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: useShell,
    });
  } catch (err) {
    throw err instanceof Error ? err : new Error(String(err));
  }

  return new Promise<string>((resolve, reject) => {
    const startedAt = now();
    const state: InvocationState = {
      textByItem: new Map(),
      finalAssistantText: '',
      pendingTools: new Map(),
      threadIdEmitted: false,
      warned: false,
      observedFailure: null,
      observedSuccess: null,
      currentPhase: 'preparing',
      lastEventAt: startedAt,
    };

    let stdoutBuffer = '';
    let stderrSize = 0;
    const stderrChunks: string[] = [];
    let settled = false;

    const cleanup = (): void => {
      if (turnTimer) clearInterval(turnTimer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (opts.signal && onAbort) {
        try {
          opts.signal.removeEventListener('abort', onAbort);
        } catch {
          /* ignore */
        }
      }
    };

    const settleResolve = (text: string): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(text);
    };

    const settleReject = (err: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const killChild = (): void => {
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
    };

    // Wallclock-based deadline poll. Node `setTimeout(timeoutMs)` pauses
    // when macOS suspends the process, so a turn started just before
    // sleep won't abort `timeoutMs` later — the timer effectively
    // re-anchors to wake time and the user sees a multi-thousand-
    // second hang. setInterval also pauses, but the first post-wake
    // tick compares `Date.now()` to the precomputed wallclock
    // `turnDeadline` and aborts within the poll period.
    const turnDeadline = now() + timeoutMs;
    const turnTimer = setInterval(() => {
      if (settled) return;
      if (now() < turnDeadline) return;
      killChild();
      settleReject(new Error(`[codex-cli] turn timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, 2_000);
    turnTimer.unref?.();

    // Don't emit `preparing` as an intent: the UI carves intents into
    // the persisted message as HR dividers (offset 0 = "PREPARING" stuck
    // at the top forever). Heartbeat already shows the same status
    // transiently and clears on first delta — that's the right
    // surface for a startup state every turn passes through.
    opts.hooks.emitHeartbeat(state.currentPhase);
    const heartbeatTimer = setInterval(() => {
      if (settled) return;
      const silentMs = now() - state.lastEventAt;
      if (silentMs >= SILENCE_THRESHOLD_MS) {
        const silentSec = Math.round(silentMs / 1000);
        opts.hooks.emitHeartbeat(`${state.currentPhase} · silent ${silentSec}s`);
      } else {
        opts.hooks.emitHeartbeat(state.currentPhase);
      }
    }, HEARTBEAT_INTERVAL_MS);
    heartbeatTimer.unref?.();

    let onAbort: (() => void) | null = null;
    if (opts.signal) {
      onAbort = () => {
        if (settled) return;
        const err = new Error('[codex-cli] aborted');
        (err as Error & { name: string }).name = 'AbortError';
        killChild();
        settleReject(err);
      };
      if (opts.signal.aborted) {
        onAbort();
        return;
      }
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');

    child.stdout?.on('data', (chunk: string) => {
      stdoutBuffer += chunk;
      let nl = stdoutBuffer.indexOf('\n');
      while (nl >= 0) {
        const line = stdoutBuffer.slice(0, nl);
        stdoutBuffer = stdoutBuffer.slice(nl + 1);
        handleLine(line);
        nl = stdoutBuffer.indexOf('\n');
      }
    });

    child.stderr?.on('data', (chunk: string) => {
      if (stderrSize < STDERR_RING_CAP) {
        stderrChunks.push(chunk);
        stderrSize += chunk.length;
      }
    });

    child.on('error', (err) => {
      settleReject(err instanceof Error ? err : new Error(String(err)));
    });

    child.on('close', (code) => {
      if (stdoutBuffer.length > 0) {
        handleLine(stdoutBuffer);
        stdoutBuffer = '';
      }
      if (settled) return;
      const stderr = stderrChunks.join('');
      // Successful turn: `turn.completed` event already arrived. Emit
      // usage now (we know the model + duration only post-exit so the
      // turn-stats payload is complete) and resolve with the assembled
      // assistant text.
      if (state.observedSuccess) {
        opts.hooks.emitUsage({
          ...state.observedSuccess.usage,
          durationMs: now() - startedAt,
        });
        // Salvage pass — drop the leading "<server__tool …" tool-call
        // draft that gpt-5.5 sometimes stuffs into agent_message text
        // instead of routing through the reasoning channel. See
        // salvage.ts for the heuristic and trade-offs. The streamed
        // deltas the user saw mid-turn are NOT rewritten — only the
        // persisted final text.
        const salvaged = salvageAgentMessage(state.finalAssistantText);
        if (salvaged !== state.finalAssistantText) {
          log.debug(
            `[codex-cli] salvaged ${state.finalAssistantText.length - salvaged.length} chars of tool-call-draft leakage from agent_message text`,
          );
        }
        settleResolve(salvaged);
        return;
      }
      if (state.observedFailure) {
        const err = classifyError({
          message: state.observedFailure.message,
          stderr,
          attemptedResume: opts.resumeThreadId !== undefined,
          threadStarted: state.threadIdEmitted,
        });
        settleReject(err);
        return;
      }
      // No turn.completed AND no turn.failed — child exited unexpectedly.
      const err = classifyError({
        message: stderr.trim() || `codex exited with code ${code ?? 'null'}`,
        stderr,
        attemptedResume: opts.resumeThreadId !== undefined,
        threadStarted: state.threadIdEmitted,
      });
      settleReject(err);
    });

    function handleLine(line: string): void {
      const event = parseCodexLine(line);
      if (!event) return;
      if (event.kind === 'malformed') {
        log.warn(`[codex-cli] malformed stream line: ${event.error}`);
        return;
      }
      state.lastEventAt = now();
      dispatchEvent(event);
    }

    function dispatchEvent(event: CodexStreamEvent): void {
      switch (event.kind) {
        case 'thread-started': {
          if (!state.threadIdEmitted) {
            state.threadIdEmitted = true;
            opts.hooks.onThreadStarted?.(event.threadId);
          }
          return;
        }
        case 'turn-started': {
          state.currentPhase = 'thinking';
          return;
        }
        case 'item-started': {
          if (event.itemType === 'reasoning') {
            state.currentPhase = 'reasoning';
            opts.hooks.emitIntent('reasoning');
          } else if (event.itemType === 'agent_message') {
            state.currentPhase = 'streaming';
          } else if (
            event.itemType === 'command_execution' ||
            event.itemType === 'mcp_tool_call' ||
            event.itemType === 'file_change' ||
            event.itemType === 'web_search'
          ) {
            const name = describeItemTool(event.itemType, event.raw);
            const friendlyName = prettifyToolName(name);
            state.currentPhase = `using ${friendlyName}`;
            opts.hooks.emitIntent(`using ${friendlyName}`);
            const args = extractToolArgs(event.itemType, event.raw);
            state.pendingTools.set(event.itemId, {
              name,
              args,
              startedAt: Date.now(),
            });
          }
          return;
        }
        case 'item-updated': {
          if (event.itemType !== 'agent_message') {
            // Reasoning / tool item updates: track for completion-time
            // emission but don't stream into the chat bubble — only
            // `agent_message` text becomes visible content.
            state.textByItem.set(event.itemId, event.text);
            return;
          }
          const prior = state.textByItem.get(event.itemId) ?? '';
          if (event.text.length > prior.length && event.text.startsWith(prior)) {
            const delta = event.text.slice(prior.length);
            opts.hooks.emitDelta(delta);
          } else if (event.text !== prior) {
            // Codex re-sent the item without strict prefix overlap — push
            // the whole text so we don't drop content. The chat-side
            // dedupe is best-effort, but losing characters is worse than
            // duplicating.
            opts.hooks.emitDelta(event.text);
          }
          state.textByItem.set(event.itemId, event.text);
          return;
        }
        case 'item-completed': {
          if (event.itemType === 'agent_message') {
            const prior = state.textByItem.get(event.itemId) ?? '';
            // If `item.completed.text` is longer than the last `updated`,
            // flush the trailing fragment so the bubble closes on the
            // exact final text.
            if (event.text.length > prior.length && event.text.startsWith(prior)) {
              const delta = event.text.slice(prior.length);
              if (delta.length > 0) opts.hooks.emitDelta(delta);
            } else if (prior === '' && event.text.length > 0) {
              // No prior `updated` event arrived for this item — emit the
              // whole text as a delta. Happens for short replies that
              // Codex packs into a single `completed` event.
              opts.hooks.emitDelta(event.text);
            }
            state.textByItem.set(event.itemId, event.text);
            // The final assistant text is the concatenation of every
            // completed `agent_message` item, in arrival order. Most
            // turns have exactly one.
            if (state.finalAssistantText.length > 0) {
              state.finalAssistantText += '\n\n';
            }
            state.finalAssistantText += event.text;
          } else if (
            event.itemType === 'command_execution' ||
            event.itemType === 'mcp_tool_call' ||
            event.itemType === 'file_change' ||
            event.itemType === 'web_search'
          ) {
            const pending = state.pendingTools.get(event.itemId);
            const name = pending?.name ?? describeItemTool(event.itemType, event.raw);
            const completedArgs = extractToolArgs(event.itemType, event.raw);
            const args = pending ? { ...pending.args, ...completedArgs } : completedArgs;
            const startedAt = pending?.startedAt ?? Date.now();
            state.pendingTools.delete(event.itemId);
            const argKeys = Object.keys(args);
            const toolEvent: ToolCallEvent = {
              name,
              argKeys,
              args,
              durationMs: Math.max(0, Date.now() - startedAt),
              success: !isToolItemError(event.raw),
            };
            const structuredContent = extractToolStructuredContent(event.itemType, event.raw);
            if (structuredContent) {
              toolEvent.structuredContent = structuredContent;
            }
            const errorMessage = extractToolItemError(event.raw);
            if (errorMessage) {
              toolEvent.errorMessage = errorMessage;
            }
            opts.hooks.onToolCall?.(toolEvent);
          }
          return;
        }
        case 'turn-completed': {
          state.observedSuccess = {
            usage: {
              model: opts.model,
              inputTokens: event.inputTokens,
              outputTokens: event.outputTokens,
              durationMs: 0, // overwritten in the close handler
              at: new Date().toISOString(),
            },
          };
          return;
        }
        case 'turn-failed': {
          state.observedFailure = { message: event.message };
          return;
        }
        case 'error': {
          if (!state.warned) {
            state.warned = true;
            opts.hooks.emitWarning(event.message);
          }
          state.observedFailure = { message: event.message };
          return;
        }
        case 'unknown':
          return;
        case 'malformed':
          return;
      }
    }
  });
}

/**
 * Map a Codex stream-error message + stderr into the right user-facing
 * error. The narrow concern is "thread not found" surfacing as
 * `SessionResumeError` so ChatManager's resume-fallback path can clear
 * the stale `codexCliThreadId` and rebuild on a fresh thread. Anything
 * else passes through as a plain error.
 *
 * Exported for `session.test.ts`.
 */
export function classifyError(input: {
  message: string;
  stderr: string;
  attemptedResume: boolean;
  threadStarted: boolean;
}): Error {
  const haystack = `${input.message}\n${input.stderr}`.toLowerCase();
  if (input.attemptedResume && !input.threadStarted && isResumeFailureSignal(haystack)) {
    return new SessionResumeError(`[codex-cli] thread resume failed: ${input.message.trim()}`);
  }
  return new Error(`[codex-cli] ${input.message.trim() || input.stderr.trim() || 'unknown error'}`);
}

function isResumeFailureSignal(lowerHaystack: string): boolean {
  return (
    lowerHaystack.includes('thread not found') ||
    lowerHaystack.includes('no such thread') ||
    lowerHaystack.includes('thread does not exist') ||
    lowerHaystack.includes('thread has expired') ||
    lowerHaystack.includes('failed to resume') ||
    lowerHaystack.includes('rollout not found') ||
    // Codex's exact wording when `codex exec resume <id>` can't locate
    // the rollout on disk — surfaces as `thread/resume failed: no
    // rollout found for thread id …`. Matches stale ids left over
    // from earlier `--ephemeral` runs and from cleaned-up CODEX_HOMEs.
    lowerHaystack.includes('no rollout found') ||
    lowerHaystack.includes('session not found')
  );
}

/**
 * Quote a single argv element for cmd.exe consumption. Only called when
 * `spawn` is launched with `shell: true` (Windows `.cmd` / `.bat` shim
 * path). Wraps in double quotes when the arg contains any character
 * cmd.exe treats specially, and doubles inner double quotes per
 * Microsoft's parsing convention. Leaves bare arguments untouched so
 * process listings stay readable.
 *
 * Exported for testing.
 */
export function quoteForWindowsShell(arg: string): string {
  if (arg === '') return '""';
  if (!/[\s"&|<>^()%!,;]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

function describeItemTool(
  itemType: 'command_execution' | 'mcp_tool_call' | 'file_change' | 'web_search',
  raw: Record<string, unknown>,
): string {
  if (itemType === 'mcp_tool_call') {
    return typeof raw.name === 'string' ? raw.name : 'mcp_tool_call';
  }
  if (itemType === 'command_execution') return 'shell';
  if (itemType === 'file_change') return 'file_change';
  return 'web_search';
}

function extractToolArgs(
  itemType: 'command_execution' | 'mcp_tool_call' | 'file_change' | 'web_search',
  raw: Record<string, unknown>,
): Record<string, unknown> {
  if (itemType === 'mcp_tool_call') {
    const out: Record<string, unknown> = {};
    if (typeof raw.server === 'string') out.server = raw.server;
    if (typeof raw.name === 'string') out.tool = raw.name;
    if (typeof raw.status === 'string') out.status = raw.status;
    const args =
      raw.arguments && typeof raw.arguments === 'object'
        ? (raw.arguments as Record<string, unknown>)
        : raw.input && typeof raw.input === 'object'
          ? (raw.input as Record<string, unknown>)
          : null;
    if (args) {
      return { ...out, ...args };
    }
    return out;
  }
  if (itemType === 'command_execution') {
    const out: Record<string, unknown> = {};
    if (typeof raw.command === 'string') out.command = raw.command;
    if (typeof raw.cwd === 'string') out.cwd = raw.cwd;
    if (typeof raw.status === 'string') out.status = raw.status;
    if (typeof raw.exit_code === 'number') out.exitCode = raw.exit_code;
    if (typeof raw.output === 'string') out.outputPreview = truncateTelemetry(raw.output);
    if (typeof raw.stdout === 'string') out.stdoutPreview = truncateTelemetry(raw.stdout);
    if (typeof raw.stderr === 'string') out.stderrPreview = truncateTelemetry(raw.stderr);
    return out;
  }
  if (itemType === 'file_change') {
    const out: Record<string, unknown> = {};
    if (typeof raw.path === 'string') out.path = raw.path;
    if (typeof raw.kind === 'string') out.kind = raw.kind;
    if (typeof raw.status === 'string') out.status = raw.status;
    if (typeof raw.diff === 'string') out.diffPreview = truncateTelemetry(raw.diff);
    return out;
  }
  if (itemType === 'web_search') {
    const out: Record<string, unknown> = {};
    if (typeof raw.query === 'string') out.query = raw.query;
    if (typeof raw.status === 'string') out.status = raw.status;
    if (typeof raw.url === 'string') out.url = raw.url;
    return out;
  }
  return {};
}

function extractToolStructuredContent(
  itemType: 'command_execution' | 'mcp_tool_call' | 'file_change' | 'web_search',
  raw: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  if (typeof raw.status === 'string') out.status = raw.status;
  if (typeof raw.exit_code === 'number') out.exitCode = raw.exit_code;
  if (itemType === 'file_change' && typeof raw.diff === 'string') {
    out.diff = truncateTelemetry(raw.diff);
  }
  if (typeof raw.output === 'string') out.outputPreview = truncateTelemetry(raw.output);
  if (typeof raw.stdout === 'string') out.stdoutPreview = truncateTelemetry(raw.stdout);
  if (typeof raw.stderr === 'string') out.stderrPreview = truncateTelemetry(raw.stderr);
  return Object.keys(out).length > 0 ? out : undefined;
}

function isToolItemError(raw: Record<string, unknown>): boolean {
  if (raw.is_error === true) return true;
  if (typeof raw.exit_code === 'number' && raw.exit_code !== 0) return true;
  if (typeof raw.status === 'string' && /^(error|failed|failure)$/i.test(raw.status)) return true;
  return false;
}

function extractToolItemError(raw: Record<string, unknown>): string | undefined {
  if (typeof raw.message === 'string') return raw.message;
  if (typeof raw.error === 'string') return raw.error;
  if (raw.error && typeof raw.error === 'object' && 'message' in raw.error) {
    const m = (raw.error as { message?: unknown }).message;
    if (typeof m === 'string') return m;
  }
  if (typeof raw.stderr === 'string' && raw.stderr.trim().length > 0) {
    return truncateTelemetry(raw.stderr.trim());
  }
  return undefined;
}

function truncateTelemetry(value: string): string {
  const max = 4096;
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n[truncated ${value.length - max} chars]`;
}
