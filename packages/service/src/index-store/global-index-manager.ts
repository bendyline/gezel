import {
  type ChatMessage,
  type ChatSession,
  type HistoryEvent,
  createLogger,
  nowIso,
} from '@bendyline/gezel';
import { beginPerfWork } from '@bendyline/gezel-inference/internal/perf/responsiveness';
import type { DocumentChangeEvent, SessionChangeEvent, Store } from '../fs/store.js';
import type { HistoryManager } from '../history/manager.js';
import { HISTORY_BACKFILL_META_KEY, openGlobalCollection } from './global-index.js';
import type { ChunkInput } from './index-store-types.js';
import type { IndexStore } from './index-store.js';
import { isTransientIndexError } from './sqlite-driver.js';

/**
 * Single writer for `~/.gezel/index/global.db`. Change hooks (Store session/
 * document listeners, HistoryManager subscription) enqueue synchronously into
 * in-memory dirty queues; a short debounce collapses a streaming turn's many
 * writeSession calls into one re-index, and each flush opens, writes, and
 * closes per collection so no long-lived handle contends with readers.
 * A busy database requeues the batch for a later debounce, keeping the API
 * thread responsive without losing session or history updates.
 *
 * The db is a rebuildable cache over plain-file sources of truth. Reconcile
 * (startup-delayed, then every few hours) compares watermarks against the
 * sources, so a wiped or corrupt db self-heals and changes made while the
 * service was down are picked up.
 */

const log = createLogger('global-index');

const DEBOUNCE_MS = 3_000;
/**
 * A changed session is re-indexed once its writes have gone quiet, or after
 * the longest wait if it never does. Every re-index rewrites all of the
 * session's chunks, and a streaming turn writes its session every few
 * seconds: at 40 concurrent task sessions those rewrites took 30% of the
 * daemon's main thread (2026-10-27).
 */
const SESSION_QUIET_MS = 15_000;
const SESSION_MAX_WAIT_MS = 120_000;
const STARTUP_DELAY_MS = 15_000;
const RECONCILE_INTERVAL_MS = 6 * 60 * 60_000;
const MAX_TRANSCRIPT_CHUNK_CHARS = 4_000;
/** Events per reconcile transaction; the API thread runs between batches. */
const HISTORY_RECONCILE_BATCH = 2_000;

export type { DocumentChangeEvent };

export interface GlobalIndexManagerOptions {
  store: Store;
  history: HistoryManager;
  debounceMs?: number;
  startupDelayMs?: number;
  reconcileIntervalMs?: number;
}

interface CollectionGates {
  sessions: boolean;
  history: boolean;
}

export class GlobalIndexManager {
  private readonly store: Store;
  private readonly history: HistoryManager;
  private readonly debounceMs: number;
  private readonly startupDelayMs: number;
  private readonly reconcileIntervalMs: number;

  private readonly dirtySessions = new Map<string, SessionChangeEvent>();
  /** When each dirty session first and last changed (ms), for the quiet period. */
  private readonly sessionChangedAt = new Map<string, { first: number; last: number }>();
  private pendingHistory: HistoryEvent[] = [];

  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushDueAt = 0;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;
  private flushQueued = false;
  private reconciling = false;
  private stopped = false;

  constructor(opts: GlobalIndexManagerOptions) {
    this.store = opts.store;
    this.history = opts.history;
    this.debounceMs = opts.debounceMs ?? DEBOUNCE_MS;
    this.startupDelayMs = opts.startupDelayMs ?? STARTUP_DELAY_MS;
    this.reconcileIntervalMs = opts.reconcileIntervalMs ?? RECONCILE_INTERVAL_MS;
  }

