import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { appendFile, mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import {
  type ChatSession,
  type HistoryEntry,
  type HistoryEvent,
  type HistoryFilter,
  type HistorySessionEntry,
  createLogger,
} from '@bendyline/gezel';
import {
  gezelPaths,
  gezelSessionsDir,
  globalHistoryFile,
  projectHistoryFile,
} from '@bendyline/gezel/paths';
import { writeFileAtomic } from '../fs/atomic.js';

const log = createLogger('history');

/**
 * Append-only audit log. Explicit events live in per-scope JSONL files;
 * chat session entries are derived at query time from the existing
 * `ChatSession` records on disk.
 */
export class HistoryManager {
  constructor(private readonly home: string) {}

  /**
   * In-process listeners notified after every {@link log}. The audit log is
   * the single chokepoint all gezel/project/document create/rename/delete
   * funnel through (see `StoreOptions.history`), so subscribers get a
   * dependency-free "something changed" signal — used by the search catalog
   * to invalidate itself. Synchronous + best-effort.
   */
  private readonly listeners = new Set<(event: HistoryEvent) => void>();

  /** Subscribe to logged events. Returns an unsubscribe fn. */
  subscribe(listener: (event: HistoryEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Optional indexed backend consulted for free-text (`q`) queries, so they
   * skip the full JSONL re-scan. A null result (index unavailable, backfill
   * incomplete) falls back to the scan; non-`q` queries never touch it.
   */
  private queryBackend: ((filter: HistoryFilter) => Promise<HistoryEvent[] | null>) | null = null;
  private rewriteBackend: (() => Promise<void>) | null = null;
  private mutationChain: Promise<void> = Promise.resolve();

  /** Serialize appends and whole-file privacy rewrites so neither can lose data. */
  private mutate<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.mutationChain.then(fn);
    this.mutationChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  setQueryBackend(backend: (filter: HistoryFilter) => Promise<HistoryEvent[] | null>): void {
    this.queryBackend = backend;
  }

  setRewriteBackend(backend: () => Promise<void>): void {
    this.rewriteBackend = backend;
  }

  /**
   * Permanently delete explicit audit events. Chat/session files are separate
   * user data and are intentionally never affected by history retention.
   */
  async deleteEvents(opts: { before?: string; projectId?: string } = {}): Promise<number> {
    return this.rewriteEvents(opts, () => null);
  }

  /** Permanently redact selected fields while retaining event chronology. */
  async redactEvents(opts: {
    before?: string;
    projectId?: string;
    fields: Array<'details' | 'summary' | 'identifiers'>;
  }): Promise<number> {
    const fields = new Set(opts.fields);
    return this.rewriteEvents(opts, (event) => ({
      ...event,
      ...(fields.has('summary') ? { summary: '[redacted]' } : {}),
      ...(fields.has('details') ? { details: undefined } : {}),
      ...(fields.has('identifiers') ? { projectId: undefined, gezelId: undefined } : {}),
    }));
  }

  private async rewriteEvents(
    opts: { before?: string; projectId?: string },
    transform: (event: HistoryEvent) => HistoryEvent | null,
  ): Promise<number> {
    return this.mutate(async () => {
      const files = await this.eventFiles(opts.projectId);
      let changed = 0;
      for (const file of files) {
        let raw: string;
        try {
          raw = await readFile(file, 'utf8');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw error;
        }
        const output: string[] = [];
        for (const line of raw.split(/\r?\n/)) {
          if (!line.trim()) continue;
          let event: HistoryEvent;
          try {
            event = JSON.parse(line) as HistoryEvent;
          } catch {
            // An all-events deletion must also remove unparseable remnants;
            // bounded/time-based rewrites retain them because their date is unknown.
            if (!opts.before) changed++;
            else output.push(line);
            continue;
          }
          const selected =
            (!opts.projectId || event.projectId === opts.projectId) &&
            (!opts.before || event.at < opts.before);
          if (!selected) {
            output.push(line);
            continue;
          }
          const next = transform(event);
          changed++;
          if (next) output.push(JSON.stringify(next));
        }
        await writeFileAtomic(file, output.length > 0 ? `${output.join('\n')}\n` : '', {
          mode: 0o600,
        });
      }
      if (changed > 0) await this.rewriteBackend?.();
      return changed;
    });
  }

  private async eventFiles(projectId?: string): Promise<string[]> {
    const files = [globalHistoryFile(this.home)];
    if (projectId) {
      files.push(projectHistoryFile(this.home, projectId));
      return files;
    }
    let ids: string[] = [];
    try {
      ids = await readdir(gezelPaths(this.home).projects);
    } catch {
      /* no projects */
    }
    files.push(...ids.map((id) => projectHistoryFile(this.home, id)));
    return files;
  }

  /**
   * Append an event. Persistence errors reject and subscribers are notified
   * only after the durable append has succeeded.
   */
  async log(event: Omit<HistoryEvent, 'id' | 'at'> & { at?: string; id?: string }): Promise<void> {
    return this.mutate(async () => {
      const full: HistoryEvent = {
        id: event.id ?? randomUUID(),
        at: event.at ?? new Date().toISOString(),
        kind: event.kind,
        summary: event.summary,
        ...(event.projectId ? { projectId: event.projectId } : {}),
        ...(event.gezelId ? { gezelId: event.gezelId } : {}),
        ...(event.details ? { details: event.details } : {}),
      };
      const file = event.projectId
        ? projectHistoryFile(this.home, event.projectId)
        : globalHistoryFile(this.home);
      try {
        await mkdir(dirname(file), { recursive: true });
        await appendFile(file, `${JSON.stringify(full)}\n`, 'utf8');
      } catch (err) {
        log.warn('[history] log failed:', err instanceof Error ? err.message : err);
        throw err;
      }
      // Notify subscribers after the write. Never let a listener error escape.
      for (const listener of this.listeners) {
        try {
          const result = (listener as (event: HistoryEvent) => unknown)(full);
          if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
            void Promise.resolve(result).catch((err) =>
              log.warn('[history] listener failed:', err instanceof Error ? err.message : err),
            );
          }
        } catch (err) {
          log.warn('[history] listener failed:', err instanceof Error ? err.message : err);
        }
      }
    });
  }

  /** Discrete events only. Newest-first. */
  async listEvents(filter: HistoryFilter = {}): Promise<HistoryEvent[]> {
    if (filter.q && this.queryBackend) {
      try {
        const indexed = await this.queryBackend(filter);
        if (indexed !== null) {
          return filter.limit ? indexed.slice(0, filter.limit) : indexed;
        }
      } catch (err) {
        log.warn('[history] query backend failed:', err instanceof Error ? err.message : err);
      }
    }
    const events: HistoryEvent[] = [];
    const files: string[] = [];
    // Always scan the global file.
    files.push(globalHistoryFile(this.home));
    // Scan the requested project, or every project if unfiltered.
    if (filter.projectId) {
      files.push(projectHistoryFile(this.home, filter.projectId));
    } else {
      const projectsDir = gezelPaths(this.home).projects;
      let ids: string[] = [];
      try {
        ids = await readdir(projectsDir);
      } catch {
        /* none */
      }
      for (const id of ids) files.push(projectHistoryFile(this.home, id));
    }
    for (const path of files) {
      let stream: ReturnType<typeof createReadStream>;
      try {
        stream = createReadStream(path, { encoding: 'utf8' });
      } catch {
        continue;
      }
      const lines = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
      try {
        for await (const line of lines) {
          if (!line.trim()) continue;
          try {
            const ev = JSON.parse(line) as HistoryEvent;
            if (!this.matches(ev, filter)) continue;
            events.push(ev);
            this.trimNewest(events, filter.limit);
          } catch {
            /* skip malformed */
          }
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }
    events.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    return filter.limit ? events.slice(0, filter.limit) : events;
  }

  /** Unified stream: events + derived session entries, newest-first. */
  async listEntries(filter: HistoryFilter = {}): Promise<HistoryEntry[]> {
    const [events, sessions] = await Promise.all([
      this.listEvents(filter),
      this.listSessionEntries(filter),
    ]);
    const entries: HistoryEntry[] = [
      ...events.map((e) => ({ entryType: 'event' as const, ...e })),
      ...sessions,
    ];
    entries.sort((a, b) => {
      const aAt = a.entryType === 'event' ? a.at : a.lastActivityAt;
      const bAt = b.entryType === 'event' ? b.at : b.lastActivityAt;
      return aAt < bAt ? 1 : aAt > bAt ? -1 : 0;
    });
    return filter.limit ? entries.slice(0, filter.limit) : entries;
  }

  /** Derived from persisted ChatSession records; no duplicate storage. */
  private async listSessionEntries(filter: HistoryFilter): Promise<HistorySessionEntry[]> {
    // Kind filter excluding sessions bypasses this entirely.
    if (filter.kinds && filter.kinds.length > 0) return [];
    const out: HistorySessionEntry[] = [];
    const candidates: Array<{ path: string; mtimeMs: number }> = [];
    const gezelsDir = gezelPaths(this.home).gezels;
    let gezelIds: string[] = [];
    try {
      gezelIds = await readdir(gezelsDir);
    } catch {
      /* none */
    }
    for (const gezelId of gezelIds) {
      if (filter.gezelId && filter.gezelId !== gezelId) continue;
      const sessDir = gezelSessionsDir(this.home, gezelId);
      let files: string[] = [];
      try {
        files = await readdir(sessDir);
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const path = join(sessDir, file);
        let mtimeMs = 0;
        if (filter.limit) {
          try {
            mtimeMs = (await stat(path)).mtimeMs;
          } catch {
            continue;
          }
        }
        candidates.push({ path, mtimeMs });
      }
    }
    if (filter.limit) candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

    // Session files are rewritten whenever lastActivityAt changes, so mtime
    // gives us a cheap newest-first index. Limited API queries can stop once
    // they have enough matching sessions instead of parsing every transcript.
    for (const candidate of candidates) {
      if (filter.limit && out.length >= filter.limit) break;
      let raw: string;
      try {
        raw = await readFile(candidate.path, 'utf8');
      } catch {
        continue;
      }
      try {
        const s = JSON.parse(raw) as ChatSession;
        if (filter.projectId && s.projectId !== filter.projectId) continue;
        const createdMs = Date.parse(s.createdAt);
        const lastMs = Date.parse(s.lastActivityAt);
        const durationMs =
          Number.isFinite(createdMs) && Number.isFinite(lastMs)
            ? Math.max(0, lastMs - createdMs)
            : 0;
        const entry: HistorySessionEntry = {
          entryType: 'session',
          id: s.id,
          gezelId: s.gezelId,
          projectId: s.projectId,
          title: s.title,
          createdAt: s.createdAt,
          lastActivityAt: s.lastActivityAt,
          messageCount: s.messages.length,
          durationMs,
          providerName: s.providerName,
          ...(s.model ? { model: s.model } : {}),
          ...(s.archived ? { archived: s.archived } : {}),
        };
        if (!this.matchesSessionTime(entry, filter)) continue;
        if (filter.q && !this.sessionMatchesQuery(entry, filter.q)) continue;
        out.push(entry);
        this.trimNewest(out, filter.limit, (item) => item.lastActivityAt);
      } catch {
        /* skip */
      }
    }
    return out;
  }

  /** Keep memory bounded while scanning append-only files for a limited query. */
  private trimNewest<T>(
    items: T[],
    limit: number | undefined,
    at: (item: T) => string = (item) => (item as { at?: string }).at ?? '',
  ): void {
    if (!limit || items.length <= limit * 2) return;
    items.sort((a, b) => (at(a) < at(b) ? 1 : at(a) > at(b) ? -1 : 0));
    items.length = limit;
  }

  private matches(ev: HistoryEvent, filter: HistoryFilter): boolean {
    if (filter.projectId && ev.projectId !== filter.projectId) return false;
    if (filter.gezelId && ev.gezelId !== filter.gezelId) return false;
    if (filter.kinds && !filter.kinds.includes(ev.kind)) return false;
    if (filter.from && ev.at < filter.from) return false;
    if (filter.to && ev.at > filter.to) return false;
    if (filter.q && !this.eventMatchesQuery(ev, filter.q)) return false;
    return true;
  }

  private eventMatchesQuery(ev: HistoryEvent, q: string): boolean {
    const needle = q.toLowerCase();
    if (ev.summary.toLowerCase().includes(needle)) return true;
    if (ev.details) {
      try {
        if (JSON.stringify(ev.details).toLowerCase().includes(needle)) return true;
      } catch {
        /* ignore */
      }
    }
    return false;
  }

  private matchesSessionTime(entry: HistorySessionEntry, filter: HistoryFilter): boolean {
    if (filter.from && entry.lastActivityAt < filter.from) return false;
    if (filter.to && entry.lastActivityAt > filter.to) return false;
    return true;
  }

  private sessionMatchesQuery(entry: HistorySessionEntry, q: string): boolean {
    const needle = q.toLowerCase();
    return (
      entry.title.toLowerCase().includes(needle) ||
      entry.gezelId.toLowerCase().includes(needle) ||
      entry.projectId.toLowerCase().includes(needle)
    );
  }
}

export type { HistoryEventKind } from '@bendyline/gezel';
