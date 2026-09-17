import { randomUUID } from 'node:crypto';
import {
  APP_TOOL_DEFAULT_TIMEOUT_MS,
  APP_TOOL_MAX_PENDING_CALLS,
  APP_TOOL_MAX_RELAYS_PER_APP,
  APP_TOOL_RELAY_GRACE_MS,
  APP_TOOL_RELAY_HEARTBEAT_MS,
  type AppToolCallResultRequest,
  type AppToolDefinition,
  type AppToolRelayCloseReason,
  type AppToolRelayEvent,
  type AppToolRelaySummary,
  type RegisterAppToolsRequest,
  appToolsToolsetId,
  createLogger,
} from '@bendyline/gezel';
import { TOOL_REGISTRY, canonicalToolName } from '@bendyline/gezel-mcp';

const log = createLogger('app-tools');

/**
 * One app's tools for one project, as a chat session sees them.
 *
 * Captured when a session builds its bridges, so a turn already in flight
 * keeps the surface it was told about. `invoke` re-checks liveness against the
 * registry, which is what keeps a captured binding from becoming a promise
 * nobody can keep.
 */
export interface AppToolBinding {
  relayId: string;
  appId: string;
  appName?: string;
  projectId: string;
  gezelIds?: ReadonlySet<string>;
  tools: readonly AppToolDefinition[];
}

/** Where relay events are written — an SSE response in production. */
export interface AppToolRelayStreamSink {
  write(event: AppToolRelayEvent): void | Promise<void>;
}

export type AppToolInvokeResult =
  | Extract<AppToolCallResultRequest, { ok: true }>
  | { ok: false; error: string };

export interface AppToolInvocation {
  tool: string;
  args: Record<string, unknown>;
  sessionId: string;
  gezelId: string;
  projectId: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export class AppToolRelayError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'AppToolRelayError';
  }
}

interface PendingCall {
  settle: (result: AppToolInvokeResult) => void;
  timer: NodeJS.Timeout;
  tool: string;
}

interface Relay {
  relayId: string;
  appId: string;
  appName?: string;
  label?: string;
  openedAt: string;
  sink?: AppToolRelayStreamSink;
  /** Set while the stream is detached and the grace window is running. */
  graceTimer?: NodeJS.Timeout;
  bindings: Map<string, AppToolBinding>;
  pending: Map<string, PendingCall>;
}

export interface AppToolRelayRegistryOptions {
  graceMs?: number;
  heartbeatMs?: number;
  maxRelaysPerApp?: number;
  maxPendingPerRelay?: number;
  now?: () => number;
  /** Called whenever a project's tool surface changed. */
  onChange?: (projectId: string) => void;
}

/**
 * Live registry of app-registered tools.
 *
 * Everything here is in-memory on purpose. A registration is a claim that the
 * app is standing by to answer calls, and that claim cannot survive a restart
 * of either side — a persisted one would advertise tools whose handler no
 * longer exists, which the model experiences as a tool that accepts the call
 * and then never returns.
 */
export class AppToolRelayRegistry {
  private readonly relays = new Map<string, Relay>();
  private readonly graceMs: number;
  private readonly heartbeatMs: number;
  private readonly maxRelaysPerApp: number;
  private readonly maxPendingPerRelay: number;
  private readonly now: () => number;
  private readonly onChange?: (projectId: string) => void;

  constructor(opts: AppToolRelayRegistryOptions = {}) {
    this.graceMs = opts.graceMs ?? APP_TOOL_RELAY_GRACE_MS;
    this.heartbeatMs = opts.heartbeatMs ?? APP_TOOL_RELAY_HEARTBEAT_MS;
    this.maxRelaysPerApp = opts.maxRelaysPerApp ?? APP_TOOL_MAX_RELAYS_PER_APP;
    this.maxPendingPerRelay = opts.maxPendingPerRelay ?? APP_TOOL_MAX_PENDING_CALLS;
    this.now = opts.now ?? Date.now;
    if (opts.onChange) this.onChange = opts.onChange;
  }

