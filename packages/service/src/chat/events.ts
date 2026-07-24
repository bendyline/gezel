import { type ChatEvent, type ChatEventEnvelope, createLogger } from '@bendyline/gezel';

type SessionListener = (event: ChatEvent) => void;
type EnvelopeListener = (envelope: ChatEventEnvelope) => void;
const log = createLogger('chat-events');
const IDLE_SESSION_TTL_MS = 60 * 60_000;

export interface PublishScope {
  sessionId: string;
  gezelId: string;
  projectId: string;
}

/**
 * Per-session chat event bus, plus project-scoped and global fan-out for the
 * interleaved timeline UI. Each `publish` reaches three subscriber sets:
 *
 *   1. Listeners on this session — bare `ChatEvent`. Get the recent history
 *      replayed when they subscribe (so a late session-scoped subscriber can
 *      catch up on the in-flight message). Cleared on `done`.
 *   2. Listeners on this project — `ChatEventEnvelope` with sessionId/
 *      gezelId/projectId. Also get the history replayed for any in-flight
 *      sessions in this project, so a user who tabs away mid-stream and back
 *      doesn't lose the partial text + tools accumulated during the gap.
 *   3. Global listeners — `ChatEventEnvelope`. Same replay semantics across
 *      every in-flight session anywhere.
 *
 * History is bus-side only: cleared on `done` so completed turns don't get
 * re-delivered when a new subscriber connects after the fact.
 *
 * The early `fail()` path in `ChatManager.send` (when `ensureState` itself
 * fails before we have a record) doesn't know the gezelId/projectId, so it
 * publishes session-scoped only via `publishSessionOnly`. Project + global
 * subscribers don't see those failures — only the session's SSE listener
 * does, which is the only listener that cares about that scope.
 */
export class ChatEventBus {
  private readonly sessionBuses = new Map<
    string,
    {
      listeners: Set<SessionListener>;
      history: ChatEvent[];
      /**
       * Most recently published scope for this session — used to wrap
       * historical events as envelopes when a project / global
       * subscriber connects mid-stream. Set by `publish` (which always
       * carries a full scope); not touched by `publishSessionOnly`
       * because that path doesn't know the gezel/project.
       */
      lastScope?: PublishScope;
      lastActivityAt: number;
    }
  >();
  private readonly projectListeners = new Map<string, Set<EnvelopeListener>>();
  private readonly gezelListeners = new Map<string, Set<EnvelopeListener>>();
  private readonly globalListeners = new Set<EnvelopeListener>();

  publish(scope: PublishScope, event: ChatEvent): void {
    this.pruneIdleSessions();
    this.deliverToSession(scope.sessionId, event, scope);
    const envelope: ChatEventEnvelope = {
      sessionId: scope.sessionId,
      gezelId: scope.gezelId,
      projectId: scope.projectId,
      event,
    };
    const projectSet = this.projectListeners.get(scope.projectId);
    if (projectSet) {
      for (const listener of projectSet) this.safeDeliver(listener, envelope);
    }
    const gezelSet = this.gezelListeners.get(scope.gezelId);
    if (gezelSet) {
      for (const listener of gezelSet) this.safeDeliver(listener, envelope);
    }
    for (const listener of this.globalListeners) this.safeDeliver(listener, envelope);
  }

  /**
   * Publish to the session bus only. Used when the manager's early-fail path
   * doesn't know the gezel/project to envelope (the session record itself
   * couldn't be loaded). Project + global subscribers never see these.
   */
  publishSessionOnly(sessionId: string, event: ChatEvent): void {
    this.deliverToSession(sessionId, event);
  }

