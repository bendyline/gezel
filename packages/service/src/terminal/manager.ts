import { randomUUID } from 'node:crypto';
import { isAbsolute, normalize, relative, resolve } from 'node:path';
import {
  type TerminalFileReference,
  type TerminalMessage,
  type TerminalThread,
  createLogger,
  nowIso,
} from '@bendyline/gezel';
import { safeJoin } from '../fs/safe-paths.js';
import type { Store } from '../fs/store.js';
import type { HistoryManager } from '../history/manager.js';
import type { WorkspaceIndexManager } from '../workspace/index-manager.js';
import type { TerminalEventBus } from './events.js';
import {
  type CraftbookCommandSpec,
  type ResolvedTerminalInput,
  resolveTerminalInput,
} from './resolve.js';
import { PersistentShellPool } from './shell-pool.js';

const log = createLogger('terminal');

/** Summary the craftbook invoker returns for the terminal output bubble. */
export interface CraftbookInvokeResult {
  taskRef: string;
  craftbookName: string;
  assigneeName?: string;
  started: boolean;
}

/**
 * Dispatch a recognized craftbook command: create the task, assign the
 * role-matched gezel, and (optionally) start it. Wired in `service.ts`
 * from the task + chat managers — kept as an injected callback so the
 * terminal layer doesn't depend on them directly.
 */
export type CraftbookInvoker = (args: {
  projectId: string;
  craftbookId: string;
  params: Record<string, string>;
}) => Promise<CraftbookInvokeResult>;

export type McpToolInvoker = (args: {
  projectId: string;
  name: string;
  args: Record<string, unknown>;
}) => Promise<{ text: string; images: Array<{ base64: string; mimeType: string }> }>;

export interface TerminalManagerOptions {
  store: Store;
  workspaceIndex: WorkspaceIndexManager;
  events: TerminalEventBus;
  history?: HistoryManager;
  /** Override the default 5-min wall-clock budget per command. */
  timeoutMs?: number;
  /**
   * Test seam: inject a custom (e.g. mocked) shell pool. Production
   * code leaves this undefined and the manager constructs a default
   * `PersistentShellPool` with the standard 10-min idle timeout.
   */
  shellPool?: PersistentShellPool;
  /**
   * Resolve the craftbooks recognizable as terminal commands for a
   * project (from the catalog). Injected so the terminal layer stays
   * catalog-free. Absent → no craftbook recognition (commands shell out).
   */
  listCraftbookCommands?: (projectId: string) => Promise<CraftbookCommandSpec[]>;
  /**
   * Dispatch a recognized craftbook command. Absent → recognized
   * craftbook commands report "unavailable" in their output bubble.
   */
  craftbookInvoker?: CraftbookInvoker;
  /**
   * Resolve the project-wide MCP tool names recognizable as terminal
   * commands. Injected so the terminal layer stays chat/bridge-free.
   * Absent → no MCP tool recognition (names shell out and fail).
   */
  listMcpTools?: (projectId: string) => Promise<{ name: string }[]>;
  /**
   * Dispatch a recognized MCP tool command. Absent → recognized tool
   * commands report "unavailable" in their output bubble.
   */
  mcpToolInvoker?: McpToolInvoker;
}

export interface RunOutcome {
  threadId: string;
  runId: string;
  /** Pre-run resolution outcome — lets the route surface parse errors immediately. */
  resolution: ResolvedTerminalInput;
}

/**
 * Owns terminal threads (one per `(projectId, workingDir)` pair) and
 * their execution lifecycle. Calls `runWorkspaceCommand` directly so the
 * approval gate in `workspace/scripts.ts` is bypassed — user-typed
 * commands in the in-chat terminal are auto-approved.
 *
 * Execution is async / 202: `enqueueRun` persists the command bubble +
 * spawns the run off the request hot path, returns
 * `{ threadId, runId }` immediately, and emits the output via the
 * `TerminalEventBus` when the child exits. A per-thread serial queue
 * prevents output interleaving when the user fires several commands
 * back-to-back in the same folder.
 */
