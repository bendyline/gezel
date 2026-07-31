import { pathToFileURL } from 'node:url';
import { createLogger, resolveSandboxCopilot } from '@bendyline/gezel';
import type { QuotaBucket } from '../chat/usage.js';
import { resolveCopilotCliPath } from './copilot-cli.js';
import { ProviderQueue, runInQueue } from './queue.js';
import { StreamingSessionBase } from './streaming-session.js';
import {
  ExternalToolsUnsupportedError,
  type ImageAttachment,
  type LLMProvider,
  type LLMSession,
  type ModelInfo,
  type ProviderSessionState,
  type SendAndWaitOpts,
  type SessionOpts,
  SessionResumeError,
  type ToolCallEvent,
  type TurnUsage,
} from './types.js';
import { buildTurnUsage } from './usage-builder.js';

const log = createLogger('copilot');

/**
 * Post-activity silence after which `sendAndWait` assumes the Copilot SDK
 * is stuck waiting for a `session.idle` event that will never arrive, and
 * falls back to the buffered reply. Covers the observed case where the
 * model completes tool calls + final text but the SDK hangs until its
 * `timeoutMs` fires ~3 min later. Tuned conservative: cold-start gaps can
 * reach ~90s, but those happen before the *first* delta — once the model
 * has started speaking, 30s of dead silence means it's done.
 */
const IDLE_SILENCE_MS = 30_000;
/** How often the idle-silence watchdog re-checks. Cheap poll. */
const WATCHDOG_INTERVAL_MS = 2_000;

/** Subset of the `@github/copilot-sdk` message-payload shape we hand in. */
interface CopilotSendOpts {
  prompt: string;
  /**
   * Blob attachments — pasted/uploaded images for vision-capable models.
   * The SDK's own type allows `file`/`directory`/`selection`/`blob`; we
   * only populate `blob` because our storage lives inside gezel's home
   * and doesn't have real filesystem paths the Copilot agent can stat.
   */
  attachments?: Array<{
    type: 'blob';
    data: string;
    mimeType: string;
    displayName?: string;
  }>;
}

interface CopilotSessionHandle {
  readonly sessionId: string;
  on: (
    eventType: string,
    handler: (event: { data: Record<string, unknown> }) => void,
  ) => () => void;
  sendAndWait: (
    opts: CopilotSendOpts,
    timeout?: number,
  ) => Promise<{ data?: { content?: string } } | undefined>;
  disconnect: () => Promise<void>;
}

interface CopilotModel {
  id: string;
  name: string;
  capabilities?: {
    supports?: { reasoningEffort?: boolean };
    limits?: { max_context_window_tokens?: number };
  };
  supportedReasoningEfforts?: string[];
  defaultReasoningEffort?: string;
}

interface CopilotClientHandle {
  start: () => Promise<void>;
  stop: () => Promise<unknown>;
  createSession: (config: Record<string, unknown>) => Promise<CopilotSessionHandle>;
  resumeSession: (
    sessionId: string,
    config: Record<string, unknown>,
  ) => Promise<CopilotSessionHandle>;
  listModels: () => Promise<CopilotModel[]>;
  getAuthStatus: () => Promise<CopilotAuthStatus>;
}

export interface CopilotAuthStatus {
  isAuthenticated: boolean;
  authType?: 'user' | 'env' | 'gh-cli' | 'hmac' | 'api-key' | 'token';
  host?: string;
  login?: string;
  statusMessage?: string;
}

/**
 * Wraps `@github/copilot-sdk` as an LLMProvider. Behavior is unchanged from
 * the previous inline integration in ChatManager — session lifecycle,
 * system-message config, MCP wiring, and the delta-buffer fallback for
 * sendAndWait are all identical.
 */
export class CopilotProvider implements LLMProvider {
  readonly name = 'copilot' as const;
  readonly queue: ProviderQueue;
  private client: CopilotClientHandle | null = null;
  private readonly githubToken?: string;
  /**
   * Absolute path to a `dist/cjs/index.js` inside a `~/.gezel/system-toolsets/`
   * install of `@github/copilot-sdk`. When set, we dynamic-import from
   * there instead of using Node's default resolver — this is the
   * production path where the SDK lives outside the Electron bundle. In
   * dev, this is left unset and we fall back to the workspace's own
   * devDependency copy of the SDK.
   */
  private readonly sdkEntryPath?: string;
  /**
   * Root of that same system-toolsets install. The CLI binary the SDK
   * drives ships as an optional dep beneath it, and the SDK cannot find
   * it on its own — see `resolveCopilotCliPath`.
   */
  private readonly sdkInstallRoot?: string;

