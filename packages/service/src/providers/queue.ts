/**
 * ProviderQueue
 *
 * A per-LLM-provider concurrency gate with priority lanes, session
 * affinity, and cancellation. Every `LLMSession.sendAndWait()` call
 * acquires a slot before the HTTP fetch fires; the slot is released
 * on completion, error, or abort.
 *
 * ## Why the queue exists
 *
 * Without this, if 50 gezels send at once, our service makes 50
 * simultaneous HTTP POSTs. Ollama serializes internally, so the
 * 49th request's 60s idle watchdog fires long before it gets any
 * bytes — the user sees "stalled" errors that aren't stalls. Cloud
 * providers can absorb the parallelism but eat rate limits and tie
 * up Electron's 6-per-origin SSE budget.
 *
 * With this, the per-turn timeout + idle timer only start *after*
 * the slot is acquired. A queued turn never fails from waiting.
 *
 * ## Priority + affinity
 *
 * Two lanes (`interactive`, `background`) — interactive always
 * drains before background inside the same provider. Within a lane,
 * the scheduler prefers items that share `sessionId` (exact cache
 * prefix) > same `gezelId` (same system prompt) > FIFO by enqueue
 * time. Affinity is soft: old items eventually dispatch regardless
 * of newer affine arrivals (starvation guard).
 *
 * The intent is to keep the local-model KV cache warm for batched
 * work — running `read → write → read` for the same session back-
 * to-back is much cheaper than interleaving unrelated sessions.
 *
 * ## Cancellation
 *
 * Each entry holds the caller's AbortSignal. If aborted while still
 * queued, the entry is removed before it ever reaches the provider
 * — no wasted work. Already-running entries abort normally via the
 * same signal.
 *
 * ## Ambient admission control (foreground-capacity protection)
 *
 * On a local engine, a housekeeping turn (scheduler nudge, memory
 * extraction, icon/about generation) occupies the GPU for minutes.
 * Slot reservation can't protect a `concurrency: 1` engine — once an
 * ambient turn starts, the user's next move queues behind it and the
 * gezel reads as dead (the wild-caught ds4 checkers incident: the
 * engine is idle while the user READS, ambient work sneaks in, and
 * the user's move then waits out a 3-minute nudge turn).
 *
 * When an engine has more than one interactive slot, ambient work may
 * use otherwise-idle capacity immediately, but only while at least one
 * physical slot stays free for a newly-arriving foreground chat. On a
 * single-slot engine — or once a multi-slot engine reaches that protected
 * headroom — entries marked `ambient: true` dispatch only when BOTH hold:
 * no non-ambient work is running or pending, and no non-ambient activity
 * (enqueue, dispatch, or release, any lane) happened within the last
 * `ambientQuietMs`. Reading time counts as engagement: page reactions and
 * tool-loop turns are non-ambient, so an active game holds the gate closed
 * between moves when there is no safe spare capacity. Ambient entries are
 * exempt from the anti-starvation guard while gated. The gate never touches
 * non-ambient work, so mid-turn compaction (which a foreground turn awaits)
 * and user-facing background turns are unaffected.
 */

export type Lane = 'interactive' | 'background';

export interface EnqueueRequest {
  lane: Lane;
  /**
   * Marks truly-deferrable housekeeping (scheduler nudges, memory
   * extraction, icon/about generation, digests, night-shift chores).
   * When the queue was built with {@link ProviderQueueOptions.ambientQuietMs},
   * ambient entries use safe spare capacity immediately, or otherwise
   * wait for a quiet window with no NON-ambient activity — see "Ambient
   * admission control" in the class header. Distinct from `lane:
   * 'background'`: background
   * covers anything that shouldn't cut in front of a typed chat turn,
   * which includes user-facing work (checkers page reactions, mid-turn
   * compaction a foreground turn awaits) that must NEVER be held.
   * Only mark work the user would not miss for many minutes.
   */
  ambient?: boolean;
  sessionId?: string;
  gezelId?: string;
  /**
   * Project that owns this work. Display-only; it does not affect
   * scheduling or prompt-cache affinity.
   */
  projectId?: string;
  /**
   * Human-readable owner for work that is not performed by a persisted
   * gezel (for example the built-in Boekwachter indexing service).
   * Display-only; unlike `gezelId`, this does not affect affinity.
   */
  actorLabel?: string;
  signal?: AbortSignal;
  /**
   * Opt this acquire out of affinity scoring. The `sessionId` /
   * `gezelId` still flow through for snapshot/UI display, but the
   * scheduler treats this entry as if it had no id match — so it
   * competes FIFO with everything else in its lane. Used for
   * continuation re-acquires where we don't want the nudge to
   * jump ahead of other sessions that queued up during the first
   * turn.
   */
  affinity?: boolean;
  /**
   * Short, human-readable label for what this turn is doing — e.g.
   * "atari/3 · plan" for a task handoff, "summary" / "icon · Maya"
   * for a klerk one-shot. Surfaced verbatim in the QueueMeter so
   * the user can see *why* a gezel is busy, not just *that* they
   * are. No semantic meaning to the scheduler.
   */
  job?: string;
}