export class TerminalManager {
  private readonly store: Store;
  private readonly workspaceIndex: WorkspaceIndexManager;
  private readonly events: TerminalEventBus;
  private readonly history?: HistoryManager;
  private readonly timeoutMs?: number;
  /**
   * Per-thread queue: each map entry holds the tail of an
   * in-flight chain of runs so a new run waits for its predecessors
   * to finish before spawning. Cleared opportunistically when the
   * tail promise resolves.
   */
  private readonly threadQueues = new Map<string, Promise<void>>();
  private readonly shellPool: PersistentShellPool;
  /**
   * Live runs that can still be cancelled. Key: `runId`. Value:
   * `threadId` (so `cancelRun` knows which shell to send Ctrl+C
   * to). Entries are inserted at the top of `executeAndEmit` and
   * removed in its `finally` block, so a `cancelRun(runId)` call
   * after the run has already resolved is a quiet 404.
   */
  private readonly activeRunThreads = new Map<string, string>();
  private readonly listCraftbookCommands?: (projectId: string) => Promise<CraftbookCommandSpec[]>;
  private readonly craftbookInvoker?: CraftbookInvoker;
  private readonly listMcpTools?: (projectId: string) => Promise<{ name: string }[]>;
  private readonly mcpToolInvoker?: McpToolInvoker;

  constructor(opts: TerminalManagerOptions) {
    this.store = opts.store;
    this.workspaceIndex = opts.workspaceIndex;
    this.events = opts.events;
    this.history = opts.history;
    if (opts.timeoutMs !== undefined) this.timeoutMs = opts.timeoutMs;
    this.shellPool = opts.shellPool ?? new PersistentShellPool();
    if (opts.listCraftbookCommands) this.listCraftbookCommands = opts.listCraftbookCommands;
    if (opts.craftbookInvoker) this.craftbookInvoker = opts.craftbookInvoker;
    if (opts.listMcpTools) this.listMcpTools = opts.listMcpTools;
    if (opts.mcpToolInvoker) this.mcpToolInvoker = opts.mcpToolInvoker;
  }

  /** Kill all live shells. Daemon shutdown wires this. */
  async shutdown(): Promise<void> {
    await this.shellPool.shutdown();
  }

  /**
   * Send Ctrl+C to the foreground command of the in-flight run.
   * Returns `true` when the runId was found (and Ctrl+C was
   * dispatched), `false` when it had already completed.
   *
   * The shell stays alive; the foreground command exits (usually
   * with code 130 = 128+SIGINT, by shell convention), the
   * sentinel printf fires as normal, and the final output bubble
   * lands with the cancelled exit code. UI consumers can present
   * that as "cancelled" via the exit-code pill or a banner.
   */
  cancelRun(runId: string): boolean {
    const threadId = this.activeRunThreads.get(runId);
    if (!threadId) return false;
    this.shellPool.interrupt(threadId);
    return true;
  }

  /**
   * Feed text to the in-flight run's stdin, used by the
   * interactive-prompt UI. Appends a newline server-side (the
   * `feedInput` on PersistentShell handles the platform-specific
   * terminator). Returns true on success, false if no active run.
   */
  sendInput(runId: string, text: string): boolean {
    const threadId = this.activeRunThreads.get(runId);
    if (!threadId) return false;
    return this.shellPool.feedInput(threadId, text);
  }

  /**
   * Resolve a workingDir (relative to the project root) into the
   * thread id used for storage + SSE keying.
   */
  threadIdFor(workingDir: string): string {
    return this.store.terminalThreadId(workingDir);
  }