  constructor(opts: {
    githubToken?: string;
    sdkEntryPath?: string;
    sdkInstallRoot?: string;
    concurrency?: number;
    affinity?: boolean;
  }) {
    this.githubToken = opts.githubToken;
    this.sdkEntryPath = opts.sdkEntryPath;
    this.sdkInstallRoot = opts.sdkInstallRoot;
    this.queue = new ProviderQueue({
      concurrency: opts.concurrency ?? 10,
      ...(opts.affinity !== undefined ? { affinity: opts.affinity } : {}),
    });
  }

  async initialize(): Promise<void> {
    if (this.client) return;
    const mod = await this.loadSdk();
    const CopilotClient = (mod as Record<string, unknown>).CopilotClient as new (
      opts?: Record<string, unknown>,
    ) => CopilotClientHandle;
    const clientOpts: Record<string, unknown> = {};
    if (this.githubToken) clientOpts.githubToken = this.githubToken;
    // `COPILOT_CLI_PATH` rather than a `RuntimeConnection.forStdio({ path })`
    // override: it feeds both the spawned-child and in-process FFI code
    // paths, and leaves the caller's choice of connection kind alone.
    const cli = resolveCopilotCliPath({ installRoot: this.sdkInstallRoot ?? null });
    if (cli) {
      log.info(`[copilot] CLI resolved (${cli.source}): ${cli.path}`);
      clientOpts.env = { ...definedEnv(), COPILOT_CLI_PATH: cli.path };
    } else {
      log.warn('[copilot] no Copilot CLI found; falling back to the SDK lookup');
    }
    const client = new CopilotClient(clientOpts);
    log.info('[copilot] starting CopilotClient...');
    try {
      await client.start();
    } catch (err) {
      throw translateCopilotStartError(err, Boolean(this.githubToken));
    }
    log.info('[copilot] CopilotClient started');
    this.client = client;
  }

  /**
   * Resolve the Copilot SDK module. When `sdkEntryPath` is set (the
   * production path where the SDK lives at
   * `~/.gezel/system-toolsets/...`), we dynamic-import from that
   * absolute path. Otherwise we fall back to the bare specifier, which
   * Node resolves from the service's own `node_modules` — this is the
   * dev path where the SDK is a devDependency.
   */
  private async loadSdk(): Promise<unknown> {
    return this.sdkEntryPath
      ? await import(pathToFileURL(this.sdkEntryPath).href)
      : await import('@github/copilot-sdk');
  }

  async shutdown(): Promise<void> {
    if (this.client) {
      try {
        await this.client.stop();
      } catch {
        /* ignore */
      }
      this.client = null;
    }
  }

  async createSession(opts: SessionOpts): Promise<LLMSession> {
    // The Copilot SDK runs its own tool loop; caller-supplied tools can't
    // be advertised-but-not-executed. Refuse loudly — silently dropping
    // them would hand the caller plain text with no tool calls and no
    // signal why (the exact failure `/v1` promises not to have).
    if (opts.externalTools && opts.externalTools.length > 0) {
      throw new ExternalToolsUnsupportedError(this.name);
    }
    await this.initialize();
    if (!this.client) throw new Error('[copilot] client not initialized');
    const sessionConfig = await this.buildSessionConfig(opts);
    const session = await this.client.createSession(sessionConfig);
    return new CopilotSession(session, this.queue, opts.onToolCall);
  }

  async resumeSession(sessionId: string, opts: SessionOpts): Promise<LLMSession> {
    await this.initialize();
    if (!this.client) throw new Error('[copilot] client not initialized');
    // Resume uses the same config shape as create, minus any server-derived
    // fields the SDK strips internally via ResumeSessionConfig.
    const sessionConfig = await this.buildSessionConfig(opts);
    try {
      log.info(`[copilot] resuming session ${sessionId}`);
      const session = await this.client.resumeSession(sessionId, sessionConfig);
      return new CopilotSession(session, this.queue, opts.onToolCall);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new SessionResumeError(`Copilot session ${sessionId} could not be resumed: ${message}`);
    }
  }