  start(): void {
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      void this.reconcile().catch((err) => log.warn(`startup reconcile failed: ${describe(err)}`));
    }, this.startupDelayMs);
    unref(this.startupTimer);
    this.reconcileTimer = setInterval(() => {
      void this.reconcile().catch((err) => log.warn(`reconcile failed: ${describe(err)}`));
    }, this.reconcileIntervalMs);
    unref(this.reconcileTimer);
  }

  stop(): void {
    this.stopped = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.startupTimer) clearTimeout(this.startupTimer);
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.flushTimer = null;
    this.startupTimer = null;
    this.reconcileTimer = null;
  }

  enqueueSession(ev: SessionChangeEvent): void {
    const key = `${ev.gezelId}/${ev.sessionId}`;
    this.dirtySessions.set(key, ev);
    const now = Date.now();
    this.sessionChangedAt.set(key, {
      first: this.sessionChangedAt.get(key)?.first ?? now,
      last: now,
    });
    this.scheduleFlush();
  }

  enqueueHistory(ev: HistoryEvent): void {
    this.pendingHistory.push(ev);
    this.scheduleFlush();
  }

  /**
   * Documents are no longer a global collection: the shared library is a
   * project, so its content is indexed by the per-project pipeline (ADR
   * 0006). The hook stays wired because Store still emits document change
   * events; there is simply nothing for this manager to do with them.
   */
  enqueueDocument(_ev: DocumentChangeEvent): void {}

  /**
   * Flush within `delayMs`. An earlier pending flush is kept: under a steady
   * stream of changes a pure trailing debounce would never fire.
   */
  private scheduleFlush(delayMs = this.debounceMs): void {
    if (this.stopped) return;
    const dueAt = Date.now() + delayMs;
    if (this.flushTimer) {
      if (this.flushDueAt <= dueAt) return;
      clearTimeout(this.flushTimer);
    }
    this.flushDueAt = dueAt;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush({ quietSessionsOnly: true }).catch((err) =>
        log.warn(`flush failed: ${describe(err)}`),
      );
    }, delayMs);
    unref(this.flushTimer);
  }

  /**
   * Drain the dirty queues. The debounce timer passes `quietSessionsOnly` and
   * leaves sessions still being written for a later flush; called directly
   * (tests, reconcile) it drains everything now.
   */
  async flush(opts: { quietSessionsOnly?: boolean } = {}): Promise<void> {
    if (this.flushing) {
      this.flushQueued = true;
      return;
    }
    this.flushing = true;
    const endPerfWork = beginPerfWork('global index flush');
    try {
      const gates = await this.gates();
      if (this.dirtySessions.size > 0) {
        const now = Date.now();
        const batch: SessionChangeEvent[] = [];
        for (const [key, ev] of this.dirtySessions) {
          const changed = this.sessionChangedAt.get(key);
          const due =
            !opts.quietSessionsOnly ||
            ev.type === 'delete' ||
            !changed ||
            now - changed.last >= SESSION_QUIET_MS ||
            now - changed.first >= SESSION_MAX_WAIT_MS;
          if (!due) continue;
          batch.push(ev);
          this.dirtySessions.delete(key);
          this.sessionChangedAt.delete(key);
        }
        if (gates.sessions && batch.length > 0) {
          try {
            await this.flushSessions(batch);
          } catch (error) {
            if (!isTransientIndexError(error)) throw error;
            for (const ev of batch) {
              const key = `${ev.gezelId}/${ev.sessionId}`;
              // A newer event received during the flush takes precedence.
              if (!this.dirtySessions.has(key)) this.dirtySessions.set(key, ev);
            }
            this.flushQueued = true;
          }
        }
      }
      if (this.pendingHistory.length > 0) {
        const batch = this.pendingHistory;
        this.pendingHistory = [];
        if (gates.history) {
          try {
            await this.flushHistory(batch);
          } catch (error) {
            if (!isTransientIndexError(error)) throw error;
            this.pendingHistory = [...batch, ...this.pendingHistory];
            this.flushQueued = true;
          }
        }
      }
    } finally {
      endPerfWork();
      this.flushing = false;
      if (this.flushQueued) {
        this.flushQueued = false;
        this.scheduleFlush();
      } else if (this.dirtySessions.size > 0) {
        this.scheduleFlush(this.nextSessionDueMs());
      }
    }
  }

  /** Milliseconds until the earliest waiting session becomes due. */
  private nextSessionDueMs(): number {
    const now = Date.now();
    let next = SESSION_MAX_WAIT_MS;
    for (const changed of this.sessionChangedAt.values()) {
      const due = Math.min(changed.last + SESSION_QUIET_MS, changed.first + SESSION_MAX_WAIT_MS);
      next = Math.min(next, Math.max(0, due - now));
    }
    return Math.max(next, this.debounceMs);
  }

  /** Exposed for tests: full drift check against the plain-file sources. */
  async reconcile(): Promise<void> {
    if (this.reconciling) return;
    this.reconciling = true;
    try {
      const gates = await this.gates();
      if (gates.sessions) {
        await this.reconcileSessions().catch((err) =>
          log.warn(`session reconcile failed: ${describe(err)}`),
        );
      }
      if (gates.history) {
        await this.reconcileHistory().catch((err) =>
          log.warn(`history reconcile failed: ${describe(err)}`),
        );
      }
      await this.purgeLegacyDocuments().catch((err) =>
        log.warn(`legacy documents purge failed: ${describe(err)}`),
      );
      await this.flush();
    } finally {
      this.reconciling = false;
    }
  }

  private async gates(): Promise<CollectionGates> {
    const cfg = await this.store.readConfig().catch(() => null);
    const si = cfg?.searchIndex;
    const master = si?.enabled !== false;
    return {
      sessions: master && si?.sessions !== false,
      history: master && si?.history !== false,
    };
  }

  // ── sessions ───────────────────────────────────────────────────────────

  private async flushSessions(batch: SessionChangeEvent[]): Promise<void> {
    const index = await openGlobalCollection(this.store.homePath, 'sessions', {
      throwOnBusy: true,
    });
    if (!index) return;
    try {
      for (const ev of batch) {
        const path = `${ev.gezelId}/${ev.sessionId}`;
        if (ev.type === 'delete') {
          index.deleteFile(path);
          continue;
        }
        const session = await this.store.getSession(ev.gezelId, ev.sessionId);
        if (!session) {
          index.deleteFile(path);
          continue;
        }
        this.indexSession(index, session);
      }
    } finally {
      index.close();
    }
  }

  private indexSession(index: IndexStore, session: ChatSession): void {
    const path = `${session.gezelId}/${session.id}`;
    const mtimeMs = Date.parse(session.lastActivityAt) || 0;
    const existing = index.getFile(path);
    const metadata = [
      { key: 'title', value: session.title },
      { key: 'gezelId', value: session.gezelId },
      { key: 'sessionId', value: session.id },
      { key: 'projectId', value: session.projectId },
      { key: 'lastActivityAt', value: session.lastActivityAt },
      { key: 'archived', value: session.archived ? '1' : '0' },
    ];
    if (existing && existing.loc === session.messages.length && existing.mtimeMs === mtimeMs) {
      // Transcript unchanged; still refresh metadata (title edits, archive
      // toggles) since it's cheap and not covered by the watermark.
      index.setMetadata(path, metadata);
      return;
    }
    index.putChunks(path, null, chunkTranscript(session.messages));
    index.upsertFile({
      path,
      hash: null,
      size: 0,
      mtimeMs,
      lang: null,
      kind: 'session',
      modality: 'text',
      trivial: false,
      indexedAt: nowIso(),
      loc: session.messages.length,
    });
    index.setMetadata(path, metadata);
  }

  private async reconcileSessions(): Promise<void> {
    const summaries = await this.store.listSessions().catch(() => []);
    const index = await openGlobalCollection(this.store.homePath, 'sessions');
    if (!index) return;
    try {
      const wanted = new Map(summaries.map((s) => [`${s.gezelId}/${s.id}`, s]));
      for (const f of index.allFiles()) {
        if (!wanted.has(f.path)) index.deleteFile(f.path);
      }
      for (const [path, s] of wanted) {
        const f = index.getFile(path);
        const mtime = Date.parse(s.lastActivityAt) || 0;
        if (!f || f.mtimeMs !== mtime) {
          this.dirtySessions.set(path, { type: 'write', gezelId: s.gezelId, sessionId: s.id });
        }
      }
    } finally {
      index.close();
    }
  }

  // ── history ────────────────────────────────────────────────────────────

  private async flushHistory(batch: HistoryEvent[]): Promise<void> {
    const index = await openGlobalCollection(this.store.homePath, 'history', { throwOnBusy: true });
    if (!index) return;
    try {
      index.putHistoryEvents(batch);
    } finally {
      index.close();
    }
  }

  /**
   * Insert whatever the JSONL source holds that the mirror lacks. Under a live
   * workload the mirror always trails the file by the events waiting for the
   * next flush, so a count mismatch is the normal case, not drift. Replacing
   * all 1.4M events on every mismatch held the API thread for 73 s at boot and
   * every six hours, long enough for clients' connections to time out
   * (2026-10-27). Inserts skip ids already present; small transactions with a
   * yield between them keep the thread responsive. Only a mirror holding more
   * events than the source (a deletion it never saw) is rebuilt.
   */
  private async reconcileHistory(): Promise<void> {
    const index = await openGlobalCollection(this.store.homePath, 'history');
    if (!index) return;
    try {
      const mirrored = index.historyCount();
      let seen = 0;
      let added = 0;
      let batch: HistoryEvent[] = [];
      const put = async (): Promise<void> => {
        added += index.putHistoryEvents(batch);
        batch = [];
        await new Promise((resolve) => setImmediate(resolve));
      };
      for await (const event of this.history.iterateEvents()) {
        seen += 1;
        batch.push(event);
        if (batch.length >= HISTORY_RECONCILE_BATCH) await put();
      }
      await put();
      if (mirrored + added > seen) {
        await this.rebuildHistoryMirror();
        log.info(`history mirror rebuilt: ${mirrored + added - seen} events no longer in the log`);
      } else if (added > 0) {
        log.info(`history backfill: ${added} events mirrored`);
      }
      index.setMeta(HISTORY_BACKFILL_META_KEY, nowIso());
    } finally {
      index.close();
    }
  }

  /** Rebuild after a privacy deletion/redaction so FTS retains no stale copy. */
  async rebuildHistoryMirror(): Promise<void> {
    const events = await this.history.listEvents({});
    const index = await openGlobalCollection(this.store.homePath, 'history');
    if (!index) return;
    try {
      index.replaceHistoryEvents(events);
      index.setMeta(HISTORY_BACKFILL_META_KEY, nowIso());
    } finally {
      index.close();
    }
  }

  // ── documents (legacy) ─────────────────────────────────────────────────

  /**
   * Drop the retired `documents` collection.
   *
   * Documents used to be mirrored here as a second, thinner pipeline: FTS
   * only, unranked, with a conversion that ran before it could hash-gate — so
   * every office document was re-parsed on each reconcile and the markdown
   * discarded. The shared library is a project now (ADR 0006) and its content
   * lives in that project's index, so these rows are stale duplicates that
   * would otherwise keep answering searches.
   *
   * One-shot and idempotent: once the rows are gone this finds nothing. No
   * data migration — the library re-indexes through the project pipeline.
   */
  private async purgeLegacyDocuments(): Promise<void> {
    const index = await openGlobalCollection(this.store.homePath, 'documents');
    if (!index) return;
    try {
      const files = index.allFiles();
      if (files.length === 0) return;
      for (const file of files) index.deleteFile(file.path);
      log.info(`purged ${files.length} rows from the retired documents collection`);
    } finally {
      index.close();
    }
  }
}