  /**
   * Persist a `command` bubble immediately (so the UI echoes the user's
   * input), then run the command in the background. Returns the thread
   * id + run id; the output bubble arrives later via SSE +
   * `appendTerminalMessage`.
   *
   * Intercepts (`pwd`, `clear`, `open`) bypass spawning. `open` resolves a
   * workspace file and emits a one-shot preview intent to the UI.
   */
  async enqueueRun(
    projectId: string,
    workingDir: string,
    input: string,
    columns?: number,
  ): Promise<RunOutcome> {
    const runId = randomUUID();
    const threadId = this.threadIdFor(workingDir);
    const index = await this.workspaceIndex.readCommandIndex(projectId);
    const craftbooks = this.listCraftbookCommands
      ? await this.listCraftbookCommands(projectId).catch(() => [])
      : null;
    const mcpTools = this.listMcpTools ? await this.listMcpTools(projectId).catch(() => []) : null;
    const resolution = resolveTerminalInput(input, index, craftbooks, mcpTools);

    // Empty / parse errors don't get persisted; the route surfaces them
    // synchronously and the UI shows a toast.
    if (resolution.kind === 'empty' || resolution.kind === 'parseError') {
      return { threadId, runId, resolution };
    }

    // Compute the cwd display string for the bubbles. The shell pool
    // tracks each live shell's absolute cwd; if the shell for this
    // thread is alive, its cwd is the truth (and may have drifted
    // off `workingDir` via `cd`). If no shell yet, fall back to the
    // thread anchor — the shell hasn't spawned, so the bubble shows
    // where it WILL run from. wsRoot is best-effort: if it fails to
    // resolve (project deleted), we skip the relative conversion and
    // rely on the anchor fallback.
    let wsRoot: string | null = null;
    try {
      wsRoot = await this.store.projectWorkspaceDir(projectId);
    } catch {
      /* fall through; executeAndEmit will surface the error */
    }
    const shellAbsCwd = this.shellPool.currentCwd(threadId);
    const cwdDisplay =
      shellAbsCwd !== undefined && wsRoot
        ? projectRelativeOrAbsolute(wsRoot, shellAbsCwd)
        : workingDir;

    // Persist the command bubble + emit immediately so the user sees
    // their input echoed regardless of how long the run takes.
    const commandMessage: TerminalMessage = {
      id: randomUUID(),
      kind: 'command',
      content:
        resolution.kind === 'argv' ||
        resolution.kind === 'craftbook' ||
        resolution.kind === 'mcpTool'
          ? resolution.run
          : `${resolution.intercept}${resolution.arg ? ` ${resolution.arg}` : ''}`,
      at: nowIso(),
      cwd: cwdDisplay,
      ...(resolution.kind === 'argv' && resolution.resolvedFrom
        ? { resolvedFrom: resolution.resolvedFrom }
        : {}),
    };
    await this.store.appendTerminalMessage(projectId, threadId, workingDir, commandMessage);
    this.events.publish({
      kind: 'message',
      projectId,
      threadId,
      workingDir,
      message: commandMessage,
    });

    // Intercepts handled server-side as a courtesy output bubble.
    if (resolution.kind === 'intercept') {
      const openResult =
        resolution.intercept === 'open'
          ? await this.buildOpenInterceptOutput({
              projectId,
              threadId,
              workingDir,
              cwdDisplay,
              wsRoot,
              path: resolution.arg!,
            })
          : null;
      const outputMessage: TerminalMessage = openResult?.message ?? {
        ...this.buildInterceptOutput(resolution, workingDir),
        cwd: cwdDisplay,
      };
      await this.store.appendTerminalMessage(projectId, threadId, workingDir, outputMessage);
      this.events.publish({
        kind: 'message',
        projectId,
        threadId,
        workingDir,
        message: outputMessage,
      });
      if (openResult?.path) {
        this.events.publish({
          kind: 'openFile',
          projectId,
          threadId,
          path: openResult.path,
          source: 'workspace',
        });
      }
      return { threadId, runId, resolution };
    }

    // Craftbook commands dispatch to the invoker (create task + assign +
    // start) instead of spawning a shell. Queued on the same per-thread
    // chain so the confirmation bubble lands in submission order relative
    // to any shell commands fired around it.
    if (resolution.kind === 'craftbook') {
      const prior = this.threadQueues.get(threadId) ?? Promise.resolve();
      const next = prior
        .catch(() => undefined)
        .then(() =>
          this.runCraftbookInvocation({
            projectId,
            workingDir,
            threadId,
            runId,
            commandMessageId: commandMessage.id,
            resolution,
            cwdDisplay,
          }),
        );
      this.threadQueues.set(threadId, next);
      void next.finally(() => {
        if (this.threadQueues.get(threadId) === next) {
          this.threadQueues.delete(threadId);
        }
      });
      return { threadId, runId, resolution };
    }

    // MCP tool commands run via the project tool bridge (no shell). Same
    // per-thread queue so the result bubble lands in submission order.
    if (resolution.kind === 'mcpTool') {
      const prior = this.threadQueues.get(threadId) ?? Promise.resolve();
      const next = prior
        .catch(() => undefined)
        .then(() =>
          this.runMcpToolInvocation({ projectId, workingDir, threadId, resolution, cwdDisplay }),
        );
      this.threadQueues.set(threadId, next);
      void next.finally(() => {
        if (this.threadQueues.get(threadId) === next) {
          this.threadQueues.delete(threadId);
        }
      });
      return { threadId, runId, resolution };
    }

    // Queue the actual exec behind any in-flight run for this thread.
    const prior = this.threadQueues.get(threadId) ?? Promise.resolve();
    const next = prior
      .catch(() => undefined)
      .then(async () => {
        await this.executeAndEmit({
          projectId,
          workingDir,
          threadId,
          runId,
          resolution,
          wsRoot,
          preRunCwdDisplay: cwdDisplay,
          commandMessageId: commandMessage.id,
          columns,
        });
      });
    this.threadQueues.set(threadId, next);
    void next.finally(() => {
      // Only clear the queue head if no later run took our place.
      if (this.threadQueues.get(threadId) === next) {
        this.threadQueues.delete(threadId);
      }
    });

    return { threadId, runId, resolution };
  }

