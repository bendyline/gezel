import { indexedPathFromActivity } from './IndexingReceipt.js';

/**
 * How long a sweep's bubble outlives its last file. The indexer starts the
 * next file within moments, so its work lands in the same bubble instead of
 * a fresh one.
 */
export const INDEXING_SWEEP_LINGER_MS = 4_000;

/**
 * The daemon never lists one-shots as in flight, so the reconcile poll
 * leaves a sweep's bubble alone until it has heard nothing for this long —
 * the sign that its `done` was lost. One file's summary on a slow local
 * model can run silent for a minute or two.
 */
export const INDEXING_SWEEP_SILENCE_MS = 3 * 60_000;

/** Keeps the `one-shot:` prefix so every check for background activity still applies. */
export function indexingSweepKey(gezelId: string, projectId: string): string {
  return `one-shot:indexing:${gezelId}:${projectId}`;
}

/**
 * An index sweep runs one one-shot session per file, so a bubble per session
 * flashed up and vanished once per file. This folds a sweep's sessions into
 * one live slot per gezel and project, retired only after no file has been in
 * flight for {@link INDEXING_SWEEP_LINGER_MS}.
 */
export class IndexingLiveSweeps {
  private readonly keyBySession = new Map<string, string>();
  /** Sessions in flight per sweep; an empty set means the sweep is lingering. */
  private readonly sessionsByKey = new Map<string, Set<string>>();
  private readonly retireTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly retire: (key: string) => void,
    private readonly lingerMs = INDEXING_SWEEP_LINGER_MS,
  ) {}

  /**
   * The live-slot key for an event. A one-shot joins its sweep on the engine
   * phase that names the file it indexes, and its later events follow it.
   */
  liveKey(sessionId: string, gezelId: string, projectId: string, activity?: string): string {
    const joined = this.keyBySession.get(sessionId);
    if (joined) return joined;
    if (!sessionId.startsWith('one-shot:') || !indexedPathFromActivity(activity)) return sessionId;
    const key = indexingSweepKey(gezelId, projectId);
    this.keyBySession.set(sessionId, key);
    let sessions = this.sessionsByKey.get(key);
    if (!sessions) {
      sessions = new Set();
      this.sessionsByKey.set(key, sessions);
    }
    sessions.add(sessionId);
    this.cancelRetire(key);
    return key;
  }

  /** One file finished. The sweep lingers for the next once none is left in flight. */
  finish(sessionId: string): void {
    const key = this.keyBySession.get(sessionId);
    if (!key) return;
    this.keyBySession.delete(sessionId);
    const sessions = this.sessionsByKey.get(key);
    sessions?.delete(sessionId);
    if (sessions && sessions.size > 0) return;
    this.cancelRetire(key);
    this.retireTimers.set(
      key,
      setTimeout(() => {
        this.retireTimers.delete(key);
        this.sessionsByKey.delete(key);
        this.retire(key);
      }, this.lingerMs),
    );
  }

  /** Whether a live key is a sweep's shared slot rather than a chat turn. */
  isSweep(key: string): boolean {
    return this.sessionsByKey.has(key);
  }

  /** Drop a sweep whose slot was retired some other way. */
  forget(key: string): void {
    this.cancelRetire(key);
    for (const sessionId of this.sessionsByKey.get(key) ?? []) this.keyBySession.delete(sessionId);
    this.sessionsByKey.delete(key);
  }

  reset(): void {
    for (const timer of this.retireTimers.values()) clearTimeout(timer);
    this.retireTimers.clear();
    this.keyBySession.clear();
    this.sessionsByKey.clear();
  }

  private cancelRetire(key: string): void {
    const timer = this.retireTimers.get(key);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.retireTimers.delete(key);
  }
}