export interface QueueSnapshot {
  running: number;
  queuedInteractive: number;
  queuedBackground: number;
}

interface PendingEntry {
  id: number;
  lane: Lane;
  /** See {@link EnqueueRequest.ambient}. */
  ambient?: boolean;
  sessionId?: string;
  gezelId?: string;
  /** See {@link EnqueueRequest.projectId}. */
  projectId?: string;
  /** See {@link EnqueueRequest.actorLabel}. */
  actorLabel?: string;
  enqueuedAt: number;
  resolve: (release: () => void) => void;
  reject: (err: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  /** Per-request opt-out from affinity scoring. See `EnqueueRequest.affinity`. */
  affinity?: boolean;
  /** See {@link EnqueueRequest.job}. */
  job?: string;
}

interface RecentRun {
  sessionId?: string;
  gezelId?: string;
  /** See {@link EnqueueRequest.projectId}. */
  projectId?: string;
  /** See {@link EnqueueRequest.actorLabel}. */
  actorLabel?: string;
  endedAt: number;
  /** Populated for currently-running contexts; 0 for historical `recent` entries. */
  startedAt?: number;
  /** See {@link EnqueueRequest.job}. */
  job?: string;
  /** Lane the run came from. Set on currently-running contexts so the
   *  per-lane concurrency cap can decrement on release. Optional on
   *  historical `recent` entries — affinity scoring doesn't need it. */
  lane?: Lane;
  /** See {@link EnqueueRequest.ambient}. Set on running contexts so the
   *  ambient gate can tell "a real turn is running" from "our own
   *  ambient work is running". */
  ambient?: boolean;
}

export interface ProviderQueueOptions {
  /** Max in-flight at once. Must be ≥ 1. */
  concurrency: number;
  /**
   * Cap on how many of the `concurrency` slots interactive items can
   * occupy at once. The remaining slots are reserved for the background
   * lane.
   *
   * Defaults to `concurrency` (no cap — current behavior preserved).
   * Setting it lower than `concurrency` is the lever for "let the
   * foreground stay snappy at concurrency=1 while background memory
   * extraction / summarization runs in parallel": pass
   * `concurrency: 2, interactiveConcurrency: 1` and the queue will
   * never let a 2nd interactive turn jump in front of, or alongside,
   * a 1st — but a queued background turn will happily fill the 2nd
   * slot while the foreground turn streams.
   *
   * Background items still respect the total `concurrency` cap; this
   * option only constrains the interactive lane. Hard-clamped to ≥ 1
   * and ≤ `concurrency`.
   */
  interactiveConcurrency?: number;
  /**
   * Cap on how many of the `concurrency` slots the BACKGROUND lane can
   * occupy at once. The difference `concurrency - backgroundConcurrency`
   * is headroom *reserved* for interactive turns, so an arriving
   * interactive turn always finds a free slot without preempting a
   * running background generation.
   *
   * This is the dual of {@link interactiveConcurrency} and the lever for
   * the batched-inference "adaptive" interactive policy: with
   * `concurrency: N, interactiveConcurrency: N, backgroundConcurrency: N-1`
   * two genuinely-concurrent interactive turns can co-batch across all N
   * slots, while background / ask work fills at most N-1 — always leaving
   * one slot for a live turn.
   *
   * Defaults to `concurrency` (no reservation — current behavior). Hard-
   * clamped to [1, concurrency].
   */
  backgroundConcurrency?: number;
  /**
   * Enable session/gezel affinity in dispatch order. When false, the
   * queue is strict FIFO within each lane. Defaults to true — see
   * class header for rationale.
   */
  affinity?: boolean;
  /**
   * How long a just-finished run stays "recent" for affinity
   * matching, in ms. Longer = more cache reuse, at the cost of
   * sometimes letting a newer affine item jump an older unrelated
   * one that's been waiting. Default 30s.
   */
  affinityWindowMs?: number;
  /**
   * Max time a pending item can be skipped by affinity before it
   * becomes eligible in strict FIFO order, in ms. Prevents
   * indefinite starvation when a same-session stream of new
   * requests keeps arriving. Default 60s.
   */
  maxWaitMs?: number;
  /**
   * Quiet window for ambient admission control — see the class header.
   * On a multi-slot engine, entries marked `ambient: true` may dispatch
   * sooner while one physical foreground slot remains protected. Once
   * that headroom is reached, they wait for this many ms with no
   * non-ambient activity (and none running or pending). 0 or unset
   * disables the gate (ambient entries behave like plain background).
   * Local single-GPU engines pass
   * {@link defaultAmbientQuietMs}; cloud queues leave it off.
   */
  ambientQuietMs?: number;
  /** Injectable clock for tests. Default `Date.now`. */
  now?: () => number;
}

/**
 * Default ambient quiet window for local engine queues when protected
 * spare capacity is unavailable. 3 minutes covers "the user is reading
 * the reply /
 * thinking about their move" without deferring chores much beyond an
 * active session's natural end. Override with `GEZEL_AMBIENT_QUIET_MS`
 * (milliseconds; `0` disables ambient gating entirely).
 */
export function defaultAmbientQuietMs(): number {
  const raw = process.env.GEZEL_AMBIENT_QUIET_MS;
  if (raw !== undefined) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return 180_000;
}

/**
 * How many slots the background lane may hold on an engine that can
 * generate `engineWidth` sequences at once: all but one, so an arriving
 * chat never waits behind a full background cohort.
 *
 * Key this to the ENGINE's width, not the queue's. A local provider sets
 * `concurrency = interactiveConcurrency + 1`, where the `+1` is a
 * deadlock reserve — it exists so a mid-turn one-shot the foreground
 * turn is awaiting (compaction, memory extraction) can enter the queue
 * while the interactive lane is full. Deriving the background cap from
 * that difference yields exactly 1 for any batch width, which is right
 * at width 1 and wrong everywhere above it: the queue kept housekeeping
 * strictly serial while the engine sat with slots to spare, and the
 * one-shot drives kept dispatching `concurrency`-many jobs into it.
 *
 * Floors at 1 so a single-slot engine still admits the deadlock-breaking
 * chore. `ProviderQueue` clamps the result to its own `concurrency`.
 */
export function backgroundLaneCap(engineWidth: number): number {
  return Math.max(1, engineWidth - 1);
}

export class AbortedWhileQueuedError extends Error {
  constructor() {
    super('request aborted while queued');
    this.name = 'AbortedWhileQueuedError';
  }
}

export class ProviderQueue {
  readonly concurrency: number;
  readonly interactiveConcurrency: number;
  readonly backgroundConcurrency: number;
  private readonly affinity: boolean;
  private readonly affinityWindowMs: number;
  private readonly maxWaitMs: number;
  /** See {@link ProviderQueueOptions.ambientQuietMs}. 0 = gate off. */
  readonly ambientQuietMs: number;
  /**
   * Last time NON-ambient work touched this queue (enqueue, dispatch,
   * or release — any lane). Initialized to construction time so a
   * freshly-built provider (usually built because a user just acted)
   * holds ambient work for one quiet window rather than letting a
   * boot-time chore camp on the lane right before the first message.
   */
  private lastNonAmbientActivityAt: number;
  /** Pending re-drain scheduled for when the quiet window elapses. */
  private ambientRecheckTimer: ReturnType<typeof setTimeout> | null = null;
  /** Count of currently-running interactive items. Decremented on release. */
  private runningInteractive = 0;
  /** Count of currently-running background items. Decremented on release. */
  private runningBackground = 0;
  private readonly now: () => number;