  private async buildSessionConfig(opts: SessionOpts): Promise<Record<string, unknown>> {
    const sandboxCopilot = resolveSandboxCopilot(opts.sandboxCopilot);
    let approveAllFn: unknown;
    if (!sandboxCopilot) {
      try {
        const sdkMod = await this.loadSdk();
        approveAllFn = (sdkMod as Record<string, unknown>).approveAll;
      } catch {
        /* fall through */
      }
    }

    const systemMessage = sandboxCopilot
      ? buildSandboxSystemMessage(opts.systemMessage)
      : opts.systemMessage;
    const sessionConfig: Record<string, unknown> = {
      systemMessage: { mode: 'replace' as const, content: systemMessage },
      onPermissionRequest: sandboxCopilot
        ? buildSandboxPermissionHandler(opts.onSandboxDenial)
        : (approveAllFn ?? (() => ({ kind: PERMISSION_APPROVE }))),
    };
    // `excludedTools` at the session level only accepts Copilot built-in
    // tool names — the SDK logs "Unknown tool name in the tool excludedlist"
    // for anything it doesn't recognize. Our overlapping MCP tools are
    // stripped by not registering them in the MCP subprocess (see
    // `GEZEL_MCP_EXCLUDE` handling in gezel-mcp's server). Here we only
    // use excludedTools for the sandbox-on case, where the targets are
    // real Copilot built-ins.
    if (sandboxCopilot) {
      sessionConfig.excludedTools = SANDBOX_EXCLUDED_TOOLS;
    }
    if (opts.model) sessionConfig.model = opts.model;
    if (opts.reasoningEffort) sessionConfig.reasoningEffort = opts.reasoningEffort;
    const mcpServers: Record<string, unknown> = {};
    if (opts.mcpServer) {
      mcpServers.gezel = {
        type: 'local',
        command: opts.mcpServer.command,
        args: opts.mcpServer.args,
        env: opts.mcpServer.env,
        tools: ['*'],
      };
    }
    if (opts.extraMcpServers) {
      for (const extra of opts.extraMcpServers) {
        // Namespace by toolset id. If a toolset collides with `gezel`
        // somehow, the primary wins since it's added first.
        if (extra.id === 'gezel' || mcpServers[extra.id]) continue;
        // Copilot's MCP integration only speaks stdio (`type: 'local'`);
        // hosted http-mcp entries would need a different shape we don't
        // wire up today — skip silently.
        if (extra.kind === 'http') continue;
        mcpServers[extra.id] = {
          type: 'local',
          command: extra.command,
          args: extra.args,
          env: extra.env,
          ...(extra.cwd ? { cwd: extra.cwd } : {}),
          tools: ['*'],
        };
      }
    }
    if (Object.keys(mcpServers).length > 0) {
      sessionConfig.mcpServers = mcpServers;
    }
    return sessionConfig;
  }

  async listModels(): Promise<ModelInfo[]> {
    await this.initialize();
    if (!this.client) throw new Error('[copilot] client not initialized');
    const raw = await this.client.listModels();
    return raw.map((m) => ({
      id: m.id,
      name: m.name,
      supportsReasoning: m.capabilities?.supports?.reasoningEffort ?? false,
      reasoningEfforts: m.supportedReasoningEfforts,
      defaultReasoningEffort: m.defaultReasoningEffort,
      contextWindow: m.capabilities?.limits?.max_context_window_tokens,
    }));
  }

  async getAuthStatus(): Promise<CopilotAuthStatus> {
    await this.initialize();
    if (!this.client) throw new Error('[copilot] client not initialized');
    return this.client.getAuthStatus();
  }
}