  private buildInterceptOutput(
    resolution: Extract<ResolvedTerminalInput, { kind: 'intercept' }>,
    workingDir: string,
  ): TerminalMessage {
    let body: string;
    if (resolution.intercept === 'pwd') {
      body = workingDir === '' ? '/' : workingDir;
    } else {
      // clear
      body = '';
    }
    return {
      id: randomUUID(),
      kind: 'output',
      content: body,
      at: nowIso(),
      exitCode: 0,
      durationMs: 0,
      stdout: body,
    };
  }

  private async buildOpenInterceptOutput(args: {
    projectId: string;
    threadId: string;
    workingDir: string;
    cwdDisplay: string;
    wsRoot: string | null;
    path: string;
  }): Promise<{ message: TerminalMessage; path?: string }> {
    const { projectId, threadId, workingDir, cwdDisplay, wsRoot, path } = args;
    const baseMessage = {
      id: randomUUID(),
      kind: 'output' as const,
      at: nowIso(),
      durationMs: 0,
      cwd: cwdDisplay,
    };
    if (!wsRoot) {
      const body = `Couldn't open ${path}: the project workspace is unavailable.`;
      return {
        message: {
          ...baseMessage,
          content: body,
          stdout: body,
          exitCode: 1,
          errorMessage: 'open-workspace-unavailable',
        },
      };
    }

    const shellCwd = this.shellPool.currentCwd(threadId) ?? resolveWorkingCwd(wsRoot, workingDir);
    const target = resolve(shellCwd, path);
    const relativePath = projectRelativeOrAbsolute(wsRoot, target);
    if (isAbsolute(relativePath)) {
      const body = `Couldn't open ${path}: previews are limited to files in this project workspace.`;
      return {
        message: {
          ...baseMessage,
          content: body,
          stdout: body,
          exitCode: 1,
          errorMessage: 'open-outside-workspace',
        },
      };
    }

    const canonicalPath = relativePath.replace(/\\/g, '/');
    const stat = await this.store.statProjectWorkspacePath(projectId, canonicalPath);
    if (stat.kind !== 'file') {
      const reason = stat.kind === 'dir' ? 'is a folder' : 'was not found';
      const body = `Couldn't open ${path}: ${reason}.`;
      return {
        message: {
          ...baseMessage,
          content: body,
          stdout: body,
          exitCode: 1,
          errorMessage: stat.kind === 'dir' ? 'open-is-directory' : 'open-not-found',
        },
      };
    }

    const body = `Opened ${canonicalPath} in References.`;
    return {
      path: canonicalPath,
      message: {
        ...baseMessage,
        content: body,
        stdout: body,
        exitCode: 0,
        fileReferences: [{ label: canonicalPath, path: canonicalPath }],
      },
    };
  }