  private running = 0;
  private readonly pending: PendingEntry[] = [];
  /** Bounded list of recently-completed runs used for affinity tiebreaks. */
  private readonly recent: RecentRun[] = [];
  /** Session/gezel ids of currently running items (matters more than `recent`). */
  private readonly runningContexts = new Map<number, RecentRun>();
  private nextId = 1;

  constructor(opts: ProviderQueueOptions) {
    if (opts.concurrency < 1) {
      throw new Error(`ProviderQueue concurrency must be ≥ 1 (got ${opts.concurrency})`);
    }
    this.concurrency = opts.concurrency;
    // Default to the total concurrency — no cap, current behavior. Clamp
    // anything beyond [1, concurrency] so a misconfigured value can't
    // accidentally block all interactive dispatch.
    const requestedCap = opts.interactiveConcurrency ?? opts.concurrency;
    this.interactiveConcurrency = Math.min(opts.concurrency, Math.max(1, requestedCap));
    // Dual of the interactive cap: reserve `concurrency - backgroundConcurrency`
    // slots for interactive turns. Default to no reservation (= concurrency).
    const requestedBgCap = opts.backgroundConcurrency ?? opts.concurrency;
    this.backgroundConcurrency = Math.min(opts.concurrency, Math.max(1, requestedBgCap));
    this.affinity = opts.affinity ?? true;
    this.affinityWindowMs = opts.affinityWindowMs ?? 30_000;
    this.maxWaitMs = opts.maxWaitMs ?? 60_000;
    this.ambientQuietMs = Math.max(0, opts.ambientQuietMs ?? 0);
    this.now = opts.now ?? Date.now;
    this.lastNonAmbientActivityAt = this.now();
  }