class CopilotSession extends StreamingSessionBase implements LLMSession {
  private readonly unsubs: Array<() => void> = [];
  /**
   * In-flight tool calls keyed by the SDK's `toolCallId`. We match the
   * `tool.execution_start` event to the corresponding `tool.execution_complete`
   * to compute a duration and forward one `ToolCallEvent` upstream via
   * `onToolCall`. Fixes the long-standing "Copilot hides tool calls"
   * blindspot — before this, the CopilotSession only listened for text
   * deltas and the References pane stayed empty even when the model ran
   * `write_artifact` / `read_artifact` etc.
   */
  private readonly pendingToolCalls = new Map<
    string,
    { name: string; args: Record<string, unknown>; startedAt: number }
  >();
  /**
   * Wall-clock timestamp of the last "something happened" signal from the
   * SDK — a text delta, reasoning delta, intent announcement, or tool
   * execution start/complete. `sendAndWait` watches this to detect the
   * known Copilot SDK bug where `session.idle` never fires after the model
   * has finished: once no activity has occurred for `IDLE_SILENCE_MS` and
   * we already have buffered content, we resolve with the buffer instead
   * of waiting out the full `timeoutMs`. Zero when no activity yet.
   */
  private lastActivityAt = 0;
  /**
   * Aggregated `assistant.reasoning_delta` text for the current turn.
   * Reset at the top of each `sendAndWaitInner`; read by ChatManager
   * via `getLastTurnReasoning()` after the turn resolves.
   */
  private lastTurnReasoning = '';

  constructor(
    private readonly session: CopilotSessionHandle,
    private readonly queue: ProviderQueue,
    private readonly onToolCall?: (info: ToolCallEvent) => void | Promise<void>,
  ) {
    super();
    // Text deltas — the model's actual reply, streamed token-by-token.
    this.unsubs.push(
      session.on('assistant.message_delta', (event) => {
        const chunk = typeof event.data?.deltaContent === 'string' ? event.data.deltaContent : '';
        if (chunk) {
          this.lastActivityAt = Date.now();
          this.emitDelta(chunk);
        }
      }),
    );
    // Reasoning deltas — extended-thinking tokens, for reasoning-capable
    // Copilot models. Stream them inline so the user sees forward
    // motion instead of silent dots while the model is thinking, AND
    // accumulate them separately: the SDK's final message content
    // excludes the reasoning trace, so without the capture everything
    // the user watched stream evaporates the moment the turn commits.
    // ChatManager reads the capture via `getLastTurnReasoning()` and
    // persists it on `ChatMessage.reasoning`.
    this.unsubs.push(
      session.on('assistant.reasoning_delta' as string, (event) => {
        const chunk =
          typeof event.data?.deltaContent === 'string' ? (event.data.deltaContent as string) : '';
        if (chunk) {
          this.lastActivityAt = Date.now();
          this.lastTurnReasoning += chunk;
          this.emitDelta(chunk);
        }
      }),
    );
    // Tool-call surfacing. The SDK runs its tools in-process, but these
    // events expose them to us — enough to drive the References pane.
    // Exception: the model's built-in `report_intent` tool is treated as
    // a phase-announcement event instead of a normal tool call. We emit
    // an `intent` signal at start time and do NOT register it as a
    // pending tool, so the `_complete` path has nothing to dispatch and
    // the tool-call list stays free of the phase-announcement noise.
    // The SDK's separate `assistant.intent` event is unreliable in
    // practice (doesn't fire for every `report_intent` invocation) —
    // intercepting at the tool layer is the one source of truth.
    this.unsubs.push(
      session.on('tool.execution_start' as string, (event) => {
        const d = (event.data ?? {}) as {
          toolCallId?: string;
          toolName?: string;
          mcpToolName?: string;
          arguments?: Record<string, unknown>;
        };
        const id = typeof d.toolCallId === 'string' ? d.toolCallId : null;
        if (!id) return;
        // Prefer the underlying MCP tool name when present — it's the
        // `read_artifact` / `write_artifact` / etc. name the UI routes
        // on, rather than the SDK's internal wrapper label.
        const name = (d.mcpToolName ?? d.toolName ?? 'unknown') as string;
        const args =
          d.arguments && typeof d.arguments === 'object'
            ? (d.arguments as Record<string, unknown>)
            : {};
        this.lastActivityAt = Date.now();
        if (name === 'report_intent') {
          const intent = typeof args.intent === 'string' ? args.intent.trim() : '';
          if (intent) this.emitIntent(intent);
          return;
        }
        this.pendingToolCalls.set(id, { name, args, startedAt: Date.now() });
      }),
    );
    this.unsubs.push(
      session.on('tool.execution_complete' as string, (event) => {
        const d = (event.data ?? {}) as {
          toolCallId?: string;
          success?: boolean;
          error?: { message?: string } | string;
        };
        const id = typeof d.toolCallId === 'string' ? d.toolCallId : null;
        if (!id) return;
        const pending = this.pendingToolCalls.get(id);
        if (!pending) return;
        this.lastActivityAt = Date.now();
        this.pendingToolCalls.delete(id);
        const errorMessage =
          typeof d.error === 'string'
            ? d.error
            : typeof d.error?.message === 'string'
              ? d.error.message
              : undefined;
        const info: ToolCallEvent = {
          name: pending.name,
          argKeys: Object.keys(pending.args),
          args: pending.args,
          durationMs: Date.now() - pending.startedAt,
          success: d.success !== false,
          ...(errorMessage ? { errorMessage } : {}),
        };
        try {
          void this.onToolCall?.(info);
        } catch (err) {
          log.warn('[copilot] onToolCall handler threw:', err);
        }
      }),
    );
    this.unsubs.push(
      session.on('assistant.usage' as string, (event) => {
        this.emitUsage(parseUsage(event.data));
      }),
    );
    this.unsubs.push(
      session.on('session.error' as string, (event) => {
        log.error('[copilot] session.error:', event.data);
      }),
    );
    // Warnings still log to the console (visible to operators), and
    // also fan out to the UI as inline banners on the streaming
    // bubble so the user doesn't have to tail server logs to see
    // e.g. rate-limit or degraded-mode notices mid-turn.
    this.unsubs.push(
      session.on('session.warning' as string, (event) => {
        log.warn('[copilot] session.warning:', event.data);
        const msg = extractMessage(event.data);
        if (msg) this.emitWarning(msg);
      }),
    );
    this.unsubs.push(
      session.on('session.info' as string, (event) => {
        log.info('[copilot] session.info:', event.data);
      }),
    );
    // Thinking phases — emitted by the Copilot SDK while the model
    // is reasoning server-side without producing visible tokens.
    // Without these, the UI's "silent for Xs" clock climbs during
    // legitimate deep-reasoning phases and the user gets a false
    // "it's stalled" banner. Treating both start and stop as
    // activity keeps the clock pinned to real wall-clock silence.
    this.unsubs.push(
      session.on('session.thinking_start' as string, (event) => {
        this.lastActivityAt = Date.now();
        const label = extractLabel(event.data) ?? 'thinking';
        this.emitHeartbeat(label);
      }),
    );
    this.unsubs.push(
      session.on('session.thinking_stop' as string, () => {
        this.lastActivityAt = Date.now();
        this.emitHeartbeat(undefined);
      }),
    );
  }