  /**
   * Dispatch a recognized craftbook command and emit a confirmation
   * output bubble. No shell is spawned. Failures (no invoker wired, or
   * the invoker threw) surface as a non-zero `output` row so the user
   * still gets feedback in the transcript.
   */
  private async runCraftbookInvocation(args: {
    projectId: string;
    workingDir: string;
    threadId: string;
    /** Ties the immediate "Creating task…" live bubble to the final result
     *  bubble, so the streaming slot is released when the result lands. */
    runId: string;
    /** Id of the already-emitted command bubble, so the live slot pairs
     *  with the command it sits below (mirrors the argv `runStarted`). */
    commandMessageId: string;
    resolution: Extract<ResolvedTerminalInput, { kind: 'craftbook' }>;
    cwdDisplay: string;
  }): Promise<void> {
    const { projectId, workingDir, threadId, runId, commandMessageId, resolution, cwdDisplay } =
      args;

    // Immediate feedback: mount the live "growing" output bubble (with its
    // "running Ns" pill) and seed it with a progress line the instant the
    // craftbook is recognized — the invoker below can take a beat to
    // resolve the assignee, create the task, and dispatch its entry turn,
    // and without this the terminal sits silent until the task lands.
    // The final result message carries the same `runId`, so it releases
    // this slot and takes the row over.
    this.events.publish({
      kind: 'runStarted',
      projectId,
      threadId,
      runId,
      commandMessageId,
      at: nowIso(),
      cwd: cwdDisplay,
    });
    this.events.publish({
      kind: 'outputChunk',
      projectId,
      threadId,
      runId,
      chunk: 'Creating task to run this craftbook…\n',
    });

    let body: string;
    let exitCode = 0;
    let errorMessage: string | undefined;
    if (!this.craftbookInvoker) {
      body = 'Craftbook commands are unavailable in this build.';
      exitCode = -1;
      errorMessage = 'craftbook-unavailable';
    } else {
      try {
        const r = await this.craftbookInvoker({
          projectId,
          craftbookId: resolution.id,
          params: resolution.params,
        });
        // e.g. "Task 5 (code-review) has been launched and assigned to Rosalind."
        const num = r.taskRef.split('/').pop() ?? r.taskRef;
        const assigned = r.assigneeName ? ` and assigned to ${r.assigneeName}` : '';
        const verb = r.started ? 'has been launched' : 'has been created';
        body = `Task ${num} (${resolution.command}) ${verb}${assigned}.`;
      } catch (err) {
        body = `Couldn't start ${resolution.command}: ${err instanceof Error ? err.message : String(err)}`;
        exitCode = -1;
        errorMessage = 'craftbook-failed';
      }
    }
    const outputMessage: TerminalMessage = {
      id: randomUUID(),
      kind: 'output',
      content: body,
      at: nowIso(),
      exitCode,
      durationMs: 0,
      cwd: cwdDisplay,
      stdout: body,
      ...(errorMessage ? { errorMessage } : {}),
    };
    await this.store.appendTerminalMessage(projectId, threadId, workingDir, outputMessage);
    this.events.publish({
      kind: 'message',
      projectId,
      threadId,
      workingDir,
      message: outputMessage,
      // Same runId as the runStarted above → releases the live "Creating
      // task…" slot so the result bubble takes over the row.
      runId,
    });
  }

