import type { SystemToolsetInstallEvent, SystemToolsetInstallSnapshot } from '@bendyline/gezel';
import { createLogger, resolveDistributionProfile } from '@bendyline/gezel';
import { installSystemToolsetStreaming } from './bootstrap.js';
import type { PinnedSystemToolset } from './manifest.js';
import { readSystemTracking, writeSystemTracking } from './tracking.js';

const log = createLogger('system-toolset-install');

/**
 * This build cannot install the requested toolset — a property of how the
 * build was distributed, not of the request or the network.
 *
 * Typed so the HTTP route answers 403 with the reason rather than the 500 an
 * anonymous throw would produce: nothing about it is retryable, and the user
 * needs to read the sentence to know what to do instead.
 */
export class SystemToolsetInstallUnavailableError extends Error {
  readonly code = 'unavailable_in_build';
}

/**
 * How long a finished install (done OR error) lingers so a client that
 * reconnects right after the terminal event still sees it. Same rationale
 * as {@link import('../engines/registry.js').EngineBinaryRegistry}'s TTL.
 */
const FINISHED_TTL_MS = 8_000;

/**
 * Cap on the retained pnpm output. The snapshot is replayed in full to every
 * new subscriber, and pnpm is chatty enough that an uncapped buffer would
 * make each reconnect progressively more expensive.
 */
const MAX_LOG_CHUNKS = 200;

/** Install entrypoint, injectable for tests. */
type InstallImpl = typeof installSystemToolsetStreaming;

type Listener = (event: SystemToolsetInstallEvent) => void;

interface Entry {
  snapshot: SystemToolsetInstallSnapshot;
  listeners: Set<Listener>;
}

/**
 * Owns the lifecycle of every user-triggered on-demand system-toolset
 * install, decoupled from the HTTP request that started it.
 *
 * Structurally a sibling of `EngineBinaryRegistry` rather than a
 * generalization of it: that one is keyed to `NativeEngineName` with an
 * engine-shaped snapshot, and folding both into one generic registry costs
 * more in type parameters and injected reducers than the duplication saves.
 *
 * Three properties are load-bearing for the Settings UX, and each is why a
 * bare module-level promise wouldn't do:
 *
 *   - **Attach to in-flight.** The user closes Settings mid-install and
 *     reopens it; {@link ensure} returns the running job rather than starting
 *     a second download of the same tarball.
 *   - **Snapshot replay.** A late subscriber gets the current phase, byte
 *     count, and buffered log immediately, so the progress bar is never
 *     blank while waiting for the next event.
 *   - **Terminal TTL.** An SSE client that reconnects just after `done`
 *     still learns the install succeeded instead of seeing nothing.
 *
 * Deliberately does NOT publish to the boot `SystemStatusBus`: that bus is
 * install-health for the eager toolsets, and an on-demand install pushing
 * `installing-toolsets` onto it would flip the Home health pill out of
 * "Runtime ready" and race the boot pass.
 */