  /**
   * Acquire a slot. Resolves to a `release` function the caller MUST
   * invoke exactly once (in a `finally`) to free the slot. If the
   * caller aborts while queued, the promise rejects with
   * {@link AbortedWhileQueuedError} and nothing needs to be released.
   */
  async acquire(req: EnqueueRequest): Promise<() => void> {
    if (req.signal?.aborted) throw new AbortedWhileQueuedError();

    // Non-ambient arrivals refresh the ambient-gate quiet clock: the
    // user (or a flow the user is waiting on) just touched this engine.
    if (!req.ambient) this.lastNonAmbientActivityAt = this.now();

    return new Promise<() => void>((resolve, reject) => {
      const entry: PendingEntry = {
        id: this.nextId++,
        lane: req.lane,
        enqueuedAt: this.now(),
        resolve,
        reject,
        ...(req.ambient ? { ambient: true } : {}),
        ...(req.sessionId !== undefined ? { sessionId: req.sessionId } : {}),
        ...(req.gezelId !== undefined ? { gezelId: req.gezelId } : {}),
        ...(req.projectId !== undefined ? { projectId: req.projectId } : {}),
        ...(req.actorLabel !== undefined ? { actorLabel: req.actorLabel } : {}),
        ...(req.signal !== undefined ? { signal: req.signal } : {}),
        ...(req.affinity === false ? { affinity: false } : {}),
        ...(req.job !== undefined ? { job: req.job } : {}),
      };
      if (req.signal) {
        entry.onAbort = () => this.removePending(entry);
        req.signal.addEventListener('abort', entry.onAbort, { once: true });
      }
      this.pending.push(entry);
      this.drain();
    });
  }

  snapshot(): QueueSnapshot {
    let queuedInteractive = 0;
    let queuedBackground = 0;
    for (const p of this.pending) {
      if (p.lane === 'interactive') queuedInteractive++;
      else queuedBackground++;
    }
    return { running: this.running, queuedInteractive, queuedBackground };
  }

  /**
   * Whether a caller may reserve another slot in `lane` right now.
   *
   * This is intentionally a synchronous hint rather than a second acquire
   * API. Producers such as TaskRunner use it to keep cancellable work in
   * their own durable/pending queue until both the provider's total cap and
   * its per-lane cap have room. `additionalReservations` covers several
   * fire-and-forget dispatches made in one tick before their async
   * `sendAndWait()` calls have reached {@link acquire}.
   */
  hasCapacity(lane: Lane, additionalReservations = 0): boolean {
    const reserved = Math.max(0, additionalReservations);
    if (this.running + reserved >= this.concurrency) return false;
    const runningInLane = lane === 'interactive' ? this.runningInteractive : this.runningBackground;
    const laneCap =
      lane === 'interactive' ? this.interactiveConcurrency : this.backgroundConcurrency;
    return runningInLane + reserved < laneCap;
  }