  /**
   * Dispatch a recognized MCP tool command (run via the project tool bridge)
   * and emit its result as an output bubble. No shell is spawned. Failures
   * (no invoker wired, or the invoker threw) surface as a non-zero `output`
   * row so the user still gets feedback.
   */
  private async runMcpToolInvocation(args: {
    projectId: string;
    workingDir: string;
    threadId: string;
    resolution: Extract<ResolvedTerminalInput, { kind: 'mcpTool' }>;
    cwdDisplay: string;
  }): Promise<void> {
    const { projectId, workingDir, threadId, resolution, cwdDisplay } = args;
    let body: string;
    let exitCode = 0;
    let errorMessage: string | undefined;
    if (!this.mcpToolInvoker) {
      body = 'MCP tools are unavailable in this build.';
      exitCode = -1;
      errorMessage = 'mcp-tool-unavailable';
    } else {
      try {
        const r = await this.mcpToolInvoker({
          projectId,
          name: resolution.name,
          args: resolution.args,
        });
        body = r.text || `${resolution.name} completed.`;
      } catch (err) {
        body = `Couldn't run ${resolution.name}: ${err instanceof Error ? err.message : String(err)}`;
        exitCode = -1;
        errorMessage = 'mcp-tool-failed';
      }
    }
    const outputMessage: TerminalMessage = {
      id: randomUUID(),
      kind: 'output',
      content: body,
      at: nowIso(),
      exitCode,
      durationMs: 0,
      cwd: cwdDisplay,
      stdout: body,
      ...(errorMessage ? { errorMessage } : {}),
    };
    await this.store.appendTerminalMessage(projectId, threadId, workingDir, outputMessage);
    this.events.publish({
      kind: 'message',
      projectId,
      threadId,
      workingDir,
      message: outputMessage,
    });
  }