  async sendAndWait(prompt: string, opts?: SendAndWaitOpts): Promise<string> {
    return runInQueue(this.queue, opts?.queue, () => this.sendAndWaitInner(prompt, opts));
  }

  private async sendAndWaitInner(prompt: string, opts?: SendAndWaitOpts): Promise<string> {
    const timeoutMs = opts?.timeoutMs ?? 120_000;
    this.lastTurnReasoning = '';
    let buffer = '';
    const unsub = this.onDelta((c) => {
      buffer += c;
    });
    this.lastActivityAt = Date.now();
    try {
      try {
        const payload: CopilotSendOpts = { prompt };
        if (opts?.attachments && opts.attachments.length > 0) {
          payload.attachments = opts.attachments.map((a) => ({
            type: 'blob' as const,
            data: a.base64,
            mimeType: a.mimeType,
            displayName: a.filename,
          }));
        }

        // Known Copilot SDK bug: `session.idle` sometimes never fires after
        // the model is done, and we end up waiting out the full `timeoutMs`
        // (typically 3 min) while the UI sits on a "thinking" indicator.
        // Race the SDK call against an idle-activity watchdog: if no
        // deltas or tool events have arrived in IDLE_SILENCE_MS and we've
        // already buffered a reply, resolve with the buffer.
        const sdkCall = this.session.sendAndWait(payload, timeoutMs);
        let watchdogTimer: ReturnType<typeof setInterval> | null = null;
        const watchdog = new Promise<string>((resolve) => {
          watchdogTimer = setInterval(() => {
            if (buffer.length === 0) return;
            const silentFor = Date.now() - this.lastActivityAt;
            if (silentFor > IDLE_SILENCE_MS) {
              log.warn(
                `[copilot] session.idle never fired; returning ${buffer.length} buffered chars after ${silentFor}ms silence`,
              );
              resolve(buffer);
            }
          }, WATCHDOG_INTERVAL_MS);
        });

        try {
          const winner = await Promise.race([
            sdkCall.then((result) => {
              const apiContent =
                typeof result?.data?.content === 'string' ? result.data.content : '';
              return apiContent || this.stripReasoningPrefix(buffer);
            }),
            watchdog.then((buffered) => this.stripReasoningPrefix(buffered)),
          ]);
          return winner;
        } finally {
          if (watchdogTimer) clearInterval(watchdogTimer);
          // If the watchdog won, the SDK promise is still in flight — swallow
          // its eventual rejection so Node doesn't log an unhandled rejection.
          sdkCall.catch(() => {
            /* already resolved via watchdog */
          });
        }
      } catch (err) {
        // Ephemeral sessions can reject on session.idle even when the full
        // response streamed via deltas. Use buffered content if present.
        if (buffer.length > 0) {
          const msg = err instanceof Error ? err.message : String(err);
          log.warn(
            `[copilot] sendAndWait rejected (${msg}); using ${buffer.length} buffered chars`,
          );
          return this.stripReasoningPrefix(buffer);
        }
        throw err;
      }
    } finally {
      unsub();
    }
  }