/**
 * Pack a transcript into FTS chunks. lineStart/lineEnd are 1-based message
 * indices — the deep-link coordinate a search hit reports back. Empty messages
 * keep their index (they're skipped, not renumbered) so the coordinates always
 * agree with `session.messages`.
 */
export function chunkTranscript(messages: ChatMessage[]): ChunkInput[] {
  const chunks: ChunkInput[] = [];
  let buf: string[] = [];
  let bufChars = 0;
  let start = 0;
  let end = 0;
  const push = () => {
    if (buf.length === 0) return;
    chunks.push({
      kind: 'transcript',
      lineStart: start + 1,
      lineEnd: end + 1,
      text: buf.join('\n'),
    });
    buf = [];
    bufChars = 0;
  };
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m) continue;
    const content = m.content.trim();
    if (!content) continue;
    const label = m.from?.gezelName ?? m.role;
    const rendered = `${label}: ${content}`.slice(0, MAX_TRANSCRIPT_CHUNK_CHARS);
    if (buf.length > 0 && bufChars + rendered.length > MAX_TRANSCRIPT_CHUNK_CHARS) push();
    if (buf.length === 0) start = i;
    buf.push(rendered);
    bufChars += rendered.length + 1;
    end = i;
  }
  push();
  return chunks;
}

function singleTextChunk(content: string): ChunkInput[] {
  const text = content.trim();
  if (!text) return [];
  const lineCount = content.split(/\r?\n/).length;
  return [
    {
      kind: 'doc',
      lineStart: 1,
      lineEnd: lineCount,
      text: text.slice(0, MAX_TRANSCRIPT_CHUNK_CHARS),
    },
  ];
}

function unref(timer: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>): void {
  if (typeof (timer as { unref?: () => void }).unref === 'function') {
    (timer as { unref: () => void }).unref();
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