  /**
   * Richer snapshot for debugging + UI surfacing. Same summary fields
   * as `snapshot()` plus a list of each currently running item and
   * each pending item, with their session/gezel ids and wait/run
   * durations. Cheap — walks both lists once each.
   */
  describe(): {
    running: number;
    /**
     * In-flight slots split by lane. `running` alone cannot answer "how
     * many conversations are live right now?" — a queue holding nothing
     * but index-enrichment one-shots still reports `running: 1`, which
     * the pill used to render as "1 running" beside a chat-shaped noun.
     */
    runningInteractive: number;
    runningBackground: number;
    queuedInteractive: number;
    queuedBackground: number;
    /** Pending ambient entries currently held by the admission gate. */
    ambientHeld: number;
    concurrency: number;
    interactiveConcurrency: number;
    backgroundConcurrency: number;
    active: Array<{
      sessionId?: string;
      gezelId?: string;
      projectId?: string;
      actorLabel?: string;
      job?: string;
      runningForMs: number;
    }>;
    pending: Array<{
      id: number;
      lane: Lane;
      ambient?: boolean;
      sessionId?: string;
      gezelId?: string;
      projectId?: string;
      actorLabel?: string;
      job?: string;
      waitedMs: number;
    }>;
  } {
    const snap = this.snapshot();
    const now = this.now();
    const active = Array.from(this.runningContexts.values()).map((ctx) => ({
      ...(ctx.sessionId !== undefined ? { sessionId: ctx.sessionId } : {}),
      ...(ctx.gezelId !== undefined ? { gezelId: ctx.gezelId } : {}),
      ...(ctx.projectId !== undefined ? { projectId: ctx.projectId } : {}),
      ...(ctx.actorLabel !== undefined ? { actorLabel: ctx.actorLabel } : {}),
      ...(ctx.job !== undefined ? { job: ctx.job } : {}),
      runningForMs: Math.max(0, now - (ctx.startedAt ?? now)),
    }));
    const pending = this.pending.map((p) => ({
      id: p.id,
      lane: p.lane,
      ...(p.ambient ? { ambient: true } : {}),
      ...(p.sessionId !== undefined ? { sessionId: p.sessionId } : {}),
      ...(p.gezelId !== undefined ? { gezelId: p.gezelId } : {}),
      ...(p.projectId !== undefined ? { projectId: p.projectId } : {}),
      ...(p.actorLabel !== undefined ? { actorLabel: p.actorLabel } : {}),
      ...(p.job !== undefined ? { job: p.job } : {}),
      waitedMs: Math.max(0, now - p.enqueuedAt),
    }));
    const ambientHeld = this.ambientGateOpen(now)
      ? 0
      : this.pending.filter((p) => p.ambient).length;
    return {
      ...snap,
      runningInteractive: this.runningInteractive,
      runningBackground: this.runningBackground,
      ambientHeld,
      concurrency: this.concurrency,
      interactiveConcurrency: this.interactiveConcurrency,
      backgroundConcurrency: this.backgroundConcurrency,
      active,
      pending,
    };
  }

  /**
   * Cancel a pending entry by its queue-internal id. Rejects the
   * caller's `acquire()` promise with {@link AbortedWhileQueuedError}
   * — same path as an aborted signal — so existing call sites already
   * unwind cleanly. Returns true when the entry was found and removed,
   * false when the id was unknown (already running, already cancelled,
   * different queue).
   *
   * Surfaces the QueueMeter's per-item ✕ button: the user sees a
   * pending turn they didn't mean to queue and drops it before it
   * spends a slot.
   */
  cancelPending(id: number): boolean {
    const entry = this.pending.find((p) => p.id === id);
    if (!entry) return false;
    // removePending does the splice + reject; detachSignal both cleans
    // up the abort listener AND tries to splice (no-op the second time
    // around). Order matters — calling detachSignal first would splice
    // the entry, then removePending would short-circuit on indexOf=-1
    // and never reject the caller's promise.
    this.removePending(entry);
    if (entry.signal && entry.onAbort) {
      entry.signal.removeEventListener('abort', entry.onAbort);
    }
    return true;
  }

  /**
   * Reorder a pending entry by adjusting its `enqueuedAt` so it sorts
   * earlier (`'up'`) or later (`'down'`) than its neighbour in the
   * same lane. The queue's dispatcher is affinity-aware rather than
   * strict-FIFO, but `enqueuedAt` still drives starvation guards and
   * lane-internal tiebreaks, so this gives the user a meaningful
   * "bump higher / lower" lever without inventing a parallel manual-
   * priority field.
   *
   * Returns true when a swap happened, false when the entry was
   * already at the edge of its lane (or the id was unknown).
   */
  movePending(id: number, direction: 'up' | 'down'): boolean {
    const entry = this.pending.find((p) => p.id === id);
    if (!entry) return false;
    // Reorder only against same-lane neighbours so an interactive item
    // can't be "demoted" past a background item — the lane invariant
    // (interactive always drains first) wins regardless of timestamps.
    const sameLane = this.pending.filter((p) => p.lane === entry.lane);
    sameLane.sort((a, b) => a.enqueuedAt - b.enqueuedAt);
    const idx = sameLane.indexOf(entry);
    if (idx === -1) return false;
    const neighbourIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (neighbourIdx < 0 || neighbourIdx >= sameLane.length) return false;
    const neighbour = sameLane[neighbourIdx]!;
    // Tiny epsilon so the new ordering is unambiguous even if both
    // entries share the same millisecond timestamp.
    entry.enqueuedAt = direction === 'up' ? neighbour.enqueuedAt - 1 : neighbour.enqueuedAt + 1;
    return true;
  }

