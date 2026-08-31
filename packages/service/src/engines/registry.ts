import { type NativeEngineName, createLogger } from '@bendyline/gezel';
import { type EngineResolveEvent, resolveEngine } from './resolver.js';
import type { SignaturePolicy } from './signature.js';

/** Resolver entrypoint, injectable for tests. */
type ResolveImpl = typeof resolveEngine;

const log = createLogger('engine-registry');

/** How long a finished resolve (done OR error) lingers so a reconnecting
 *  client still sees the terminal state. Same rationale as the image-pull
 *  registry's TTL. */
const FINISHED_TTL_MS = 8_000;

export const KNOWN_ENGINES: readonly NativeEngineName[] = [
  'llama-server',
  'ds4-server',
  'sd-server',
  'whisper-server',
  'uv',
  'duckdb',
];

export function isKnownEngine(name: string): name is NativeEngineName {
  return (KNOWN_ENGINES as readonly string[]).includes(name);
}

/**
 * Snapshot of one in-flight (or recently-finished) engine resolve. Exposed
 * via `GET /api/engines/binaries` so a client that mounted after the
 * download started still renders an accurate progress bar.
 */
export interface EngineBinarySnapshot {
  key: string;
  engine: NativeEngineName;
  variant?: string;
  startedAt: string;
  bytesWritten: number;
  totalBytes: number;
  phase: 'downloading' | 'verifying';
  retrying?: { attempt: number; maxAttempts: number; delayMs: number; reason: string };
  finished: boolean;
  error?: string;
  binPath?: string;
}

type Listener = (event: EngineResolveEvent) => void;
interface Entry {
  snapshot: EngineBinarySnapshot;
  listeners: Set<Listener>;
}

/**
 * Owns the lifecycle of every in-flight engine-binary resolve, decoupled
 * from the HTTP request that triggered it — a direct port of
 * {@link import('../providers/image/pull-registry.js').ImageModelPullRegistry}
 * for native engines. The resolve runs in a detached background task;
 * HTTP requests (and the lazy on-device-chat hook) are just consumers that
 * subscribe to the live events + cached snapshot. Disconnect detaches the
 * consumer; the download keeps going. Cancel is the explicit `DELETE`.
 */
