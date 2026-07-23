import { type ImageModelPullEvent, createLogger } from '@bendyline/gezel';
import type { CatalogService } from '@bendyline/gezel-catalog';
import type { ImageProviderManager } from './manager.js';
import type { ImageModelPullSpec } from './types.js';

const log = createLogger('image-pulls');

/**
 * Snapshot of one in-flight (or recently-finished) image-model pull.
 * Exposed to the UI via `GET /api/image-gen/pulls` so a client that
 * mounted after the pull started can still render an accurate
 * progress bar without subscribing to the live SSE.
 */
export interface ActiveImagePull {
  id: string;
  startedAt: string;
  bytesWritten: number;
  /** Best-known total. Zero until the first `progress` event arrives. */
  totalBytes: number;
  /** Present when the shared downloader is between retry attempts. */
  retrying?: { attempt: number; maxAttempts: number; delayMs: number; reason: string };
  /** Set once a terminal event has been observed (done or error). */
  finished: boolean;
  /** Set when the pull errored — kept on the snapshot so reconnecting clients see the failure. */
  error?: string;
}

type Listener = (event: ImageModelPullEvent) => void;

interface Entry {
  snapshot: ActiveImagePull;
  listeners: Set<Listener>;
}

/**
 * How long a finished pull (done OR error) stays in the registry after
 * the terminal event. Long enough that a client polling once per second
 * sees the final state on reconnect; short enough that the catalog UI's
 * "Installed" row gets to take over.
 */
const FINISHED_TTL_MS = 8_000;

/**
 * Owns the lifecycle of every in-flight image-model pull.
 *
 * Pulls used to be tied 1:1 to the HTTP request that started them — when
 * the client disconnected (navigated away from Settings → Image
 * generation), the SSE loop exited, the async generator closed, and the
 * download was aborted by the .partial-leaves-resumable code path. A
 * returning client had no record the pull ever existed.
 *
 * The registry decouples those two: the pull runs in the background owned
 * by this object, and HTTP requests are just consumers that subscribe to
 * the live event stream + the cached snapshot. Disconnect detaches the
 * consumer; the pull keeps going. Cancel is now an explicit `DELETE
 * /pulls/:id` rather than a side-effect of closing the fetch.
 */