  /**
   * Publish a project-scoped lifecycle event that has no originating
   * turn — e.g. `project_created`. Fans out to the project's listeners
   * and all global listeners, but is deliberately NOT recorded in any
   * session history: these are one-shot signals, not part of a
   * replayable transcript, so a subscriber that reconnects later must
   * not see them re-fired (unlike `publish`, which seeds `deliverToSession`
   * history that replays until the turn's `done`). `sessionId`/`gezelId`
   * are empty — the consumers that care (the sidebar refresh bridge)
   * key off the event payload, not the envelope scope.
   */
  publishProjectEvent(projectId: string, event: ChatEvent): void {
    const envelope: ChatEventEnvelope = { sessionId: '', gezelId: '', projectId, event };
    const projectSet = this.projectListeners.get(projectId);
    if (projectSet) {
      for (const listener of projectSet) this.safeDeliver(listener, envelope);
    }
    for (const listener of this.globalListeners) this.safeDeliver(listener, envelope);
  }

  /**
   * Publish a project-less global lifecycle event — e.g. `night_shift`.
   * Reaches only the global listeners (the Meester timeline SSE the UI
   * subscribes to via `subscribeAll`); like `publishProjectEvent` it is
   * not recorded in any session history, so reconnecting subscribers do
   * not see it re-fired. The envelope scope fields are all empty;
   * consumers key off the event payload.
   */
  publishGlobalEvent(event: ChatEvent): void {
    const envelope: ChatEventEnvelope = { sessionId: '', gezelId: '', projectId: '', event };
    for (const listener of this.globalListeners) this.safeDeliver(listener, envelope);
  }

  subscribe(sessionId: string, listener: SessionListener): () => void {
    this.pruneIdleSessions();
    const entry = this.ensureSession(sessionId);
    for (const past of entry.history) this.safeDeliver(listener, past);
    entry.listeners.add(listener);
    return () => {
      entry.listeners.delete(listener);
      this.cleanupSession(sessionId, entry);
    };
  }

  subscribeProject(projectId: string, listener: EnvelopeListener): () => void {
    this.pruneIdleSessions();
    // Replay any in-flight session histories scoped to this project
    // BEFORE the live listener is registered. Without this, a user
    // who tabs away from the project chat mid-turn and back loses
    // every delta + tool the gap covered — the bubble re-creates as
    // thinking-dots and only catches up from the next live event.
    // History is cleared on `done`, so completed turns don't get
    // re-delivered.
    for (const [sessionId, entry] of this.sessionBuses) {
      if (entry.lastScope?.projectId !== projectId) continue;
      if (entry.history.length === 0) continue;
      const scope = entry.lastScope;
      for (const event of entry.history) {
        this.safeDeliver(listener, {
          sessionId,
          gezelId: scope.gezelId,
          projectId: scope.projectId,
          event,
        });
      }
    }
    let set = this.projectListeners.get(projectId);
    if (!set) {
      set = new Set();
      this.projectListeners.set(projectId, set);
    }
    set.add(listener);
    return () => {
      set!.delete(listener);
      if (set!.size === 0) this.projectListeners.delete(projectId);
    };
  }

  subscribeGezel(gezelId: string, listener: EnvelopeListener): () => void {
    this.pruneIdleSessions();
    // Mirrors `subscribeProject`'s replay: any in-flight session for this
    // gezel gets its accumulated deltas re-delivered before the live
    // listener is registered. Without this, switching the per-gezel chat
    // tab mid-stream loses the bubble's partial text.
    for (const [sessionId, entry] of this.sessionBuses) {
      if (entry.lastScope?.gezelId !== gezelId) continue;
      if (entry.history.length === 0) continue;
      const scope = entry.lastScope;
      for (const event of entry.history) {
        this.safeDeliver(listener, {
          sessionId,
          gezelId: scope.gezelId,
          projectId: scope.projectId,
          event,
        });
      }
    }
    let set = this.gezelListeners.get(gezelId);
    if (!set) {
      set = new Set();
      this.gezelListeners.set(gezelId, set);
    }
    set.add(listener);
    return () => {
      set!.delete(listener);
      if (set!.size === 0) this.gezelListeners.delete(gezelId);
    };
  }