  private async executeAndEmit(args: {
    projectId: string;
    workingDir: string;
    threadId: string;
    runId: string;
    resolution: Extract<ResolvedTerminalInput, { kind: 'argv' }>;
    /** Resolved upstream in `enqueueRun`; null when resolution failed. */
    wsRoot: string | null;
    /** The folder-pill cwd attached to the command bubble emitted in
     *  `enqueueRun`. Used as a fallback for the paired output bubble
     *  when the command failed before producing a fresh cwd. */
    preRunCwdDisplay: string;
    /** Id of the already-emitted command bubble — carried on the
     *  `runStarted` SSE event so the UI can pair the live slot with
     *  the command bubble it sits below. */
    commandMessageId: string;
    /** Client output width, used to size the PTY before execution. */
    columns?: number;
  }): Promise<void> {
    const {
      projectId,
      workingDir,
      threadId,
      runId,
      resolution,
      preRunCwdDisplay,
      commandMessageId,
      columns,
    } = args;

    // Resolve absolute initialCwd from the upstream wsRoot. If
    // wsRoot couldn't be resolved (project deleted between
    // enqueueRun and now), emit an error output bubble — same
    // behavior as before, just lifted now that we share state.
    let wsRoot: string;
    let initialCwd: string;
    try {
      wsRoot = args.wsRoot ?? (await this.store.projectWorkspaceDir(projectId));
      initialCwd = resolveWorkingCwd(wsRoot, workingDir);
    } catch (err) {
      const msg: TerminalMessage = {
        id: randomUUID(),
        kind: 'output',
        content: `Failed to resolve workspace directory: ${err instanceof Error ? err.message : String(err)}`,
        at: nowIso(),
        exitCode: -1,
        errorMessage: 'workspace-resolution-failed',
        cwd: preRunCwdDisplay,
      };
      await this.store.appendTerminalMessage(projectId, threadId, workingDir, msg);
      this.events.publish({ kind: 'message', projectId, threadId, workingDir, message: msg });
      return;
    }

    log.info(
      `[terminal] run ${runId} project=${projectId} initialCwd=${initialCwd} bin=${resolution.bin} args=${resolution.args.length}`,
    );

    // Tell the UI a streaming run has started so it can mount the
    // live "growing" bubble. Emitted BEFORE shellPool.run so the
    // first onChunk event lands on a slot that already exists.
    this.events.publish({
      kind: 'runStarted',
      projectId,
      threadId,
      runId,
      commandMessageId,
      at: nowIso(),
      cwd: preRunCwdDisplay,
    });

    // Register for cancellation. Removed in the finally below so
    // a late `cancelRun(runId)` after completion is a quiet no-op.
    this.activeRunThreads.set(runId, threadId);

    let result: Awaited<ReturnType<typeof this.shellPool.run>>;
    // Keep the live transcript as a safety net for the settled handoff. The
    // PTY normally returns the same complete buffer from `run()`, but the UI
    // must never replace visible streamed output with an empty durable row if
    // a platform-specific prompt/sentinel edge case leaves that final buffer
    // blank. The streaming path is already scrubbed of command echo and
    // sentinel bytes by PersistentShell, so it is safe to persist as the
    // fallback transcript.
    let streamedOutput = '';
    try {
      try {
        result = await this.shellPool.run(threadId, {
          initialCwd,
          command: resolution.run,
          columns,
          onChunk: (chunk) => {
            streamedOutput += chunk;
            // Cap individual envelope payloads at ~8KB to keep the
            // SSE pipe from holding a single multi-megabyte event in
            // a synchronous publish loop. Larger chunks (rare —
            // node-pty's read buffer is usually a few KB at most)
            // get split.
            for (let i = 0; i < chunk.length; i += 8192) {
              this.events.publish({
                kind: 'outputChunk',
                projectId,
                threadId,
                runId,
                chunk: chunk.slice(i, i + 8192),
              });
            }
          },
          onPromptDetected: ({ promptLine, mode }) => {
            this.events.publish({
              kind: 'inputRequested',
              projectId,
              threadId,
              runId,
              promptLine,
              mode,
            });
          },
        });
      } catch (err) {
        const msg: TerminalMessage = {
          id: randomUUID(),
          kind: 'output',
          content: err instanceof Error ? err.message : String(err),
          at: nowIso(),
          exitCode: -1,
          errorMessage: 'shell-failed',
          cwd: preRunCwdDisplay,
        };
        await this.store.appendTerminalMessage(projectId, threadId, workingDir, msg);
        this.events.publish({
          kind: 'message',
          projectId,
          threadId,
          workingDir,
          message: msg,
          runId,
        });
        return;
      }
    } finally {
      // Run is no longer cancellable. Same path applies to error,
      // success, and the success branch below — we leave the entry
      // present through the final-message emission so the cancel
      // handler can't race with the resolve.
      this.activeRunThreads.delete(runId);
    }

    // Cwd drift: project-relative the shell's new cwd if it landed
    // inside the workspace; otherwise pass the absolute path so the
    // picker can display it and the user knows where they are.
    const newDisplayDir = projectRelativeOrAbsolute(wsRoot, result.newCwd);
    const settledOutput = result.output || streamedOutput.replace(/\s+$/, '');

    const outputMessage: TerminalMessage = {
      id: randomUUID(),
      kind: 'output',
      content: settledOutput,
      at: nowIso(),
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      // The output bubble's cwd is where the command LANDED — same
      // as the next command bubble's pre-run cwd. Makes a `cd foo`
      // bubble pair read naturally: `> cd foo [/]` followed by
      // `terminal output [foo]`.
      cwd: newDisplayDir,
      // PTY merges stdout + stderr; surface as stdout, leave stderr
      // unset rather than fake-splitting.
      ...(settledOutput ? { stdout: settledOutput } : {}),
      ...(result.truncated ? { truncated: true } : {}),
      ...(await this.collectListingFileReferences(
        projectId,
        preRunCwdDisplay,
        resolution,
        settledOutput,
      )),
    };
    await this.store.appendTerminalMessage(projectId, threadId, workingDir, outputMessage);
    this.events.publish({
      kind: 'message',
      projectId,
      threadId,
      workingDir,
      message: outputMessage,
      runId,
    });

    // Fire when the cwd differs from where it was BEFORE this
    // command ran — not from the thread anchor. Comparing against
    // the anchor would miss `cd ..` back to root (newDisplayDir
    // and workingDir are both `''`, so the picker would stay
    // stuck on the prior subdir). `preRunCwdDisplay` carries the
    // pre-run cwd from `enqueueRun` for exactly this comparison.
    if (newDisplayDir !== preRunCwdDisplay) {
      this.events.publish({
        kind: 'workingDirChanged',
        projectId,
        threadId,
        newWorkingDir: newDisplayDir,
      });
    }

    await this.history?.log({
      kind: 'terminal.command.run',
      projectId,
      summary: `Terminal: ${resolution.run}`,
      details: {
        source: 'user-terminal',
        threadId,
        runId,
        workingDir,
        run: resolution.run,
        ...(resolution.resolvedFrom ? { resolvedFrom: resolution.resolvedFrom } : {}),
        ...(resolution.matchedKind ? { matchedKind: resolution.matchedKind } : {}),
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        ...(newDisplayDir !== workingDir ? { cwdChangedTo: newDisplayDir } : {}),
      },
    });
  }

