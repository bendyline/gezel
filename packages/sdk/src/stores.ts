/**
 * `@bendyline/gezel-sdk/stores` — small persistent-store helpers for
 * sandboxed scripts: an append-only event log with derived stats
 * (`logStore`) and a record roster with staged status transitions
 * (`rosterStore`).
 *
 * These are the shared "data that accrues" primitives project-type
 * scripts wrap (a language trainer's practice log, a job hunt's
 * application pipeline) so each type doesn't hand-roll its own JSON
 * handling, streak math, and transition history.
 *
 * Like `./checks`, this entry takes its dependencies structurally
 * (`StoreFs`, satisfied by `gezel.fs` or `gezel.artifacts`) instead of
 * importing the main entry's stdin-initialized singleton — the bundle
 * stays standalone for vendoring into sandbox scratch dirs.
 *
 * Persistence rules:
 * - A failed read is treated as "no store yet" (the structural interface
 *   can't distinguish missing from unreadable; `gezel.fs.read` throws on
 *   both). The file is created lazily on the first write.
 * - Corrupt JSON or an unknown `version` throws — user data is never
 *   silently reset.
 * - Files are written pretty-printed with a trailing newline so they stay
 *   pleasant to `cat` and diff, per the files-all-the-way-down principle.
 * - Calls are single read-modify-write; cross-run races are out of scope
 *   for a single-user local tool.
 *
 * Scripts using these helpers on the workspace need
 * `requires: ['workspace.read', 'workspace.write']`.
 */

export interface StoreFs {
  /** Read a file's text content. Expected to throw when the file is absent. */
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
}

export interface StoreOptions {
  /** Injectable clock for deterministic tests. Defaults to the real time. */
  now?: () => string;
}

function defaultNow(): string {
  return new Date().toISOString();
}