  subscribeAll(listener: EnvelopeListener): () => void {
    this.pruneIdleSessions();
    // Same replay rationale as `subscribeProject`, but spans every
    // session anywhere — used by the global Meester timeline.
    for (const [sessionId, entry] of this.sessionBuses) {
      if (!entry.lastScope) continue;
      if (entry.history.length === 0) continue;
      const scope = entry.lastScope;
      for (const event of entry.history) {
        this.safeDeliver(listener, {
          sessionId,
          gezelId: scope.gezelId,
          projectId: scope.projectId,
          event,
        });
      }
    }
    this.globalListeners.add(listener);
    return () => {
      this.globalListeners.delete(listener);
    };
  }

  private deliverToSession(sessionId: string, event: ChatEvent, scope?: PublishScope): void {
    const entry = this.ensureSession(sessionId);
    entry.lastActivityAt = Date.now();
    this.recordInHistory(entry.history, event);
    if (scope) entry.lastScope = scope;
    if (entry.history.length > 500) {
      entry.history.splice(0, entry.history.length - 500);
    }
    for (const listener of entry.listeners) this.safeDeliver(listener, event);
    if (event.type === 'done') {
      entry.history.length = 0;
      this.cleanupSession(sessionId, entry);
    }
  }

  /**
   * Append an event to a session's replay history, keeping the buffer
   * lossless for the content that matters. Two rules:
   *
   *   1. Transient status pulses (`heartbeat`, `wire_pulse`) are delivered
   *      live but never recorded — they carry no replayable content, and a
   *      reasoning-heavy local-model turn emits enough of them to evict
   *      real deltas out of the 500-event cap.
   *   2. Adjacent `delta` events coalesce into one entry. A five-minute
   *      thinking turn streams thousands of per-token deltas; stored
   *      individually they blow past the cap and the earliest thinking is
   *      silently dropped on replay. Merged, a text run costs one slot no
   *      matter how long it streamed. The stored entry is a fresh object —
   *      the original event was already handed to live listeners and must
   *      not be mutated.
   */
  private recordInHistory(history: ChatEvent[], event: ChatEvent): void {
    if (event.type === 'heartbeat' || event.type === 'wire_pulse') return;
    if (event.type === 'delta' || event.type === 'reasoning_delta') {
      const tail = history[history.length - 1];
      if (tail?.type === event.type) {
        history[history.length - 1] = { type: event.type, content: tail.content + event.content };
        return;
      }
    }
    history.push(event);
  }

  private ensureSession(sessionId: string) {
    let entry = this.sessionBuses.get(sessionId);
    if (!entry) {
      entry = { listeners: new Set(), history: [], lastActivityAt: Date.now() };
      this.sessionBuses.set(sessionId, entry);
    }
    return entry;
  }

  private cleanupSession(
    sessionId: string,
    entry: { listeners: Set<SessionListener>; history: ChatEvent[] },
  ): void {
    if (entry.listeners.size === 0 && entry.history.length === 0)
      this.sessionBuses.delete(sessionId);
  }

  private pruneIdleSessions(): void {
    const cutoff = Date.now() - IDLE_SESSION_TTL_MS;
    for (const [sessionId, entry] of this.sessionBuses) {
      if (entry.listeners.size === 0 && entry.lastActivityAt < cutoff) {
        this.sessionBuses.delete(sessionId);
      }
    }
  }

  private safeDeliver<T>(listener: (value: T) => void, value: T): void {
    try {
      const result = (listener as (input: T) => unknown)(value);
      if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
        void Promise.resolve(result).catch((err) =>
          log.warn(`chat event listener failed: ${String(err)}`),
        );
      }
    } catch (err) {
      log.warn(`chat event listener failed: ${String(err)}`);
    }
  }

  /** Lightweight observability hook used by tests and diagnostics. */
  activeSessionCount(): number {
    return this.sessionBuses.size;
  }
}