  /**
   * The delta buffer used by the idle-watchdog / rejection fallbacks
   * interleaves reasoning deltas with the visible reply — reasoning is
   * emitted inline for live streaming. Since the captured reasoning now
   * persists separately on `ChatMessage.reasoning`, leaving it in the
   * fallback content would show the same text twice (body + expando).
   * Reasoning streams ahead of the reply, so a prefix strip covers the
   * normal shape; if tool activity interleaved the two, return the
   * buffer untouched rather than corrupt it. A reasoning-only buffer
   * strips to '' — the chat bubble renders its "model produced
   * reasoning but no visible reply" placeholder for that case.
   */
  private stripReasoningPrefix(buffer: string): string {
    if (this.lastTurnReasoning.length === 0) return buffer;
    if (!buffer.startsWith(this.lastTurnReasoning)) return buffer;
    return buffer.slice(this.lastTurnReasoning.length);
  }

  getLastTurnReasoning(): string | undefined {
    return this.lastTurnReasoning.length > 0 ? this.lastTurnReasoning : undefined;
  }

  providerState(): ProviderSessionState {
    return { copilotSessionId: this.session.sessionId };
  }

  async disconnect(): Promise<void> {
    for (const u of this.unsubs) {
      try {
        u();
      } catch {
        /* ignore */
      }
    }
    this.unsubs.length = 0;
    try {
      await this.session.disconnect();
    } catch {
      /* ignore */
    }
  }
}

function extractMessage(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  const fields = ['message', 'reason', 'detail', 'description', 'text'];
  for (const f of fields) {
    const v = d[f];
    if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  }
  return null;
}

function extractLabel(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  const fields = ['label', 'phase', 'name', 'kind'];
  for (const f of fields) {
    const v = d[f];
    if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  }
  return null;
}