  private async collectListingFileReferences(
    projectId: string,
    cwdDisplay: string,
    resolution: Extract<ResolvedTerminalInput, { kind: 'argv' }>,
    output: string,
  ): Promise<{ fileReferences?: TerminalFileReference[] }> {
    if (!isDirectoryListingCommand(resolution.bin) || !output || isAbsolute(cwdDisplay)) return {};
    try {
      const entries = await this.store.listProjectWorkspace(projectId, cwdDisplay);
      const references = entries
        .filter((entry) => !entry.isDirectory && output.includes(entry.name))
        .slice(0, 200)
        .map((entry) => ({ label: entry.name, path: entry.path }));
      return references.length > 0 ? { fileReferences: references } : {};
    } catch {
      // Linking is a transcript enhancement; never turn a successful shell
      // command into a failure because the workspace changed mid-listing.
      return {};
    }
  }
}

function isDirectoryListingCommand(bin: string): boolean {
  const leaf = bin.replace(/\\/g, '/').split('/').at(-1)?.toLowerCase();
  return leaf === 'ls' || leaf === 'dir' || leaf === 'gci' || leaf === 'get-childitem';
}

/**
 * Compose an absolute cwd from a project workspace root + relative
 * `workingDir`. Empty workingDir → root. Defends against path
 * traversal: if `workingDir` resolves outside `wsRoot`, throw rather
 * than running there. The cwd is the only path argument we honor from
 * user input; everything else (`bin`, `args`) is positional argv that
 * the spawned process gets verbatim.
 */
function resolveWorkingCwd(wsRoot: string, workingDir: string): string {
  const trimmed = workingDir.replace(/^\/+/, '').replace(/\/+$/, '');
  if (trimmed === '') return wsRoot;
  const joined = safeJoin(wsRoot, trimmed);
  if (!joined) {
    throw new Error(`workingDir escapes workspace: ${workingDir}`);
  }
  return joined;
}

/**
 * Convert an absolute cwd reported by the shell into the display
 * value the folder picker should show. Inside the workspace → the
 * project-relative path (`''` for root, `'packages/ui'` for subdir).
 * Project-relative paths are always returned with forward-slash
 * separators regardless of OS — they're a gezel-domain path, and we
 * want gezel UI / prompts / docs to read the same on macOS, Linux,
 * and Windows. Outside the workspace (user `cd /tmp` or `cd
 * C:\Users\…`) → return the absolute path **unchanged** in its
 * native OS form so the user can still copy-paste it into File
 * Explorer / a non-shell tool. Resolves symlinks via `normalize`
 * only — we don't call `realpath` here because `wsRoot` and the
 * shell's `$PWD` already came through the same path normalization
 * upstream.
 */
function projectRelativeOrAbsolute(wsRoot: string, absoluteCwd: string): string {
  const root = normalize(wsRoot);
  const cwd = normalize(absoluteCwd);
  if (cwd === root) return '';
  const rel = relative(root, cwd);
  // `relative` returns `..` / `../foo` when the cwd is outside; in
  // that case fall back to the absolute path. Also guard against
  // empty relpaths (same dir) and explicit upward traversal.
  if (rel === '' || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\')) {
    return absoluteCwd;
  }
  // Force forward-slash separators for project-relative paths even
  // when running on Windows, where `node:path.relative` returns
  // backslash-separated paths. The schema's `workingDir` /
  // `TerminalMessage.cwd` are gezel-domain values and stay
  // consistent cross-platform.
  return rel.replace(/\\/g, '/');
}
