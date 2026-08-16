import { join } from 'node:path';
import {
  type ChatMessage,
  type ChatSession,
  type HistoryEvent,
  createLogger,
  isOutsideInInternalPath,
  nowIso,
} from '@bendyline/gezel';
import type { DocumentChangeEvent, SessionChangeEvent, Store } from '../fs/store.js';
import type { HistoryManager } from '../history/manager.js';
import { classifyFile } from './classify.js';
import { chunkMarkdown, convertDocToMarkdown, isConvertibleDoc } from './docs.js';
import {
  DOCUMENTS_ROOT_META_KEY,
  HISTORY_BACKFILL_META_KEY,
  openGlobalCollection,
} from './global-index.js';
import { sha256 } from './hash.js';
import type { ChunkInput, IndexStore } from './index-store.js';

/**
 * Single writer for `~/.gezel/index/global.db`. Change hooks (Store session/
 * document listeners, HistoryManager subscription) enqueue synchronously into
 * in-memory dirty queues; a short debounce collapses a streaming turn's many
 * writeSession calls into one re-index, and each flush opens, writes, and
 * closes per collection so no long-lived handle contends with readers.
 *
 * The db is a rebuildable cache over plain-file sources of truth. Reconcile
 * (startup-delayed, then every few hours) compares watermarks against the
 * sources, so a wiped or corrupt db self-heals and changes made while the
 * service was down are picked up.
 */

const log = createLogger('global-index');

const DEBOUNCE_MS = 3_000;
const STARTUP_DELAY_MS = 15_000;
const RECONCILE_INTERVAL_MS = 6 * 60 * 60_000;
const MAX_TRANSCRIPT_CHUNK_CHARS = 4_000;

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
  documents: boolean;
}

export class GlobalIndexManager {
  private readonly store: Store;
  private readonly history: HistoryManager;
  private readonly debounceMs: number;
  private readonly startupDelayMs: number;
  private readonly reconcileIntervalMs: number;

  private readonly dirtySessions = new Map<string, SessionChangeEvent>();
  private pendingHistory: HistoryEvent[] = [];
  private readonly dirtyDocuments = new Map<string, 'write' | 'delete'>();