function parseStoreFile<T extends { version: number }>(path: string, raw: string): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Store file ${path} is not valid JSON (${err instanceof Error ? err.message : String(err)}). Fix or remove the file; it will not be overwritten automatically.`,
    );
  }
  const version = (parsed as { version?: unknown }).version;
  if (version !== 1) {
    throw new Error(`Store file ${path} has unsupported version ${String(version)} (expected 1).`);
  }
  return parsed as T;
}

async function loadStoreFile<T extends { version: number }>(
  fs: StoreFs,
  path: string,
): Promise<T | null> {
  let raw: string;
  try {
    raw = await fs.read(path);
  } catch {
    return null;
  }
  return parseStoreFile<T>(path, raw);
}

async function saveStoreFile(fs: StoreFs, path: string, value: unknown): Promise<void> {
  await fs.write(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** The UTC calendar day (YYYY-MM-DD) an ISO timestamp falls on. */
function utcDay(iso: string): string {
  return iso.slice(0, 10);
}

// ── logStore ────────────────────────────────────────────────────────

export interface LogEvent {
  at: string;
  kind: string;
  note?: string;
  data?: Record<string, unknown>;
}

export interface LogStats {
  total: number;
  byKind: Record<string, number>;
  /** Consecutive UTC days with events, ending at the latest event's day. */
  streakDays: number;
  /** Distinct UTC days with at least one event. */
  daysActive: number;
  firstAt: string | null;
  lastAt: string | null;
}

export interface LogStoreFile {
  version: 1;
  events: LogEvent[];
}

export interface LogStore {
  append(event: {
    kind: string;
    note?: string;
    data?: Record<string, unknown>;
    at?: string;
  }): Promise<LogEvent>;
  /**
   * Events matching the filter, oldest first. `since` is an inclusive ISO
   * lower bound on `at`; `limit` keeps the most recent N matches.
   */
  list(filter?: { kind?: string; since?: string; limit?: number }): Promise<LogEvent[]>;
  stats(): Promise<LogStats>;
}

export function logStore(fs: StoreFs, path: string, opts: StoreOptions = {}): LogStore {
  const now = opts.now ?? defaultNow;

  async function load(): Promise<LogStoreFile> {
    return (await loadStoreFile<LogStoreFile>(fs, path)) ?? { version: 1, events: [] };
  }

  return {
    async append(event) {
      const file = await load();
      const entry: LogEvent = {
        at: event.at ?? now(),
        kind: event.kind,
        ...(event.note !== undefined ? { note: event.note } : {}),
        ...(event.data !== undefined ? { data: event.data } : {}),
      };
      file.events.push(entry);
      await saveStoreFile(fs, path, file);
      return entry;
    },

    async list(filter = {}) {
      const file = await load();
      let events = file.events;
      if (filter.kind !== undefined) events = events.filter((e) => e.kind === filter.kind);
      if (filter.since !== undefined) events = events.filter((e) => e.at >= filter.since!);
      if (filter.limit !== undefined && filter.limit >= 0 && events.length > filter.limit) {
        events = events.slice(events.length - filter.limit);
      }
      return events;
    },

    async stats() {
      const file = await load();
      const byKind: Record<string, number> = {};
      const days = new Set<string>();
      let firstAt: string | null = null;
      let lastAt: string | null = null;
      for (const e of file.events) {
        byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
        days.add(utcDay(e.at));
        if (firstAt === null || e.at < firstAt) firstAt = e.at;
        if (lastAt === null || e.at > lastAt) lastAt = e.at;
      }
      let streakDays = 0;
      if (lastAt !== null) {
        // Walk backward one UTC day at a time from the latest event's day;
        // anchoring on the data (not "today") keeps stats clock-independent.
        let cursor = Date.parse(`${utcDay(lastAt)}T00:00:00Z`);
        while (days.has(new Date(cursor).toISOString().slice(0, 10))) {
          streakDays += 1;
          cursor -= 24 * 60 * 60 * 1000;
        }
      }
      return {
        total: file.events.length,
        byKind,
        streakDays,
        daysActive: days.size,
        firstAt,
        lastAt,
      };
    },
  };
}

// ── rosterStore ─────────────────────────────────────────────────────

export interface RosterTransition {
  at: string;
  /** Null on the record's creation entry. `from === to` marks a note-only touch. */
  from: string | null;
  to: string;
  note?: string;
}

export interface RosterRecord {
  id: string;
  status: string;
  fields: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  history: RosterTransition[];
}

export interface RosterStoreFile {
  version: 1;
  stages: string[];
  records: RosterRecord[];
}

export interface RosterStore {
  /** Add a record. Defaults: status = first stage; id = `<idPrefix>-<n>`. */
  add(input?: {
    id?: string;
    status?: string;
    fields?: Record<string, unknown>;
    note?: string;
  }): Promise<RosterRecord>;
  get(id: string): Promise<RosterRecord | null>;
  list(filter?: { status?: string }): Promise<RosterRecord[]>;
  /** Merge fields and/or record a note without changing status. */
  update(
    id: string,
    patch: { fields?: Record<string, unknown>; note?: string },
  ): Promise<RosterRecord>;
  /** Move a record to another stage, appending to its history. */
  transition(id: string, to: string, opts?: { note?: string }): Promise<RosterRecord>;
  /** Records per status; every declared stage present, zero-filled. */
  counts(): Promise<Record<string, number>>;
}

export interface RosterStoreOptions extends StoreOptions {
  /** Stage vocabulary used to initialize a new store file. An existing file's own `stages` win. */
  stages: [string, ...string[]];
  /** Prefix for generated record ids. Defaults to `'rec'`. */
  idPrefix?: string;
}

export function rosterStore(fs: StoreFs, path: string, opts: RosterStoreOptions): RosterStore {
  const now = opts.now ?? defaultNow;
  const idPrefix = opts.idPrefix ?? 'rec';

  async function load(): Promise<RosterStoreFile> {
    return (
      (await loadStoreFile<RosterStoreFile>(fs, path)) ?? {
        version: 1,
        stages: [...opts.stages],
        records: [],
      }
    );
  }

  function mustFind(file: RosterStoreFile, id: string): RosterRecord {
    const record = file.records.find((r) => r.id === id);
    if (!record) {
      throw new Error(
        `No record '${id}' in ${path}. Known ids: ${file.records.map((r) => r.id).join(', ') || '(none)'}`,
      );
    }
    return record;
  }

  function assertStage(file: RosterStoreFile, status: string): void {
    if (!file.stages.includes(status)) {
      throw new Error(`Unknown stage '${status}' for ${path}. Stages: ${file.stages.join(', ')}`);
    }
  }

  // Max numeric suffix + 1 (not record count): ids stay unique even when
  // callers mixed in their own ids or a file was hand-pruned.
  function nextId(file: RosterStoreFile): string {
    let max = 0;
    const pattern = new RegExp(`^${idPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(\\d+)$`);
    for (const r of file.records) {
      const m = pattern.exec(r.id);
      if (m) max = Math.max(max, Number(m[1]));
    }
    return `${idPrefix}-${max + 1}`;
  }

  return {
    async add(input = {}) {
      const file = await load();
      const status = input.status ?? file.stages[0]!;
      assertStage(file, status);
      const id = input.id ?? nextId(file);
      if (file.records.some((r) => r.id === id)) {
        throw new Error(`Record '${id}' already exists in ${path}.`);
      }
      const at = now();
      const record: RosterRecord = {
        id,
        status,
        fields: input.fields ?? {},
        createdAt: at,
        updatedAt: at,
        history: [
          { at, from: null, to: status, ...(input.note !== undefined ? { note: input.note } : {}) },
        ],
      };
      file.records.push(record);
      await saveStoreFile(fs, path, file);
      return record;
    },

    async get(id) {
      const file = await load();
      return file.records.find((r) => r.id === id) ?? null;
    },

    async list(filter = {}) {
      const file = await load();
      return filter.status === undefined
        ? file.records
        : file.records.filter((r) => r.status === filter.status);
    },

    async update(id, patch) {
      const file = await load();
      const record = mustFind(file, id);
      if (patch.fields) record.fields = { ...record.fields, ...patch.fields };
      const at = now();
      record.updatedAt = at;
      if (patch.note !== undefined) {
        record.history.push({ at, from: record.status, to: record.status, note: patch.note });
      }
      await saveStoreFile(fs, path, file);
      return record;
    },

    async transition(id, to, transitionOpts = {}) {
      const file = await load();
      const record = mustFind(file, id);
      assertStage(file, to);
      const at = now();
      record.history.push({
        at,
        from: record.status,
        to,
        ...(transitionOpts.note !== undefined ? { note: transitionOpts.note } : {}),
      });
      record.status = to;
      record.updatedAt = at;
      await saveStoreFile(fs, path, file);
      return record;
    },

    async counts() {
      const file = await load();
      const counts: Record<string, number> = {};
      for (const stage of file.stages) counts[stage] = 0;
      for (const r of file.records) counts[r.status] = (counts[r.status] ?? 0) + 1;
      return counts;
    },
  };
}

// ── ledgerStore ─────────────────────────────────────────────────────

export interface LedgerEntry {
  id: string;
  at: string;
  /** Always integer cents — float money drifts. */
  amountCents: number;
  kind: 'in' | 'out';
  category: string;
  note?: string;
  data?: Record<string, unknown>;
}

export interface LedgerBucket {
  inCents: number;
  outCents: number;
  netCents: number;
}

export interface LedgerTotals extends LedgerBucket {
  count: number;
  byCategory: Record<string, LedgerBucket>;
  /** Keyed by UTC month, `YYYY-MM`. */
  byMonth: Record<string, LedgerBucket>;
}

export interface LedgerStoreFile {
  version: 1;
  currency: string;
  entries: LedgerEntry[];
}

export interface LedgerStore {
  add(entry: {
    amountCents: number;
    kind: 'in' | 'out';
    category: string;
    note?: string;
    at?: string;
    data?: Record<string, unknown>;
  }): Promise<LedgerEntry>;
  /** Entries matching the filter, oldest first. `month` is `YYYY-MM` (UTC). */
  list(filter?: {
    kind?: 'in' | 'out';
    category?: string;
    month?: string;
    limit?: number;
  }): Promise<LedgerEntry[]>;
  /** Rollups over the (optionally filtered) entries. */
  totals(filter?: { month?: string; category?: string }): Promise<LedgerTotals>;
}

function emptyBucket(): LedgerBucket {
  return { inCents: 0, outCents: 0, netCents: 0 };
}

function addToBucket(bucket: LedgerBucket, entry: LedgerEntry): void {
  if (entry.kind === 'in') bucket.inCents += entry.amountCents;
  else bucket.outCents += entry.amountCents;
  bucket.netCents = bucket.inCents - bucket.outCents;
}

/**
 * Money in/out with categories and monthly rollups — budgets, invoices,
 * event budgets, pledge drives. Same persistence rules as the other
 * stores; amounts are validated positive integers (the `kind` carries
 * the sign).
 */
export function ledgerStore(
  fs: StoreFs,
  path: string,
  opts: StoreOptions & { currency?: string } = {},
): LedgerStore {
  const now = opts.now ?? defaultNow;

  async function load(): Promise<LedgerStoreFile> {
    return (
      (await loadStoreFile<LedgerStoreFile>(fs, path)) ?? {
        version: 1,
        currency: opts.currency ?? 'USD',
        entries: [],
      }
    );
  }

  function nextId(file: LedgerStoreFile): string {
    let max = 0;
    for (const e of file.entries) {
      const m = /^ledger-(\d+)$/.exec(e.id);
      if (m) max = Math.max(max, Number(m[1]));
    }
    return `ledger-${max + 1}`;
  }

  return {
    async add(entry) {
      if (!Number.isInteger(entry.amountCents) || entry.amountCents <= 0) {
        throw new Error(
          `amountCents must be a positive integer (got ${String(entry.amountCents)}); the 'kind' carries the sign.`,
        );
      }
      if (entry.kind !== 'in' && entry.kind !== 'out') {
        throw new Error(`kind must be 'in' or 'out' (got '${String(entry.kind)}').`);
      }
      if (!entry.category || typeof entry.category !== 'string') {
        throw new Error('category is required.');
      }
      const file = await load();
      const record: LedgerEntry = {
        id: nextId(file),
        at: entry.at ?? now(),
        amountCents: entry.amountCents,
        kind: entry.kind,
        category: entry.category,
        ...(entry.note !== undefined ? { note: entry.note } : {}),
        ...(entry.data !== undefined ? { data: entry.data } : {}),
      };
      file.entries.push(record);
      await saveStoreFile(fs, path, file);
      return record;
    },

    async list(filter = {}) {
      const file = await load();
      let entries = file.entries;
      if (filter.kind) entries = entries.filter((e) => e.kind === filter.kind);
      if (filter.category) entries = entries.filter((e) => e.category === filter.category);
      if (filter.month) entries = entries.filter((e) => e.at.slice(0, 7) === filter.month);
      if (filter.limit !== undefined && filter.limit >= 0 && entries.length > filter.limit) {
        entries = entries.slice(entries.length - filter.limit);
      }
      return entries;
    },

    async totals(filter = {}) {
      const file = await load();
      let entries = file.entries;
      if (filter.month) entries = entries.filter((e) => e.at.slice(0, 7) === filter.month);
      if (filter.category) entries = entries.filter((e) => e.category === filter.category);
      const totals: LedgerTotals = {
        ...emptyBucket(),
        count: entries.length,
        byCategory: {},
        byMonth: {},
      };
      for (const e of entries) {
        addToBucket(totals, e);
        totals.byCategory[e.category] ??= emptyBucket();
        addToBucket(totals.byCategory[e.category]!, e);
        const month = e.at.slice(0, 7);
        totals.byMonth[month] ??= emptyBucket();
        addToBucket(totals.byMonth[month]!, e);
      }
      return totals;
    },
  };
}