  private removePending(entry: PendingEntry): void {
    const i = this.pending.indexOf(entry);
    if (i === -1) return;
    this.pending.splice(i, 1);
    entry.reject(new AbortedWhileQueuedError());
    // Abort-while-queued doesn't free a slot, but it may unblock a
    // different item whose turn comes next — though in practice
    // removing a pending item can't itself open a slot, so no drain
    // needed.
  }

  private drain(): void {
    while (this.running < this.concurrency) {
      const next = this.pickNext();
      if (!next) break;
      this.detachSignal(next);
      this.running++;
      if (next.lane === 'interactive') this.runningInteractive++;
      else this.runningBackground++;
      // A non-ambient dispatch refreshes the quiet clock — a long turn
      // that started recently means the user is still mid-flow.
      if (!next.ambient) this.lastNonAmbientActivityAt = this.now();
      const ctx: RecentRun = { endedAt: 0, startedAt: this.now(), lane: next.lane };
      if (next.ambient) ctx.ambient = true;
      if (next.sessionId !== undefined) ctx.sessionId = next.sessionId;
      if (next.gezelId !== undefined) ctx.gezelId = next.gezelId;
      if (next.projectId !== undefined) ctx.projectId = next.projectId;
      if (next.actorLabel !== undefined) ctx.actorLabel = next.actorLabel;
      if (next.job !== undefined) ctx.job = next.job;
      this.runningContexts.set(next.id, ctx);
      const released = { done: false };
      const release = () => {
        if (released.done) return;
        released.done = true;
        this.running--;
        const rc = this.runningContexts.get(next.id);
        this.runningContexts.delete(next.id);
        if (rc?.lane === 'interactive') this.runningInteractive--;
        else if (rc?.lane === 'background') this.runningBackground--;
        if (rc) {
          rc.endedAt = this.now();
          this.recent.push(rc);
          this.pruneRecent();
          // The quiet window measures from the END of the user's last
          // engagement — release is when reading time starts.
          if (!rc.ambient) this.lastNonAmbientActivityAt = rc.endedAt;
        }
        this.drain();
      };
      next.resolve(release);
    }
    this.maybeScheduleAmbientRecheck();
  }

  /**
   * When ambient entries are held purely by the quiet-window CLOCK
   * (no non-ambient work running or pending — those re-drain on
   * release/arrival anyway), nothing would ever wake the queue again.
   * Schedule one re-drain for the moment the window elapses.
   */
  private maybeScheduleAmbientRecheck(): void {
    if (this.ambientQuietMs <= 0 || this.ambientRecheckTimer) return;
    if (!this.pending.some((p) => p.ambient)) return;
    for (const ctx of this.runningContexts.values()) if (!ctx.ambient) return;
    if (this.pending.some((p) => !p.ambient)) return;
    const remaining = this.ambientQuietMs - (this.now() - this.lastNonAmbientActivityAt);
    if (remaining <= 0) return;
    const timer = setTimeout(() => {
      this.ambientRecheckTimer = null;
      this.drain();
    }, remaining + 25);
    timer.unref?.();
    this.ambientRecheckTimer = timer;
  }

  /**
   * True when ambient entries may dispatch.
   *
   * A multi-slot engine may spend spare capacity immediately while keeping
   * one of its physical interactive slots unused. `running` is deliberately
   * compared with `interactiveConcurrency - 1`, rather than with the queue's
   * total `concurrency`: local queues carry one extra logical background lane
   * for deadlock-breaking one-shots, but that lane is not another native KV
   * slot. Once protected headroom is exhausted, the ordinary quiet-window
   * rule applies.
   */
  private ambientGateOpen(now: number): boolean {
    if (this.ambientQuietMs <= 0) return true;
    const protectedAmbientCeiling = this.interactiveConcurrency - 1;
    if (protectedAmbientCeiling > 0 && this.running < protectedAmbientCeiling) return true;
    for (const ctx of this.runningContexts.values()) if (!ctx.ambient) return false;
    for (const p of this.pending) if (!p.ambient) return false;
    return now - this.lastNonAmbientActivityAt >= this.ambientQuietMs;
  }

