import { createLogger } from '@bendyline/gezel';

const log = createLogger('models');

/**
 * Minimal event contract shared by every chat-model installer
 * (`LlamaCppModelManager.install`, `MlxModelManager.install`): a stream of
 * typed events where `done` / `error` are terminal. The registry treats
 * everything else as opaque progress it can replay to late subscribers.
 */
export interface ChatInstallEventBase {
  type: string;
  error?: string;
}

export interface ChatInstallSnapshot {
  id: string;
  startedAt: string;
  /** Set once a terminal event has been observed (done, error, or cancel). */
  finished: boolean;
  /** Set when the install errored or was cancelled. */
  error?: string;
}

type Listener<E> = (event: E) => void;

interface Entry<E> {
  snapshot: ChatInstallSnapshot;
  /** Most recent non-terminal event — replayed on subscribe so a late
   *  subscriber's progress bar renders immediately. */
  lastEvent: E | null;
  terminalEvent: E | null;
  listeners: Set<Listener<E>>;
  /** Live iterator, kept so `cancel()` can unwind the generator. */
  iterator: AsyncIterator<E> | null;
  cancelled: boolean;
}

/**
 * How long a finished install (done OR error) stays in the registry after
 * the terminal event — long enough for a reconnecting client to observe the
 * terminal state, short enough that the installed-models list takes over.
 */
const FINISHED_TTL_MS = 8_000;

/**
 * Owns the lifecycle of in-flight chat-model installs for one engine.
 *
 * Installs used to be tied 1:1 to the HTTP request that started them — when
 * the client disconnected (closed the window, navigated away mid-download),
 * the SSE loop exited, the async install generator closed, and the download
 * was abandoned with `.partial` files on disk and no record it ever ran.
 * This is the chat-model twin of the image path's `ImageModelPullRegistry`,
 * which fixed the identical failure mode for image pulls.
 *
 * The registry decouples the two: the install runs in a detached background
 * task owned by this object, and HTTP requests are just consumers that
 * subscribe to the live event fan-out. Disconnect detaches the consumer; the
 * install keeps going. Cancel is an explicit `DELETE /models/:id/install`.
 *
 * Cancellation unwinds the install generator via `iterator.return()` rather
 * than an AbortSignal — the generator only runs between yields, and the
 * downloaders yield progress a few times a second, so the unwind lands
 * within one progress interval and the `.partial` files stay resumable.
 */
export class ChatModelInstallRegistry<E extends ChatInstallEventBase, O> {
  private readonly entries = new Map<string, Entry<E>>();
  private readonly engine: string;
  private readonly run: (id: string, opts: O) => AsyncIterable<E>;
  private readonly onDone: ((id: string) => void) | undefined;

  constructor(opts: {
    /** Label used in log lines only. */
    engine: string;
    /** Start the actual install — typically `(id, o) => manager.install(id, o)`. */
    run: (id: string, opts: O) => AsyncIterable<E>;
    /** Fired when an install reaches `done`, before the event is broadcast —
     *  the place to bust caches so subscribers observing `done` re-fetch
     *  fresh state. */
    onDone?: (id: string) => void;
  }) {
    this.engine = opts.engine;
    this.run = opts.run;
    this.onDone = opts.onDone;
  }

  /**
   * Start an install for `id`, or attach to the one already in flight.
   * Idempotent — a second `start` for a running id does not launch a second
   * download and does not change the original's options. The install runs in
   * a detached `void` task; the entry is claimed synchronously so callers
   * can subscribe without racing the first event.
   */
  start(id: string, opts: O): { alreadyRunning: boolean } {
    const existing = this.entries.get(id);
    if (existing && !existing.snapshot.finished) {
      return { alreadyRunning: true };
    }
    const entry: Entry<E> = {
      snapshot: { id, startedAt: new Date().toISOString(), finished: false },
      lastEvent: null,
      terminalEvent: null,
      listeners: new Set(),
      iterator: null,
      cancelled: false,
    };
    this.entries.set(id, entry);
    void this.consume(id, entry, opts);
    return { alreadyRunning: false };
  }

  get(id: string): ChatInstallSnapshot | null {
    const entry = this.entries.get(id);
    return entry ? { ...entry.snapshot } : null;
  }

