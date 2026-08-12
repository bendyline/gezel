import { mkdir, rename } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { createLogger } from '@bendyline/gezel';

// Load native/builtin modules through the real Node `require`, not a bundler's
// or test runner's import pipeline. vite-node (vitest) intercepts dynamic
// `import('node:sqlite')` and fails to externalize the experimental builtin;
// `createRequire` sidesteps that and resolves identically in the tsup-bundled
// daemon. `sqlite-vec` is kept external (tsup.config) so its on-disk
// `getLoadablePath()` still resolves.
const nodeRequire = createRequire(import.meta.url);
const log = createLogger('sqlite');

/**
 * Thin abstraction over a synchronous SQLite driver. The default
 * implementation wraps Node's built-in `node:sqlite` (zero native npm build —
 * works in the spawned daemon and the Electron-bundled node alike). The
 * interface is deliberately the small subset of better-sqlite3's surface so a
 * `BetterSqliteDriver` can be dropped in later for environments that can build
 * the native module (e.g. an Electron in-process embed with electron-rebuild),
 * without touching `IndexStore`.
 *
 * Everything is synchronous (SQLite is); callers that want to yield wrap calls
 * in their own async boundaries. The whole layer degrades gracefully: if
 * `node:sqlite` is unavailable (older node) `openIndexDatabase` returns null and
 * the index features turn off, falling back to ripgrep/live-read per the
 * project's guiding principle.
 */

export type SqlValue = string | number | bigint | null | Uint8Array;

export interface SqliteStatement {
  run(...params: SqlValue[]): { changes: number; lastInsertRowid: number };
  get<T = Record<string, unknown>>(...params: SqlValue[]): T | undefined;
  all<T = Record<string, unknown>>(...params: SqlValue[]): T[];
}

export interface SqliteDriver {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  transaction<T>(fn: () => T): T;
  close(): void;
  /** True when the sqlite-vec extension loaded (vector search available). */
  readonly vecAvailable: boolean;
}

// Minimal structural type for the bits of node:sqlite we use, so we don't take
// a hard type dependency on the experimental module's typings.
interface NodeStmt {
  run(...params: SqlValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: SqlValue[]): unknown;
  all(...params: SqlValue[]): unknown[];
}
interface NodeDb {
  exec(sql: string): void;
  prepare(sql: string): NodeStmt;
  enableLoadExtension(on: boolean): void;
  loadExtension(path: string): void;
  close(): void;
}

function wrapStatement(stmt: NodeStmt): SqliteStatement {
  return {
    run: (...params) => {
      const r = stmt.run(...params);
      return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
    },
    get: <T = Record<string, unknown>>(...params: SqlValue[]) =>
      stmt.get(...params) as T | undefined,
    all: <T = Record<string, unknown>>(...params: SqlValue[]) => stmt.all(...params) as T[],
  };
}

/**
 * Open (or create) an index database at `dbPath`, attempt to load sqlite-vec,
 * and return a driver. Returns null when `node:sqlite` itself can't be loaded
 * (the caller treats this as "index disabled"). A failure to load *only*
 * sqlite-vec is non-fatal: the driver comes back with `vecAvailable === false`
 * and structural + FTS features still work.
 */