  /**
   * Choose the next pending entry to dispatch. Rules in order:
   *   1. Interactive lane always wins over background — UNLESS the
   *      `interactiveConcurrency` cap is already reached, in which case
   *      interactive entries are filtered out and the dispatcher falls
   *      back to background entries.
   *   2. Any pending item waiting past `maxWaitMs` becomes eligible
   *      strictly by enqueue time (anti-starvation). The interactive
   *      cap still applies to the starved lookup; an interactive
   *      starver has to wait for a slot to free up.
   *   3. Within the chosen lane, score by affinity: same sessionId
   *      as any currently-running-or-recent item beats same gezelId
   *      beats unrelated. Ties broken by enqueue time.
   */
  private pickNext(): PendingEntry | null {
    if (this.pending.length === 0) return null;

    const interactiveAtCap = this.runningInteractive >= this.interactiveConcurrency;
    const backgroundAtCap = this.runningBackground >= this.backgroundConcurrency;

    // Starvation guard: if any item has been waiting too long, pick
    // the oldest such item directly. Lane is respected, AND if a lane's
    // cap is reached we skip starved entries from that lane — they'll be
    // picked up the moment a slot frees, since the cap change schedules
    // another drain pass. (A background starver still can't consume a
    // slot reserved for interactive — the reservation outranks anti-
    // starvation, which is the whole point of holding the slot back.)
    const now = this.now();
    // Gated ambient entries are invisible to dispatch, INCLUDING the
    // anti-starvation guard — indefinitely deferring housekeeping while
    // the user is active is the ambient contract (see class header).
    const ambientOpen = this.ambientGateOpen(now);
    const starved = this.pending
      .filter((p) => now - p.enqueuedAt >= this.maxWaitMs)
      .filter((p) => !(interactiveAtCap && p.lane === 'interactive'))
      .filter((p) => !(backgroundAtCap && p.lane === 'background'))
      .filter((p) => !(p.ambient && !ambientOpen))
      .sort((a, b) => laneRank(a.lane) - laneRank(b.lane) || a.enqueuedAt - b.enqueuedAt)[0];
    if (starved) return starved;

    // Lane preference: exhaust interactive before background, but only
    // when interactive isn't at its per-lane cap. When the cap is hit,
    // background fills the remaining slots — that's the whole point of
    // splitting `interactiveConcurrency` from `concurrency`.
    const interactiveCandidates = interactiveAtCap
      ? []
      : this.pending.filter((p) => p.lane === 'interactive');
    const backgroundCandidates = backgroundAtCap
      ? []
      : this.pending.filter((p) => p.lane === 'background' && (ambientOpen || !p.ambient));
    const pool = interactiveCandidates.length > 0 ? interactiveCandidates : backgroundCandidates;
    if (pool.length === 0) return null;

    if (!this.affinity) {
      // Strict FIFO within the chosen lane.
      return pool.slice().sort((a, b) => a.enqueuedAt - b.enqueuedAt)[0] ?? null;
    }

    const affineContexts: RecentRun[] = [
      ...Array.from(this.runningContexts.values()),
      ...this.recent.filter((r) => now - r.endedAt <= this.affinityWindowMs),
    ];

    let best: PendingEntry | null = null;
    let bestScore = -1;
    for (const entry of pool) {
      const score = affinityScore(entry, affineContexts);
      if (
        score > bestScore ||
        (score === bestScore && best !== null && entry.enqueuedAt < best.enqueuedAt)
      ) {
        best = entry;
        bestScore = score;
      }
    }
    return best;
  }

  private pruneRecent(): void {
    const cutoff = this.now() - this.affinityWindowMs;
    while (this.recent.length > 0) {
      const head = this.recent[0]!;
      if (head.endedAt >= cutoff) break;
      this.recent.shift();
    }
    // Hard cap in case affinityWindowMs is very long — keep memory bounded.
    while (this.recent.length > 64) this.recent.shift();
  }