export class SystemToolsetInstallRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly home: string;
  private readonly installImpl: InstallImpl;

  constructor(opts: {
    home: string;
    /** Test seam — defaults to the real {@link installSystemToolsetStreaming}. */
    installImpl?: InstallImpl;
  }) {
    this.home = opts.home;
    this.installImpl = opts.installImpl ?? installSystemToolsetStreaming;
  }

  /**
   * Start (or attach to) an install of `entry`. Idempotent — a second call
   * while one is in flight returns the existing snapshot and does not start a
   * parallel install. Returns synchronously-claimed state so the caller can
   * subscribe without racing the first event.
   */
  ensure(entry: PinnedSystemToolset): {
    toolsetId: string;
    snapshot: SystemToolsetInstallSnapshot;
    alreadyRunning: boolean;
  } {
    const toolsetId = entry.toolsetId;
    // A store build may not fetch executable code. Refused here rather than
    // inside the installer so no partial tree is ever created, and with the
    // profile's own copy so the message names the actual constraint instead
    // of surfacing whatever the download would have failed with.
    const distribution = resolveDistributionProfile();
    if (!distribution.allowRuntimeCodeDownloads) {
      throw new SystemToolsetInstallUnavailableError(distribution.refusalReason('copilot-install'));
    }
    // `mcp-toolset` entries also need a Store record written after install or
    // ChatManager never spawns them. Nothing on-demand is one today; fail
    // loudly rather than installing something that silently does nothing.
    if (entry.kind !== 'library') {
      throw new Error(
        `on-demand install of ${toolsetId} is not supported: only 'library' entries can be installed on demand`,
      );
    }
    const existing = this.entries.get(toolsetId);
    if (existing && !existing.snapshot.finished) {
      return { toolsetId, snapshot: cloneSnapshot(existing.snapshot), alreadyRunning: true };
    }
    const snapshot: SystemToolsetInstallSnapshot = {
      toolsetId,
      version: entry.version,
      startedAt: new Date().toISOString(),
      phase: 'resolving',
      bytesWritten: 0,
      totalBytes: 0,
      log: [],
      finished: false,
    };
    const record: Entry = { snapshot, listeners: new Set() };
    this.entries.set(toolsetId, record);
    const controller = new AbortController();
    this.controllers.set(toolsetId, controller);
    void this.consume(toolsetId, entry, controller.signal);
    return { toolsetId, snapshot: cloneSnapshot(snapshot), alreadyRunning: false };
  }

  list(): SystemToolsetInstallSnapshot[] {
    return Array.from(this.entries.values()).map((e) => cloneSnapshot(e.snapshot));
  }

  get(toolsetId: string): SystemToolsetInstallSnapshot | null {
    const entry = this.entries.get(toolsetId);
    return entry ? cloneSnapshot(entry.snapshot) : null;
  }

  /**
   * Subscribe to live events, replaying the current snapshot first so a late
   * subscriber renders accurate state immediately. Returns null when there is
   * no entry for `toolsetId`.
   */
  subscribe(toolsetId: string, listener: Listener): (() => void) | null {
    const entry = this.entries.get(toolsetId);
    if (!entry) return null;
    entry.listeners.add(listener);
    this.replaySnapshot(entry.snapshot, listener);
    return () => {
      entry.listeners.delete(listener);
    };
  }

  /**
   * Cancel an in-flight install. The staging directory is removed by the
   * installer's own cleanup, so there is nothing partial left behind — unlike
   * an engine download, an npm tarball is small enough that resume isn't
   * worth the machinery.
   */
  cancel(toolsetId: string): boolean {
    const controller = this.controllers.get(toolsetId);
    const entry = this.entries.get(toolsetId);
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

  private replaySnapshot(snapshot: SystemToolsetInstallSnapshot, listener: Listener): void {
    // Guarded like `broadcast`: a listener that throws must not escape
    // `subscribe`, or one bad consumer takes down the HTTP handler that was
    // trying to attach to a perfectly healthy install.
    const emit = (event: SystemToolsetInstallEvent) => {
      try {
        listener(event);
      } catch (err) {
        log.warn(
          `[system-toolset-install] listener threw during replay: ${
            err instanceof Error ? err.message : err
          }`,
        );
      }
    };
    emit({ type: 'phase', phase: snapshot.phase });
    emit({
      type: 'progress',
      bytesWritten: snapshot.bytesWritten,
      totalBytes: snapshot.totalBytes,
    });
    for (const line of snapshot.log) emit({ type: 'log', line });
    if (snapshot.retrying) emit({ type: 'retrying', ...snapshot.retrying });
    if (snapshot.error) emit({ type: 'error', error: snapshot.error });
    else if (snapshot.finished && snapshot.installPath) {
      emit({ type: 'done', installPath: snapshot.installPath, version: snapshot.version });
    }
  }

  private async consume(
    toolsetId: string,
    entry: PinnedSystemToolset,
    signal: AbortSignal,
  ): Promise<void> {
    const record = this.entries.get(toolsetId);
    if (!record) return;
    try {
      // Read the tracking record up front: a successful upgrade reaps the
      // superseded version-named install dir, and after the write below the
      // previous version is no longer recoverable.
      const tracking = await readSystemTracking(this.home);
      const previousVersion = tracking.toolsets[toolsetId]?.version;

      const gen = this.installImpl(this.home, entry, {
        signal,
        ...(previousVersion ? { previousVersion } : {}),
        logger: {
          info: (m) => log.info(m),
          warn: (m) => log.warn(m),
          error: (m) => log.error(m),
        },
      });

      let installPath = '';
      while (true) {
        const step = await gen.next();
        if (step.done) {
          installPath = step.value.installPath;
          break;
        }
        this.applyEvent(record, step.value);
        this.broadcast(record, step.value);
      }

      // Record the install before announcing it. `resolveInstalledSystemLibrary`
      // reads this file, so a `done` that raced ahead of the write would tell
      // the UI Copilot is ready a beat before it resolves.
      const fresh = await readSystemTracking(this.home);
      fresh.toolsets[toolsetId] = {
        toolsetId,
        version: entry.version,
        integrity: entry.integrity,
        installedAt: new Date().toISOString(),
      };
      await writeSystemTracking(this.home, fresh);

      const done: SystemToolsetInstallEvent = {
        type: 'done',
        installPath,
        version: entry.version,
      };
      this.applyEvent(record, done);
      this.broadcast(record, done);
    } catch (err) {
      const message = signal.aborted
        ? 'install was cancelled'
        : err instanceof Error
          ? err.message
          : String(err);
      const errorEvent: SystemToolsetInstallEvent = { type: 'error', error: message };
      this.applyEvent(record, errorEvent);
      this.broadcast(record, errorEvent);
      log.warn(`[system-toolset-install] ${toolsetId} failed: ${message}`);
    } finally {
      record.snapshot.finished = true;
      this.controllers.delete(toolsetId);
      const timer = setTimeout(() => {
        if (this.entries.get(toolsetId) === record) this.entries.delete(toolsetId);
      }, FINISHED_TTL_MS);
      timer.unref?.();
    }
  }

  private applyEvent(entry: Entry, event: SystemToolsetInstallEvent): void {
    const s = entry.snapshot;
    if (event.type === 'phase') {
      s.phase = event.phase;
      delete s.retrying;
    } else if (event.type === 'progress') {
      s.bytesWritten = event.bytesWritten;
      s.totalBytes = event.totalBytes;
      delete s.retrying;
    } else if (event.type === 'retrying') {
      s.retrying = {
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
        delayMs: event.delayMs,
        reason: event.reason,
      };
    } else if (event.type === 'log') {
      s.log.push(event.line);
      if (s.log.length > MAX_LOG_CHUNKS) s.log.splice(0, s.log.length - MAX_LOG_CHUNKS);
    } else if (event.type === 'done') {
      s.installPath = event.installPath;
      delete s.retrying;
    } else if (event.type === 'error') {
      s.error = event.error;
      delete s.retrying;
    }
  }

  private broadcast(entry: Entry, event: SystemToolsetInstallEvent): void {
    for (const listener of entry.listeners) {
      try {
        listener(event);
      } catch (err) {
        log.warn(
          `[system-toolset-install] listener threw: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  }
}

function cloneSnapshot(s: SystemToolsetInstallSnapshot): SystemToolsetInstallSnapshot {
  return { ...s, log: [...s.log] };
}