function parseUsage(d: Record<string, unknown>): TurnUsage {
  const snapshots = d.quotaSnapshots as Record<string, Record<string, unknown>> | undefined;
  let buckets: QuotaBucket[] | undefined;
  if (snapshots) {
    const collected: QuotaBucket[] = [];
    for (const [name, bucket] of Object.entries(snapshots)) {
      const limit = (bucket.entitlementRequests as number) ?? 0;
      const used = (bucket.usedRequests as number) ?? 0;
      collected.push({
        name,
        isUnlimited: (bucket.isUnlimitedEntitlement as boolean) ?? false,
        limit,
        used,
        remaining: Math.max(limit - used, 0),
        remainingPercent: (bucket.remainingPercentage as number) ?? 1,
        overage: (bucket.overage as number) ?? 0,
        resetDate: (bucket.resetDate as string) ?? undefined,
      });
    }
    // Most-constrained buckets first so the UI can feature them.
    collected.sort((a, b) => {
      if (a.isUnlimited !== b.isUnlimited) return a.isUnlimited ? 1 : -1;
      return a.remainingPercent - b.remainingPercent;
    });
    if (collected.length > 0) buckets = collected;
  }

  return buildTurnUsage({
    model: (d.model as string) ?? 'unknown',
    inputTokens: (d.inputTokens as number) ?? 0,
    outputTokens: (d.outputTokens as number) ?? 0,
    cost: (d.cost as number) ?? 0,
    durationMs: (d.duration as number) ?? 0,
    ...(buckets ? { quotaBuckets: buckets } : {}),
  });
}

/**
 * `process.env` with the `undefined` values dropped — the SDK passes the
 * env we hand it straight to `child_process.spawn`.
 */
function definedEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * The Copilot CLI subprocess writes `(node:NNNN) ExperimentalWarning: ...`
 * lines to stderr even on a healthy run. On an unauthenticated machine, the
 * process also exits with code 0 before printing `listening on port ...`,
 * so the SDK raises `CLI server exited with code 0\nstderr: <that warning>`
 * — a wall of text whose actual meaning is "you aren't logged in yet."
 *
 * This translator strips those warning lines and, for the
 * clean-exit-without-port pattern, replaces the message with something the
 * user can act on. The returned Error has a `.isActionable = true` marker
 * so upstream doesn't append its own generic "check credentials" suffix.
 */
function translateCopilotStartError(err: unknown, hasToken: boolean): Error {
  const raw = err instanceof Error ? err.message : String(err);
  const stripped = stripExperimentalWarnings(raw);
  // The SDK words this two ways: "exited with code 0" when the CLI died
  // during startup, "exited unexpectedly with code 0" when it died after
  // reporting ready with nothing on stderr. Both mean the same thing to
  // a user.
  const cleanedExit = /CLI server exited (?:unexpectedly )?with code 0\b/.test(stripped);
  if (cleanedExit) {
    const guidance = hasToken
      ? 'The saved GitHub token was rejected by Copilot. Confirm the token has Copilot access, or run `npx @github/copilot login` to re-authenticate.'
      : 'Copilot CLI is not authenticated. Run `npx @github/copilot login` to sign in, or paste a GitHub token with Copilot access in Settings.';
    const wrapped = new Error(guidance) as Error & { isActionable?: boolean };
    wrapped.isActionable = true;
    return wrapped;
  }
  if (/@github\/copilot platform package/.test(stripped)) {
    const wrapped = new Error(
      'The Copilot CLI binary is missing from this install. Install the CLI yourself ' +
        '(`npm i -g @github/copilot`), or set COPILOT_CLI_PATH to an existing one.',
    ) as Error & { isActionable?: boolean };
    wrapped.isActionable = true;
    return wrapped;
  }
  const wrapped = new Error(stripped) as Error & { isActionable?: boolean };
  return wrapped;
}

/**
 * Copilot SDK built-ins the model will propose by name. In sandbox mode
 * we blacklist them explicitly so the SDK doesn't even serialize their
 * schemas into the request — saves turns the model would otherwise waste
 * asking for something we'll deny. The `onPermissionRequest` kind filter
 * below is the real load-bearing check; this list is an optimization.
 * Any built-ins added by future SDK versions will still be caught there.
 */
export const SANDBOX_EXCLUDED_TOOLS = [
  'bash',
  'web_fetch',
  'view',
  'read_file',
  'write_file',
  'edit_file',
  'str_replace_editor',
  'grep',
];

/**
 * Our MCP tools that duplicate a Copilot built-in. When the user has
 * chosen to leave Copilot's built-ins active (sandbox off), we hide our
 * overlapping MCP copies so the model doesn't flip-flop between the two
 * equivalent surfaces turn by turn. Tools with no built-in equivalent
 * (run_git, diff_files, list/extract_archive) stay advertised. When
 * sandbox is ON, none of this applies — Copilot built-ins are denied
 * and these MCP tools are the only path.
 */