export class EngineBinaryRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly home: string;
  private readonly signaturePolicy: SignaturePolicy;
  private readonly fetchImpl?: typeof fetch;
  private readonly resolveImpl: ResolveImpl;

  constructor(opts: {
    home: string;
    signaturePolicy?: SignaturePolicy;
    fetchImpl?: typeof fetch;
    /** Test seam — defaults to the real {@link resolveEngine}. */
    resolveImpl?: ResolveImpl;
  }) {
    this.home = opts.home;
    this.signaturePolicy = opts.signaturePolicy ?? 'require';
    if (opts.fetchImpl) this.fetchImpl = opts.fetchImpl;
    this.resolveImpl = opts.resolveImpl ?? resolveEngine;
  }

  key(engine: NativeEngineName, variant?: string): string {
    return `${engine}:${variant ?? 'default'}`;
  }

  /**
   * Start (or attach to) a resolve for `engine`[`@variant`]. Idempotent —
   * a second call while one is in flight returns the existing snapshot and
   * does not start a parallel download. Returns synchronously-claimed state
   * so the caller can immediately subscribe without racing the first event.
   */
  ensure(
    engine: NativeEngineName,
    variant?: string,
  ): { key: string; snapshot: EngineBinarySnapshot; alreadyRunning: boolean } {
    const key = this.key(engine, variant);
    const existing = this.entries.get(key);
    if (existing && !existing.snapshot.finished) {
      return { key, snapshot: { ...existing.snapshot }, alreadyRunning: true };
    }
    const snapshot: EngineBinarySnapshot = {
      key,
      engine,
      ...(variant ? { variant } : {}),
      startedAt: new Date().toISOString(),
      bytesWritten: 0,
      totalBytes: 0,
      phase: 'downloading',
      finished: false,
    };
    const entry: Entry = { snapshot, listeners: new Set() };
    this.entries.set(key, entry);
    const controller = new AbortController();
    this.controllers.set(key, controller);
    void this.consume(key, engine, variant, controller.signal);
    return { key, snapshot: { ...snapshot }, alreadyRunning: false };
  }

  list(): EngineBinarySnapshot[] {
    return Array.from(this.entries.values()).map((e) => ({ ...e.snapshot }));
  }

  get(key: string): EngineBinarySnapshot | null {
    const entry = this.entries.get(key);
    return entry ? { ...entry.snapshot } : null;
  }

  /** Subscribe to live events; replays the latest snapshot immediately so a
   *  late subscriber's progress bar isn't blank. Returns null if no entry. */
  subscribe(key: string, listener: Listener): (() => void) | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    entry.listeners.add(listener);
    this.replaySnapshot(entry.snapshot, listener);
    return () => {
      entry.listeners.delete(listener);
    };
  }

  /** Cancel an in-flight resolve (leaves the `.partial` for resume). */
  cancel(key: string): boolean {
    const controller = this.controllers.get(key);
    const entry = this.entries.get(key);
    if (!controller || !entry || entry.snapshot.finished) return false;
    controller.abort();
    return true;
  }

  /** Test-only: abort + drop everything. */
  clear(): void {
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
    this.entries.clear();
  }

  private replaySnapshot(snapshot: EngineBinarySnapshot, listener: Listener): void {
    listener({
      type: 'progress',
      bytesWritten: snapshot.bytesWritten,
      totalBytes: snapshot.totalBytes,
    });
    if (snapshot.retrying) listener({ type: 'retrying', ...snapshot.retrying });
    if (snapshot.error) listener({ type: 'error', error: snapshot.error });
    else if (snapshot.finished && snapshot.binPath) {
      listener({ type: 'done', binPath: snapshot.binPath, cached: false });
    }
  }

  private async consume(
    key: string,
    engine: NativeEngineName,
    variant: string | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry) return;
    try {
      const gen = this.resolveImpl({
        engine,
        home: this.home,
        signaturePolicy: this.signaturePolicy,
        signal,
        ...(variant ? { variant } : {}),
        ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
      });
      for await (const event of gen) {
        this.applyEvent(entry, event);
        this.broadcast(entry, event);
        // Break on terminal: this calls gen.return(), which converts the
        // resolver's pending post-error throw into a clean return (no
        // unhandled rejection, no double error event).
        if (event.type === 'done' || event.type === 'error') break;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const errorEvent: EngineResolveEvent = { type: 'error', error: message };
      this.applyEvent(entry, errorEvent);
      this.broadcast(entry, errorEvent);
      log.warn(`[engine-registry] ${key} crashed: ${message}`);
    } finally {
      entry.snapshot.finished = true;
      this.controllers.delete(key);
      const timer = setTimeout(() => {
        if (this.entries.get(key) === entry) this.entries.delete(key);
      }, FINISHED_TTL_MS);
      timer.unref?.();
    }
  }

  private applyEvent(entry: Entry, event: EngineResolveEvent): void {
    const s = entry.snapshot;
    if (event.type === 'progress') {
      s.bytesWritten = event.bytesWritten;
      s.totalBytes = event.totalBytes;
      s.phase = 'downloading';
      delete s.retrying;
    } else if (event.type === 'retrying') {
      s.retrying = {
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
        delayMs: event.delayMs,
        reason: event.reason,
      };
    } else if (event.type === 'verifying') {
      s.phase = 'verifying';
      delete s.retrying;
    } else if (event.type === 'done') {
      s.binPath = event.binPath;
      delete s.retrying;
    } else if (event.type === 'error') {
      s.error = event.error;
      delete s.retrying;
    }
  }

  private broadcast(entry: Entry, event: EngineResolveEvent): void {
    for (const listener of entry.listeners) {
      try {
        listener(event);
      } catch (err) {
        log.warn(`[engine-registry] listener threw: ${err instanceof Error ? err.message : err}`);
      }
    }
  }
}