  get limits(): { graceMs: number; heartbeatMs: number; maxPendingCalls: number } {
    return {
      graceMs: this.graceMs,
      heartbeatMs: this.heartbeatMs,
      maxPendingCalls: this.maxPendingPerRelay,
    };
  }

  open(input: { appId: string; appName?: string; label?: string }): { relayId: string } {
    const mine = [...this.relays.values()].filter((relay) => relay.appId === input.appId);
    if (mine.length >= this.maxRelaysPerApp) {
      throw new AppToolRelayError(
        `app "${input.appId}" already has ${mine.length} open tool relays`,
        'too_many_relays',
      );
    }
    const relayId = randomUUID();
    this.relays.set(relayId, {
      relayId,
      appId: input.appId,
      ...(input.appName ? { appName: input.appName } : {}),
      ...(input.label ? { label: input.label } : {}),
      openedAt: new Date(this.now()).toISOString(),
      bindings: new Map(),
      pending: new Map(),
    });
    return { relayId };
  }

  /** The relay's owning app, for route-level ownership checks. */
  ownerOf(relayId: string): string | undefined {
    return this.relays.get(relayId)?.appId;
  }

  has(relayId: string): boolean {
    return this.relays.has(relayId);
  }

  /**
   * Attach an event stream. A second stream for the same relay supersedes the
   * first: a half-open socket that the OS has not yet torn down must never be
   * able to lock an app out of its own relay.
   */
  attachStream(relayId: string, sink: AppToolRelayStreamSink): { detach: () => void } {
    const relay = this.require(relayId);
    const previous = relay.sink;
    if (previous) void this.emitTo(previous, { type: 'closed', reason: 'superseded' });
    if (relay.graceTimer) {
      clearTimeout(relay.graceTimer);
      delete relay.graceTimer;
    }
    relay.sink = sink;
    void this.emitTo(sink, {
      type: 'ready',
      relayId,
      graceMs: this.graceMs,
      heartbeatMs: this.heartbeatMs,
    });
    let detached = false;
    return {
      detach: () => {
        if (detached) return;
        detached = true;
        // Only the current owner may start the grace window; a superseded
        // sink detaching later must not close the live stream's relay.
        if (this.relays.get(relayId) === relay && relay.sink === sink) this.detachStream(relayId);
      },
    };
  }

  detachStream(relayId: string): void {
    const relay = this.relays.get(relayId);
    if (!relay?.sink) return;
    delete relay.sink;
    this.failPending(relay, `app "${relay.appId}" disconnected`);
    // Hold the registration briefly: an app that reloads its window or drops a
    // socket should not have its tools vanish from a session mid-conversation.
    relay.graceTimer = setTimeout(() => {
      this.close(relayId, 'grace_expired');
    }, this.graceMs);
    relay.graceTimer.unref?.();
  }

  register(
    relayId: string,
    request: RegisterAppToolsRequest,
  ): { toolsetId: string; registered: string[] } {
    const relay = this.require(relayId);
    for (const tool of request.tools) {
      const canonical = canonicalToolName(tool.name);
      if (canonical in TOOL_REGISTRY) {
        throw new AppToolRelayError(
          `"${tool.name}" is a built-in Gezel tool and cannot be registered by an app`,
          'tool_name_reserved',
        );
      }
      const conflict = this.findConflict(request.projectId, tool.name, relay.appId);
      if (conflict) {
        throw new AppToolRelayError(
          `"${tool.name}" is already registered in this project by app "${conflict}"`,
          'tool_name_conflict',
        );
      }
    }
    const gezelIds = request.gezelIds?.length ? new Set(request.gezelIds) : undefined;
    relay.bindings.set(request.projectId, {
      relayId,
      appId: relay.appId,
      ...(relay.appName ? { appName: relay.appName } : {}),
      projectId: request.projectId,
      ...(gezelIds ? { gezelIds } : {}),
      tools: request.tools,
    });
    this.onChange?.(request.projectId);
    const registered = request.tools.map((tool) => tool.name);
    void this.emit(relay, {
      type: 'tools_replaced',
      projectId: request.projectId,
      tools: registered,
    });
    return { toolsetId: appToolsToolsetId(relay.appId), registered };
  }