export const NON_SANDBOX_EXCLUDED_MCP_TOOLS = [
  'fetch_url',
  'search_files',
  'find_files',
  'read_image_as_base64',
];

/**
 * The two permission decisions a client is allowed to send back.
 *
 * The SDK's `PermissionDecision` union mixes two directions of travel:
 * *request* variants a handler may return (`approve-once`,
 * `approve-for-session`, `reject`, `user-not-available`, …) and *outcome*
 * variants the CLI emits to describe what happened (`approved`,
 * `denied-by-rules`, `cancelled`, …). Returning an outcome kind is
 * rejected by the CLI with `unexpected user permission response: <kind>`,
 * which fails the tool call rather than allowing or denying it — every
 * MCP call in the session errors out and the model retries forever.
 * `approveAll()` from the SDK returns `approve-once` for the same reason.
 */
const PERMISSION_APPROVE = 'approve-once';
const PERMISSION_REJECT = 'reject';

/** Told to the model on denial so it stops retrying the built-in. */
const SANDBOX_DENIAL_FEEDBACK =
  'Sandbox mode: Copilot built-in tools are disabled. Use the gezel MCP tools instead.';

/**
 * Permission handler used when sandbox mode is on. Denies every
 * Copilot-SDK permission kind except `mcp` (our MCP tools) and
 * `custom-tool` (host-registered custom tools — we don't use them
 * today but approving leaves room for future additions). All other
 * kinds (`shell`, `write`, `read`, `url`, any future builtin) are
 * denied, and we surface each denial via `onDenial` so the chat
 * layer can log it as a `copilot.builtin.denied` history event.
 */
export function buildSandboxPermissionHandler(
  onDenial?: (info: {
    kind: string;
    toolName?: string;
    fileName?: string;
    fullCommandText?: string;
  }) => void | Promise<void>,
): (request: Record<string, unknown>) => { kind: string; feedback?: string } {
  return (request) => {
    const kind = typeof request?.kind === 'string' ? (request.kind as string) : 'unknown';
    if (kind === 'mcp' || kind === 'custom-tool') {
      return { kind: PERMISSION_APPROVE };
    }
    try {
      const toolName =
        typeof request?.toolName === 'string' ? (request.toolName as string) : undefined;
      const fileName =
        typeof request?.fileName === 'string' ? (request.fileName as string) : undefined;
      const fullCommandText =
        typeof request?.fullCommandText === 'string'
          ? (request.fullCommandText as string)
          : undefined;
      void onDenial?.({
        kind,
        ...(toolName ? { toolName } : {}),
        ...(fileName ? { fileName } : {}),
        ...(fullCommandText ? { fullCommandText } : {}),
      });
    } catch (err) {
      log.warn('[copilot] sandbox denial callback threw:', err);
    }
    return { kind: PERMISSION_REJECT, feedback: SANDBOX_DENIAL_FEEDBACK };
  };
}

/**
 * Appended to the system prompt in sandbox mode so the model knows the
 * built-ins are off-limits and reaches for MCP tools instead of wasting
 * a turn proposing something we'll deny.
 */
const SANDBOX_PROMPT_HINT =
  '\n\nSandbox mode is active: only tools exposed via MCP are available. ' +
  'The Copilot built-ins (bash, web_fetch, view, read_file, write_file, edit_file, ' +
  'str_replace_editor, grep) are disabled — attempting them will be denied. ' +
  'Use the gezel MCP tools (list_dir, read_file, write_file, search_files, fetch_url, etc.) instead.';

export function buildSandboxSystemMessage(base: string): string {
  return base + SANDBOX_PROMPT_HINT;
}

function stripExperimentalWarnings(message: string): string {
  const lines = message.split('\n').filter((line) => {
    const trimmed = line.trim();
    if (/^\(node:\d+\)\s+ExperimentalWarning:/.test(trimmed)) return false;
    if (/^\(Use `.*--trace-warnings.*`/.test(trimmed)) return false;
    return true;
  });
  const joined = lines.join('\n').trim();
  // If all we had left was `stderr:` with nothing after, drop the empty tail.
  return joined.replace(/\s*stderr:\s*$/i, '').trim();
}