  /**
   * Subscribe to live events for an in-flight install. On subscribe, the
   * registry replays the last known progress event (and the terminal event,
   * when one has landed) so a late subscriber renders immediately. Returns
   * `null` when no entry exists for `id`; otherwise an unsubscribe function.
   * Unsubscribing does NOT cancel the install — disconnect ≠ cancel.
   */
  subscribe(id: string, listener: Listener<E>): (() => void) | null {
    const entry = this.entries.get(id);
    if (!entry) return null;
    entry.listeners.add(listener);
    if (entry.lastEvent) listener(entry.lastEvent);
    if (entry.terminalEvent) listener(entry.terminalEvent);
    return () => {
      entry.listeners.delete(listener);
    };
  }

  /**
   * Cancel an in-flight install. The generator unwinds at its next yield,
   * running the manager's cleanup (active-install deregistration) and
   * leaving `.partial` files in place for resume. Subscribers receive a
   * terminal `error` event stating the install was cancelled. Returns true
   * when a live entry was cancelled.
   */
  cancel(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry || entry.snapshot.finished || entry.cancelled) return false;
    entry.cancelled = true;
    void entry.iterator?.return?.(undefined as never);
    return true;
  }

  /** Shutdown/test hook: unwind every live install and drop all state. */
  clear(): void {
    for (const entry of this.entries.values()) {
      if (!entry.snapshot.finished) {
        entry.cancelled = true;
        void entry.iterator?.return?.(undefined as never);
      }
    }
    this.entries.clear();
  }

  private async consume(id: string, entry: Entry<E>, opts: O): Promise<void> {
    let iterator: AsyncIterator<E> | null = null;
    try {
      iterator = this.run(id, opts)[Symbol.asyncIterator]();
      entry.iterator = iterator;
      while (true) {
        const { value, done } = await iterator.next();
        if (done) break;
        const event = value;
        const terminal = event.type === 'done' || event.type === 'error';
        if (terminal) {
          entry.terminalEvent = event;
          if (event.type === 'error') {
            entry.snapshot.error = event.error ?? 'install failed';
            log.warn(`[${this.engine}] install "${id}" failed: ${entry.snapshot.error}`);
          } else {
            this.onDone?.(id);
          }
        } else {
          entry.lastEvent = event;
        }
        this.broadcast(entry, event);
        if (terminal) break;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`[${this.engine}] install "${id}" crashed: ${message}`);
      const errorEvent = { type: 'error', error: message } as E;
      entry.terminalEvent = errorEvent;
      entry.snapshot.error = message;
      this.broadcast(entry, errorEvent);
    } finally {
      entry.iterator = null;
      // Breaking on a terminal event leaves the generator suspended at its
      // final yield — unlike a `for await` loop, a manual next() loop does
      // not auto-return. Unwind it explicitly so the manager's own finally
      // (active-install deregistration) always runs.
      try {
        await iterator?.return?.(undefined as never);
      } catch {
        // The generator's unwind path failing must not mask the install result.
      }
      if (!entry.terminalEvent) {
        // The generator unwound without a terminal event — a cancel(), or
        // an installer bug. Either way subscribers must not hang waiting
        // for a `done` that will never come.
        const message = entry.cancelled ? 'install cancelled' : 'install ended unexpectedly';
        if (entry.cancelled) log.info(`[${this.engine}] install "${id}" cancelled`);
        else log.warn(`[${this.engine}] install "${id}" ended without a terminal event`);
        const errorEvent = { type: 'error', error: message } as E;
        entry.terminalEvent = errorEvent;
        entry.snapshot.error = message;
        this.broadcast(entry, errorEvent);
      }
      entry.snapshot.finished = true;
      const timer = setTimeout(() => {
        if (this.entries.get(id) === entry) this.entries.delete(id);
      }, FINISHED_TTL_MS);
      timer.unref?.();
    }
  }

  private broadcast(entry: Entry<E>, event: E): void {
    for (const listener of entry.listeners) {
      try {
        listener(event);
      } catch (err) {
        log.warn(
          `[${this.engine}] install listener threw: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  }
}