  private detachSignal(entry: PendingEntry): void {
    if (entry.signal && entry.onAbort) {
      entry.signal.removeEventListener('abort', entry.onAbort);
    }
    // Splice out of pending — drain() only called pickNext() which
    // returned a reference still sitting in the array.
    const i = this.pending.indexOf(entry);
    if (i !== -1) this.pending.splice(i, 1);
  }
}

function laneRank(l: Lane): number {
  return l === 'interactive' ? 0 : 1;
}

export interface QueueWaitOpts {
  lane: Lane;
  /** See {@link EnqueueRequest.ambient}. */
  ambient?: boolean;
  sessionId?: string;
  gezelId?: string;
  /** See {@link EnqueueRequest.projectId}. */
  projectId?: string;
  /** See {@link EnqueueRequest.actorLabel}. */
  actorLabel?: string;
  signal?: AbortSignal;
  /** See {@link EnqueueRequest.affinity}. */
  affinity?: boolean;
  /** See {@link EnqueueRequest.job}. */
  job?: string;
  /**
   * Fired once if the request ends up waiting longer than ~200ms.
   * `aheadOf` is an approximate count of turns that will dispatch
   * before this one. Under the threshold we stay silent — no need
   * to flash "queued" on the happy path where the queue is empty.
   */
  onQueueWait?: (info: { aheadOf: number }) => void;
}

/**
 * Common acquire-run-release pattern. The caller provides the queue
 * (optional; no-op if undefined), the queueing opts, and the work
 * function. The work function's clock starts only after the slot is
 * acquired, which is exactly what the provider-side timeouts want.
 *
 * Why the 200ms `onQueueWait` threshold: most acquires resolve on
 * the next microtask (no contention). Firing "queued" in that case
 * would flash the UI indicator for one frame and read as a glitch.
 * A 200ms wait is perceptible enough that surfacing it as a state
 * helps the user understand why nothing's happening yet.
 */
export async function runInQueue<T>(
  queue: ProviderQueue | undefined,
  opts: QueueWaitOpts | undefined,
  work: () => Promise<T>,
): Promise<T> {
  if (!queue || !opts) return work();

  let acquired = false;
  let waitNoticeTimer: ReturnType<typeof setTimeout> | null = null;

  if (opts.onQueueWait) {
    waitNoticeTimer = setTimeout(() => {
      if (acquired) return;
      const snap = queue.snapshot();
      const rawAhead =
        opts.lane === 'interactive'
          ? snap.running + snap.queuedInteractive - 1
          : snap.running + snap.queuedInteractive + snap.queuedBackground - 1;
      opts.onQueueWait?.({ aheadOf: Math.max(0, rawAhead) });
    }, 200);
  }

  const acquireOpts: EnqueueRequest = { lane: opts.lane };
  if (opts.ambient) acquireOpts.ambient = true;
  if (opts.sessionId !== undefined) acquireOpts.sessionId = opts.sessionId;
  if (opts.gezelId !== undefined) acquireOpts.gezelId = opts.gezelId;
  if (opts.projectId !== undefined) acquireOpts.projectId = opts.projectId;
  if (opts.actorLabel !== undefined) acquireOpts.actorLabel = opts.actorLabel;
  if (opts.signal !== undefined) acquireOpts.signal = opts.signal;
  if (opts.affinity === false) acquireOpts.affinity = false;
  if (opts.job !== undefined) acquireOpts.job = opts.job;

  let release: () => void;
  try {
    release = await queue.acquire(acquireOpts);
  } finally {
    acquired = true;
    if (waitNoticeTimer) clearTimeout(waitNoticeTimer);
  }
  try {
    return await work();
  } finally {
    release();
  }
}

/**
 * Affinity score:
 *   2 — same sessionId as a currently-running or recently-run item
 *   1 — same gezelId (different session)
 *   0 — unrelated
 *
 * A matched sessionId trumps a matched gezelId because the prompt
 * prefix match is tighter (full conversation prefix vs. just the
 * system prompt).
 */
function affinityScore(entry: PendingEntry, ctxs: RecentRun[]): number {
  // Explicit per-entry opt-out — used for continuation re-acquires
  // that want to compete FIFO rather than ride the prompt-cache
  // bonus back to the same slot.
  if (entry.affinity === false) return 0;
  if (ctxs.length === 0) return 0;
  let score = 0;
  for (const c of ctxs) {
    if (entry.sessionId && c.sessionId && entry.sessionId === c.sessionId) return 2;
    if (entry.gezelId && c.gezelId && entry.gezelId === c.gezelId) score = Math.max(score, 1);
  }
  return score;
}