  unregister(relayId: string, projectId?: string): void {
    const relay = this.require(relayId);
    const projects = projectId ? [projectId] : [...relay.bindings.keys()];
    for (const id of projects) {
      if (relay.bindings.delete(id)) this.onChange?.(id);
    }
  }

  close(relayId: string, reason: AppToolRelayCloseReason): void {
    const relay = this.relays.get(relayId);
    if (!relay) return;
    this.relays.delete(relayId);
    if (relay.graceTimer) clearTimeout(relay.graceTimer);
    this.failPending(relay, `app "${relay.appId}" is no longer connected`);
    if (relay.sink) void this.emitTo(relay.sink, { type: 'closed', reason });
    for (const projectId of relay.bindings.keys()) this.onChange?.(projectId);
  }

  closeAll(reason: AppToolRelayCloseReason = 'daemon_shutdown'): void {
    for (const relayId of [...this.relays.keys()]) this.close(relayId, reason);
  }

  /**
   * Bindings that apply to one session. A relay inside its grace window still
   * counts: the tools are about to come back, and dropping them would rebuild
   * the session's whole tool surface for a two-second socket blip.
   */
  listForSession(query: { projectId: string; gezelId: string }): AppToolBinding[] {
    const bindings: AppToolBinding[] = [];
    for (const relay of this.relays.values()) {
      const binding = relay.bindings.get(query.projectId);
      if (!binding) continue;
      if (binding.gezelIds && !binding.gezelIds.has(query.gezelId)) continue;
      bindings.push(binding);
    }
    return bindings.sort((a, b) => a.appId.localeCompare(b.appId));
  }

  /**
   * Stable identity of a project's app-tool surface. The chat manager stores
   * it on the live session and rebuilds when it moves, so tools registered
   * after a session opened appear on the next turn.
   */
  fingerprint(projectId: string): string {
    const parts: string[] = [];
    for (const relay of [...this.relays.values()].sort((a, b) =>
      a.relayId.localeCompare(b.relayId),
    )) {
      const binding = relay.bindings.get(projectId);
      if (!binding) continue;
      const gezels = binding.gezelIds ? [...binding.gezelIds].sort().join(',') : '*';
      const tools = binding.tools
        .map((tool) => `${tool.name}:${JSON.stringify(tool.inputSchema)}:${tool.description}`)
        .join('|');
      parts.push(`${relay.relayId}/${binding.appId}/${gezels}/${tools}`);
    }
    return parts.join(';');
  }

  listRelays(filter?: { appId?: string }): AppToolRelaySummary[] {
    const out: AppToolRelaySummary[] = [];
    for (const relay of this.relays.values()) {
      if (filter?.appId && relay.appId !== filter.appId) continue;
      out.push({
        relayId: relay.relayId,
        appId: relay.appId,
        ...(relay.appName ? { appName: relay.appName } : {}),
        ...(relay.label ? { label: relay.label } : {}),
        connected: relay.sink !== undefined,
        openedAt: relay.openedAt,
        bindings: [...relay.bindings.values()].map((binding) => ({
          projectId: binding.projectId,
          ...(binding.gezelIds ? { gezelIds: [...binding.gezelIds] } : {}),
          tools: binding.tools.map((tool) => tool.name),
        })),
        pendingCalls: relay.pending.size,
      });
    }
    return out;
  }