export class ImageModelPullRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly imageProvider: ImageProviderManager;
  private readonly catalog: CatalogService;

  constructor(opts: { imageProvider: ImageProviderManager; catalog: CatalogService }) {
    this.imageProvider = opts.imageProvider;
    this.catalog = opts.catalog;
  }

  /**
   * Start a pull for `id`. Idempotent — when a pull is already in flight
   * for this id, returns the existing snapshot and does not kick off a
   * second download. Throws if the catalog id is unknown.
   *
   * The pull itself runs in a detached `void` task; this method returns
   * synchronously-claimed state so callers can immediately subscribe
   * without racing the first event.
   */
  async start(id: string): Promise<{ snapshot: ActiveImagePull; alreadyRunning: boolean }> {
    const existing = this.entries.get(id);
    if (existing && !existing.snapshot.finished) {
      return { snapshot: { ...existing.snapshot }, alreadyRunning: true };
    }

    // Resolve the catalog entry up-front so we can fail fast with a
    // proper 404 rather than emitting a 200 + error SSE for "unknown id".
    const item = await this.catalog.get('image-model', id);
    if (!item || item.manifest.kind !== 'image-model') {
      throw new UnknownImageModelError(id);
    }
    const manifest = item.manifest;

    const snapshot: ActiveImagePull = {
      id,
      startedAt: new Date().toISOString(),
      bytesWritten: 0,
      totalBytes:
        manifest.approxSizeBytes +
        manifest.auxiliaryFiles.reduce((n, f) => n + f.approxSizeBytes, 0),
      finished: false,
    };
    const entry: Entry = { snapshot, listeners: new Set() };
    this.entries.set(id, entry);

    const controller = new AbortController();
    this.controllers.set(id, controller);

    const spec: ImageModelPullSpec = {
      downloadUrl: manifest.downloadUrl,
      sha256: manifest.sha256,
      approxSizeBytes: manifest.approxSizeBytes,
      name: manifest.name,
      weightsKind: manifest.weightsKind,
      auxiliaryFiles: manifest.auxiliaryFiles.map((aux) => ({
        role: aux.role,
        downloadUrl: aux.downloadUrl,
        sha256: aux.sha256,
        approxSizeBytes: aux.approxSizeBytes,
      })),
    };

    void this.consume(id, spec, controller.signal);

    return { snapshot: { ...snapshot }, alreadyRunning: false };
  }

  list(): ActiveImagePull[] {
    return Array.from(this.entries.values()).map((e) => ({ ...e.snapshot }));
  }

  get(id: string): ActiveImagePull | null {
    const entry = this.entries.get(id);
    return entry ? { ...entry.snapshot } : null;
  }

  /**
   * Subscribe to live events for an in-flight pull. On subscribe, the
   * registry immediately delivers a synthetic event reflecting the last
   * known snapshot — without it, a late subscriber to a paused (between
   * retry attempts) or just-started pull would see nothing until the
   * next real event, leaving the UI's progress bar blank.
   *
   * Returns `null` when no entry exists for `id` so the caller can
   * 404. Returns an unsubscribe function otherwise; calling it removes
   * the listener but does NOT cancel the pull — disconnect ≠ cancel.
   */
  subscribe(id: string, listener: Listener): (() => void) | null {
    const entry = this.entries.get(id);
    if (!entry) return null;
    entry.listeners.add(listener);
    // Replay the current state so the UI renders immediately.
    this.replaySnapshot(entry.snapshot, listener);
    return () => {
      entry.listeners.delete(listener);
    };
  }

  /**
   * Cancel an in-flight pull. The shared downloader observes the abort,
   * leaves the `.partial` in place for resume, and surfaces an `error`
   * event whose snapshot stays in the registry for `FINISHED_TTL_MS`.
   * Returns true when a live entry was aborted.
   */
  cancel(id: string): boolean {
    const controller = this.controllers.get(id);
    const entry = this.entries.get(id);
    if (!controller || !entry || entry.snapshot.finished) return false;
    controller.abort();
    return true;
  }

  /** Test-only: drop everything so a fresh test starts clean. */
  clear(): void {
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
    this.entries.clear();
  }

  private replaySnapshot(snapshot: ActiveImagePull, listener: Listener): void {
    // The order matters: deliver any in-progress retry banner LAST so it
    // overrides the bare progress bar in the UI's state machine.
    listener({
      type: 'progress',
      bytesWritten: snapshot.bytesWritten,
      ...(snapshot.totalBytes > 0 ? { totalBytes: snapshot.totalBytes } : {}),
    });
    if (snapshot.retrying) listener({ type: 'retrying', ...snapshot.retrying });
    if (snapshot.error) listener({ type: 'error', error: snapshot.error });
    if (snapshot.finished && !snapshot.error) listener({ type: 'done', id: snapshot.id });
  }

  private async consume(id: string, spec: ImageModelPullSpec, signal: AbortSignal): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return;
    try {
      const provider = await this.imageProvider.current();
      for await (const event of provider.pullModel(id, spec, signal)) {
        this.applyEvent(entry, event);
        this.broadcast(entry, event);
        if (event.type === 'done' || event.type === 'error') break;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const errorEvent: ImageModelPullEvent = { type: 'error', error: message };
      this.applyEvent(entry, errorEvent);
      this.broadcast(entry, errorEvent);
      log.warn(`[pull-registry] ${id} crashed: ${message}`);
    } finally {
      entry.snapshot.finished = true;
      // Drop the controller — cancel() should be a no-op once finished.
      this.controllers.delete(id);
      // Keep the snapshot around briefly so a client mid-reconnect still
      // sees the terminal state on `list()` / `subscribe()`. Then garbage
      // collect.
      const timer = setTimeout(() => {
        if (this.entries.get(id) === entry) this.entries.delete(id);
      }, FINISHED_TTL_MS);
      timer.unref?.();
    }
  }

  private applyEvent(entry: Entry, event: ImageModelPullEvent): void {
    const s = entry.snapshot;
    if (event.type === 'progress') {
      s.bytesWritten = event.bytesWritten;
      if (event.totalBytes !== undefined) s.totalBytes = event.totalBytes;
      delete s.retrying;
    } else if (event.type === 'retrying') {
      s.retrying = {
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
        delayMs: event.delayMs,
        reason: event.reason,
      };
    } else if (event.type === 'error') {
      s.error = event.error;
      delete s.retrying;
    } else if (event.type === 'done') {
      delete s.retrying;
    }
  }

  private broadcast(entry: Entry, event: ImageModelPullEvent): void {
    for (const listener of entry.listeners) {
      try {
        listener(event);
      } catch (err) {
        log.warn(`[pull-registry] listener threw: ${err instanceof Error ? err.message : err}`);
      }
    }
  }
}

export class UnknownImageModelError extends Error {
  constructor(public readonly id: string) {
    super(`unknown image-model: ${id}`);
    this.name = 'UnknownImageModelError';
  }
}
