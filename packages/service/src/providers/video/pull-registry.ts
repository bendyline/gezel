import { createLogger } from '@bendyline/gezel';
import type { CatalogService } from '@bendyline/gezel-catalog';
import type { VideoProviderManager } from './manager.js';
import type { VideoModelPullEvent } from './types.js';

const log = createLogger('video-pulls');

/**
 * Snapshot of one in-flight (or recently-finished) video-model pull.
 * Exposed via `GET /api/video-gen/pulls`. Multi-file shaped (video
 * models are HF repos of many files): `bytesWritten`/`totalBytes` track
 * the cumulative batch, with `file`/`fileIndex`/`fileCount` for the
 * current file. Mirrors `ImageModelPullRegistry`'s decoupling of pull
 * lifecycle from the HTTP request, so a disconnect doesn't cancel.
 */
export interface ActiveVideoPull {
  id: string;
  startedAt: string;
  bytesWritten: number;
  totalBytes: number;
  file?: string;
  fileIndex?: number;
  fileCount?: number;
  retrying?: { attempt: number; maxAttempts: number; delayMs: number; reason: string };
  finished: boolean;
  error?: string;
}

type Listener = (event: VideoModelPullEvent) => void;

interface Entry {
  snapshot: ActiveVideoPull;
  listeners: Set<Listener>;
}

const FINISHED_TTL_MS = 8_000;

export class VideoModelPullRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly videoProvider: VideoProviderManager;
  private readonly catalog: CatalogService;

  constructor(opts: { videoProvider: VideoProviderManager; catalog: CatalogService }) {
    this.videoProvider = opts.videoProvider;
    this.catalog = opts.catalog;
  }

  /**
   * Start a pull for `id`. Idempotent — a pull already in flight returns
   * the existing snapshot. Throws `UnknownVideoModelError` for an unknown
   * catalog id so the route can 404. The pull runs in a detached task.
   */
  async start(id: string): Promise<{ snapshot: ActiveVideoPull; alreadyRunning: boolean }> {
    const existing = this.entries.get(id);
    if (existing && !existing.snapshot.finished) {
      return { snapshot: { ...existing.snapshot }, alreadyRunning: true };
    }

    const item = await this.catalog.get('video-model', id);
    if (!item || item.manifest.kind !== 'video-model') {
      throw new UnknownVideoModelError(id);
    }
    const manifest = item.manifest;

    const snapshot: ActiveVideoPull = {
      id,
      startedAt: new Date().toISOString(),
      bytesWritten: 0,
      totalBytes: manifest.source.approxSizeBytes,
      finished: false,
    };
    const entry: Entry = { snapshot, listeners: new Set() };
    this.entries.set(id, entry);

    const controller = new AbortController();
    this.controllers.set(id, controller);
    void this.consume(id, controller.signal);

    return { snapshot: { ...snapshot }, alreadyRunning: false };
  }

  list(): ActiveVideoPull[] {
    return Array.from(this.entries.values()).map((e) => ({ ...e.snapshot }));
  }

  get(id: string): ActiveVideoPull | null {
    const entry = this.entries.get(id);
    return entry ? { ...entry.snapshot } : null;
  }

  subscribe(id: string, listener: Listener): (() => void) | null {
    const entry = this.entries.get(id);
    if (!entry) return null;
    entry.listeners.add(listener);
    this.replaySnapshot(entry.snapshot, listener);
    return () => {
      entry.listeners.delete(listener);
    };
  }

  cancel(id: string): boolean {
    const controller = this.controllers.get(id);
    const entry = this.entries.get(id);
    if (!controller || !entry || entry.snapshot.finished) return false;
    controller.abort();
    return true;
  }

  /** Test-only: drop everything. */
  clear(): void {
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
    this.entries.clear();
  }

  private replaySnapshot(snapshot: ActiveVideoPull, listener: Listener): void {
    listener({
      type: 'progress',
      fileIndex: snapshot.fileIndex ?? 0,
      fileCount: snapshot.fileCount ?? 1,
      file: snapshot.file ?? '',
      bytesWritten: snapshot.bytesWritten,
      totalBytes: snapshot.totalBytes,
      bytesWrittenAll: snapshot.bytesWritten,
      totalBytesAll: snapshot.totalBytes,
    });
    if (snapshot.retrying) {
      listener({ type: 'retrying', file: snapshot.file ?? '', ...snapshot.retrying });
    }
    if (snapshot.error) listener({ type: 'error', error: snapshot.error });
    if (snapshot.finished && !snapshot.error) listener({ type: 'done', id: snapshot.id });
  }

  private async consume(id: string, signal: AbortSignal): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return;
    try {
      const provider = await this.videoProvider.current();
      for await (const event of provider.pullModel(id, signal)) {
        this.applyEvent(entry, event);
        this.broadcast(entry, event);
        if (event.type === 'done' || event.type === 'error') break;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const errorEvent: VideoModelPullEvent = { type: 'error', error: message };
      this.applyEvent(entry, errorEvent);
      this.broadcast(entry, errorEvent);
      log.warn(`[pull-registry] ${id} crashed: ${message}`);
    } finally {
      entry.snapshot.finished = true;
      this.controllers.delete(id);
      const timer = setTimeout(() => {
        if (this.entries.get(id) === entry) this.entries.delete(id);
      }, FINISHED_TTL_MS);
      timer.unref?.();
    }
  }

  private applyEvent(entry: Entry, event: VideoModelPullEvent): void {
    const s = entry.snapshot;
    if (event.type === 'progress') {
      s.bytesWritten = event.bytesWrittenAll;
      if (event.totalBytesAll > 0) s.totalBytes = event.totalBytesAll;
      s.file = event.file;
      s.fileIndex = event.fileIndex;
      s.fileCount = event.fileCount;
      delete s.retrying;
    } else if (event.type === 'retrying') {
      s.file = event.file;
      s.retrying = {
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
        delayMs: event.delayMs,
        reason: event.reason,
      };
    } else if (event.type === 'error') {
      s.error = event.error;
      delete s.retrying;
    } else if (event.type === 'done' || event.type === 'verifying') {
      delete s.retrying;
    }
  }

  private broadcast(entry: Entry, event: VideoModelPullEvent): void {
    for (const listener of entry.listeners) {
      try {
        listener(event);
      } catch (err) {
        log.warn(`[pull-registry] listener threw: ${err instanceof Error ? err.message : err}`);
      }
    }
  }
}

export class UnknownVideoModelError extends Error {
  constructor(public readonly id: string) {
    super(`unknown video-model: ${id}`);
    this.name = 'UnknownVideoModelError';
  }
}