  /**
   * Run one tool in the app and wait for its answer.
   *
   * Never queues against a disconnected app: the model is blocked on this
   * call, so "the app is not connected" is a far better answer than a wait
   * that ends in a timeout with the same information.
   */
  async invoke(binding: AppToolBinding, call: AppToolInvocation): Promise<AppToolInvokeResult> {
    const relay = this.relays.get(binding.relayId);
    if (!relay) return { ok: false, error: `app "${binding.appId}" is no longer connected` };
    if (!relay.sink) return { ok: false, error: `app "${binding.appId}" is not connected` };
    if (relay.pending.size >= this.maxPendingPerRelay) {
      return {
        ok: false,
        error: `app "${binding.appId}" has too many tool calls in flight; try again`,
      };
    }
    const declared = binding.tools.find((tool) => tool.name === call.tool);
    const timeoutMs = call.timeoutMs ?? declared?.timeoutMs ?? APP_TOOL_DEFAULT_TIMEOUT_MS;
    const callId = randomUUID();

    return await new Promise<AppToolInvokeResult>((resolve) => {
      let settled = false;
      const finish = (result: AppToolInvokeResult): void => {
        if (settled) return;
        settled = true;
        const entry = relay.pending.get(callId);
        if (entry) {
          clearTimeout(entry.timer);
          relay.pending.delete(callId);
        }
        call.signal?.removeEventListener('abort', onAbort);
        resolve(result);
      };
      const onAbort = (): void => {
        finish({ ok: false, error: `the turn was cancelled while ${call.tool} was running` });
      };
      const timer = setTimeout(() => {
        finish({
          ok: false,
          error: `app "${binding.appId}" did not answer ${call.tool} within ${Math.round(
            timeoutMs / 1000,
          )}s`,
        });
      }, timeoutMs);
      timer.unref?.();
      relay.pending.set(callId, { settle: finish, timer, tool: call.tool });
      call.signal?.addEventListener('abort', onAbort, { once: true });

      void this.emit(relay, {
        type: 'tool_call',
        callId,
        tool: call.tool,
        arguments: call.args,
        sessionId: call.sessionId,
        gezelId: call.gezelId,
        projectId: call.projectId,
        timeoutMs,
        at: new Date(this.now()).toISOString(),
      }).catch((err: unknown) => {
        finish({
          ok: false,
          error: `could not reach app "${binding.appId}": ${
            err instanceof Error ? err.message : String(err)
          }`,
        });
      });
    });
  }

  /**
   * Deliver an app's answer. A late answer for a call that already timed out
   * reports `unknown` rather than being applied — the model has moved on, and
   * silently accepting it would leave the app believing it was used.
   */
  resolveCall(
    relayId: string,
    callId: string,
    result: AppToolCallResultRequest,
  ): 'resolved' | 'unknown' {
    const relay = this.relays.get(relayId);
    const pending = relay?.pending.get(callId);
    if (!relay || !pending) return 'unknown';
    pending.settle(result);
    return 'resolved';
  }

  private require(relayId: string): Relay {
    const relay = this.relays.get(relayId);
    if (!relay) throw new AppToolRelayError('tool relay not found', 'relay_not_found');
    return relay;
  }

  private findConflict(projectId: string, toolName: string, appId: string): string | undefined {
    for (const relay of this.relays.values()) {
      if (relay.appId === appId) continue;
      const binding = relay.bindings.get(projectId);
      if (binding?.tools.some((tool) => tool.name === toolName)) return relay.appId;
    }
    return undefined;
  }

  private failPending(relay: Relay, reason: string): void {
    for (const [, pending] of [...relay.pending]) {
      pending.settle({ ok: false, error: `${reason} (${pending.tool})` });
    }
    relay.pending.clear();
  }

  /**
   * Best-effort notification. A relay inside its grace window has no stream to
   * write to, and that is not an error: the app is between connections, and
   * its registration is deliberately still live. Only {@link invoke} needs a
   * connected app, and it checks for one itself before emitting.
   */
  private async emit(relay: Relay, event: AppToolRelayEvent): Promise<void> {
    if (!relay.sink) return;
    await this.emitTo(relay.sink, event);
  }

  private async emitTo(sink: AppToolRelayStreamSink, event: AppToolRelayEvent): Promise<void> {
    try {
      await sink.write(event);
    } catch (err) {
      log.debug(
        `[app-tools] relay stream write failed (${event.type}):`,
        err instanceof Error ? err.message : err,
      );
      throw err;
    }
  }
}