export async function openIndexDatabase(dbPath: string): Promise<SqliteDriver | null> {
  let DatabaseSync: new (path: string, opts?: { allowExtension?: boolean }) => NodeDb;
  try {
    ({ DatabaseSync } = nodeRequire('node:sqlite') as {
      DatabaseSync: typeof DatabaseSync;
    });
  } catch {
    return null; // node:sqlite unavailable (node < 22.5 without the flag)
  }

  if (dbPath !== ':memory:') {
    try {
      await mkdir(dirname(dbPath), { recursive: true });
    } catch (error) {
      if (isUnavailableIndexError(error)) return null;
      throw error;
    }
  }
  let db: NodeDb | undefined;
  try {
    db = new DatabaseSync(dbPath, { allowExtension: true });
    // Arm the busy timeout BEFORE the first file-touching statement: the
    // header probe below otherwise fails instantly with SQLITE_BUSY whenever
    // the static worker holds a momentary write lock, and that spurious
    // failure used to cascade into the home-dir fallback path.
    setBusyTimeout(db);
    assertReadableHeader(db);
  } catch (error) {
    if (dbPath === ':memory:' || !isCorruptDatabaseError(error)) {
      try {
        db?.close();
      } catch {
        /* ignore cleanup failure while preserving the open error */
      }
      throw error;
    }
    try {
      db?.close();
    } catch {
      /* corrupt handle may already be unusable */
    }
    await quarantineCorruptDatabase(dbPath);
    log.warn(`[sqlite] quarantined corrupt rebuildable index ${dbPath}`);
    db = new DatabaseSync(dbPath, { allowExtension: true });
    setBusyTimeout(db);
  }
  if (!db) throw new Error('failed to open sqlite index');

  let vecAvailable = false;
  try {
    db.enableLoadExtension(true);
    const mod = nodeRequire('sqlite-vec') as {
      getLoadablePath?: () => string;
      default?: { getLoadablePath?: () => string };
    };
    const getLoadablePath = mod.getLoadablePath ?? mod.default?.getLoadablePath;
    if (!getLoadablePath) throw new Error('sqlite-vec: getLoadablePath missing');
    db.loadExtension(getLoadablePath());
    vecAvailable = true;
  } catch {
    vecAvailable = false;
  } finally {
    try {
      db.enableLoadExtension(false);
    } catch {
      /* ignore */
    }
  }

  // Pragmas: WAL for concurrent readers while the indexer writes; NORMAL sync
  // is the right durability/throughput tradeoff for a regenerable cache.
  try {
    db.exec(
      'PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;',
    );
  } catch {
    /* memory dbs / locked dbs — non-fatal */
  }

  return {
    exec: (sql) => db.exec(sql),
    prepare: (sql) => wrapStatement(db.prepare(sql)),
    transaction: <T>(fn: () => T): T => {
      db.exec('BEGIN');
      try {
        const result = fn();
        db.exec('COMMIT');
        return result;
      } catch (err) {
        try {
          db.exec('ROLLBACK');
        } catch {
          /* ignore */
        }
        throw err;
      }
    },
    close: () => db.close(),
    vecAvailable,
  };
}

function assertReadableHeader(db: NodeDb): void {
  // This touches the schema/header and catches NOTADB/malformed files without
  // running O(database-size) quick_check on every short-lived reader open.
  db.prepare('PRAGMA schema_version').get();
}

function setBusyTimeout(db: NodeDb): void {
  try {
    db.exec('PRAGMA busy_timeout=5000;');
  } catch {
    /* pragma refusal is not fatal — the open proceeds without the grace */
  }
}

function isCorruptDatabaseError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /SQLITE_CORRUPT|SQLITE_NOTADB|database disk image is malformed|file is not a database/i.test(
    message,
  );
}

/**
 * Placement errors — this database location cannot be used at all (read-only
 * tree, permissions, missing parent). Callers may switch to a fallback
 * location. Deliberately EXCLUDES busy/locked: see `isTransientIndexError`.
 */
export function isUnavailableIndexError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /SQLITE_READONLY|SQLITE_CANTOPEN|EACCES|EPERM|read-only/i.test(message);
}

/**
 * Transient contention — the database EXISTS and works, another connection
 * just holds it right now (e.g. the static-index worker mid-transaction).
 * Never treat this as a placement failure: falling back to an alternate
 * location mints an empty database that then serves zeros. Skip the tick
 * instead.
 */
export function isTransientIndexError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /SQLITE_BUSY|SQLITE_LOCKED/i.test(message);
}

async function quarantineCorruptDatabase(dbPath: string): Promise<void> {
  const suffix = `.corrupt-${Date.now()}`;
  for (const candidate of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      await rename(candidate, `${candidate}${suffix}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

/** Serialize a float vector to the BLOB layout sqlite-vec expects. */
export function vectorToBlob(vector: number[] | Float32Array): Uint8Array {
  const f32 = vector instanceof Float32Array ? vector : Float32Array.from(vector);
  return new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
}