  private flushTimer: ReturnType<typeof setTimeout> | null = null;
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
    this.dirtySessions.set(`${ev.gezelId}/${ev.sessionId}`, ev);
    this.scheduleFlush();
  }

  enqueueHistory(ev: HistoryEvent): void {
    this.pendingHistory.push(ev);
    this.scheduleFlush();
  }

  enqueueDocument(ev: DocumentChangeEvent): void {
    // A new folder has no content to index; its children arrive as their own
    // write events. The hook still fires so other listeners see the change.
    if (ev.type === 'mkdir') return;
    this.dirtyDocuments.set(ev.path, ev.type);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.stopped) return;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush().catch((err) => log.warn(`flush failed: ${describe(err)}`));
    }, this.debounceMs);
    unref(this.flushTimer);
  }

  /** Exposed for tests: drain all dirty queues now. */
  async flush(): Promise<void> {
    if (this.flushing) {
      this.flushQueued = true;
      return;
    }
    this.flushing = true;
    try {
      const gates = await this.gates();
      if (this.dirtySessions.size > 0) {
        const batch = [...this.dirtySessions.values()];
        this.dirtySessions.clear();
        if (gates.sessions) await this.flushSessions(batch);
      }
      if (this.pendingHistory.length > 0) {
        const batch = this.pendingHistory;
        this.pendingHistory = [];
        if (gates.history) await this.flushHistory(batch);
      }
      if (this.dirtyDocuments.size > 0) {
        const batch = new Map(this.dirtyDocuments);
        this.dirtyDocuments.clear();
        if (gates.documents) await this.flushDocuments(batch);
      }
    } finally {
      this.flushing = false;
      if (this.flushQueued) {
        this.flushQueued = false;
        this.scheduleFlush();
      }
    }
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
      if (gates.documents) {
        await this.reconcileDocuments().catch((err) =>
          log.warn(`documents reconcile failed: ${describe(err)}`),
        );
      }
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
      documents: master && si?.documents !== false,
    };
  }

  // ── sessions ───────────────────────────────────────────────────────────

  private async flushSessions(batch: SessionChangeEvent[]): Promise<void> {
    const index = await openGlobalCollection(this.store.homePath, 'sessions');
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
    const index = await openGlobalCollection(this.store.homePath, 'history');
    if (!index) return;
    try {
      index.putHistoryEvents(batch);
    } finally {
      index.close();
    }
  }

  private async reconcileHistory(): Promise<void> {
    const index = await openGlobalCollection(this.store.homePath, 'history');
    if (!index) return;
    try {
      // No `q` in the filter, so this never routes back through the FTS
      // backend — it's the plain JSONL scan, the source of truth.
      const events = await this.history.listEvents({});
      if (index.historyCount() !== events.length) {
        index.replaceHistoryEvents(events);
        log.info(`history backfill: ${events.length} events mirrored`);
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

  // ── documents ──────────────────────────────────────────────────────────

  private async flushDocuments(batch: Map<string, 'write' | 'delete'>): Promise<void> {
    const index = await openGlobalCollection(this.store.homePath, 'documents');
    if (!index) return;
    try {
      for (const [path, type] of batch) {
        if (type === 'delete') {
          index.deleteFile(path);
          continue;
        }
        await this.indexDocument(index, path);
      }
    } finally {
      index.close();
    }
  }

  private async indexDocument(index: IndexStore, path: string): Promise<void> {
    if (isOutsideInInternalPath(path)) {
      index.deleteFile(path);
      return;
    }
    const cls = classifyFile(path, 0);
    if (cls.modality === 'doc' && isConvertibleDoc(path.split('.').pop() ?? '')) {
      await this.indexConvertibleDocument(index, path);
      return;
    }
    if (cls.modality !== 'text' && cls.modality !== 'code') {
      // Binaries/images: record presence only, no content chunks.
      index.putChunks(path, null, []);
      index.upsertFile({
        path,
        hash: null,
        size: 0,
        mtimeMs: Date.now(),
        lang: cls.lang,
        kind: cls.kind,
        modality: cls.modality,
        trivial: true,
        indexedAt: nowIso(),
        loc: null,
      });
      return;
    }
    const content = await this.store.readDocument(path).catch(() => null);
    if (content === null) {
      index.deleteFile(path);
      return;
    }
    const hash = sha256(content);
    if (index.getFile(path)?.hash === hash) return;
    const chunks = cls.kind === 'markdown' ? chunkMarkdown(content) : singleTextChunk(content);
    index.putChunks(path, hash, chunks);
    index.upsertFile({
      path,
      hash,
      size: content.length,
      mtimeMs: Date.now(),
      lang: cls.lang,
      kind: cls.kind,
      modality: cls.modality,
      trivial: cls.trivial,
      indexedAt: nowIso(),
      loc: null,
    });
  }

  private async indexConvertibleDocument(index: IndexStore, path: string): Promise<void> {
    const absPath = join(this.store.documentsDir(), path);
    const conversion = await convertDocToMarkdown(absPath).catch(() => null);
    const markdown = conversion?.markdown ?? null;
    const hash = markdown ? sha256(markdown) : null;
    if (hash && index.getFile(path)?.hash === hash) return;
    index.putChunks(path, hash, markdown ? chunkMarkdown(markdown) : []);
    index.upsertFile({
      path,
      hash,
      size: markdown?.length ?? 0,
      mtimeMs: Date.now(),
      lang: null,
      kind: 'doc',
      modality: 'doc',
      trivial: !markdown,
      indexedAt: nowIso(),
      loc: null,
    });
  }

  private async reconcileDocuments(): Promise<void> {
    const entries = await this.store.listDocumentsRecursive().catch(() => []);
    const index = await openGlobalCollection(this.store.homePath, 'documents');
    if (!index) return;
    try {
      const root = this.store.documentsDir();
      if (index.getMeta(DOCUMENTS_ROOT_META_KEY) !== root) {
        for (const f of index.allFiles()) index.deleteFile(f.path);
        index.setMeta(DOCUMENTS_ROOT_META_KEY, root);
      }
      const wanted = new Set(
        entries
          .filter((entry) => !entry.isDirectory && !isOutsideInInternalPath(entry.path))
          .map((entry) => entry.path),
      );
      for (const f of index.allFiles()) {
        if (!wanted.has(f.path)) index.deleteFile(f.path);
      }
      // Hash gating happens inside indexDocument at flush time; enqueueing
      // everything is cheap relative to reading + re-chunking only what
      // actually changed.
      for (const path of wanted) this.dirtyDocuments.set(path, 'write');
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
