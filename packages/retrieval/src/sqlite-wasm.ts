/**
 * `@bendyline/gezel-retrieval/sqlite-wasm`: a read-write `SqlDatabase` over
 * the official sqlite-wasm build (`@sqlite.org/sqlite-wasm`), for a Web
 * Worker or a mobile WebView, and the origin-private (OPFS) pool that keeps
 * an index across launches.
 *
 * Typed structurally: the app passes in the sqlite-wasm module it bundles
 * (and serves `sqlite3.wasm` for), so this package does not depend on it.
 * The pool VFS needs a dedicated Worker; a page or a second window that
 * cannot own the pool uses `openMemoryDatabase` instead.
 */
import type { SqlDatabase, SqlRow, SqlStatement, SqlValue } from './sql.js';

export interface WasmPreparedStatement {
  readonly columnCount: number;
  bind(values: SqlValue[]): unknown;
  clearBindings(): unknown;
  step(): boolean;
  get(index: number): unknown;
  getColumnName(index: number): string | undefined;
  reset(): unknown;
}

export interface WasmDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): WasmPreparedStatement;
  changes(): number | bigint;
  close(): unknown;
}

export interface WasmSahPool {
  readonly OpfsSAHPoolDb: new (filename: string) => WasmDatabase;
  getFileNames(): string[];
  unlink(filename: string): boolean;
}

export interface WasmSqlite3 {
  readonly oo1: {
    readonly DB: new (options: { filename: string; flags?: string; vfs?: string }) => WasmDatabase;
  };
  installOpfsSAHPoolVfs?(options: { name?: string; directory?: string }): Promise<WasmSahPool>;
}

export interface WasmSqlDatabase extends SqlDatabase {
  close(): void;
}

function bind(statement: WasmPreparedStatement, params: SqlValue[]): void {
  statement.clearBindings();
  if (params.length > 0) statement.bind(params);
}

function readRow(statement: WasmPreparedStatement): SqlRow {
  const row: SqlRow = {};
  for (let index = 0; index < statement.columnCount; index++) {
    const value = statement.get(index);
    row[statement.getColumnName(index) ?? String(index)] =
      value instanceof Uint8Array ? value.slice() : (value as SqlValue);
  }
  return row;
}

/** Wrap an open sqlite-wasm oo1 database. */
export function wrapWasmDatabase(db: WasmDatabase): WasmSqlDatabase {
  const statement = (sql: string): SqlStatement => {
    const prepared = db.prepare(sql);
    const all = (params: SqlValue[]): SqlRow[] => {
      const rows: SqlRow[] = [];
      try {
        bind(prepared, params);
        while (prepared.step()) rows.push(readRow(prepared));
        return rows;
      } finally {
        prepared.reset();
      }
    };
    return {
      run: (...params) => {
        all(params);
        return { changes: db.changes() };
      },
      get: (...params) => {
        try {
          bind(prepared, params);
          return prepared.step() ? readRow(prepared) : undefined;
        } finally {
          prepared.reset();
        }
      },
      all: (...params) => all(params),
    };
  };
  return {
    exec: (sql) => {
      db.exec(sql);
    },
    prepare: statement,
    // oo1's close() finalizes every statement the database prepared.
    close: () => {
      db.close();
    },
  };
}

/** An in-memory database: nothing persists, for a window that cannot own the pool. */
export function openMemoryDatabase(sqlite3: Pick<WasmSqlite3, 'oo1'>): WasmSqlDatabase {
  return wrapWasmDatabase(new sqlite3.oo1.DB({ filename: ':memory:', flags: 'c' }));
}

/**
 * A database in an origin-private storage pool (sqlite-wasm's `opfs-sahpool`
 * VFS), which persists across launches. Only one context may hold a pool at
 * a time, so the host serializes owners (with a Web Lock, say). Throws where
 * the pool cannot be installed (no OPFS, not a dedicated Worker).
 */
export async function openPoolDatabase(
  sqlite3: WasmSqlite3,
  options: { readonly pool: string; readonly filename: string },
): Promise<{ readonly db: WasmSqlDatabase; readonly pool: WasmSahPool }> {
  if (!sqlite3.installOpfsSAHPoolVfs) {
    throw new Error('This sqlite-wasm build has no opfs-sahpool VFS');
  }
  const pool = await sqlite3.installOpfsSAHPoolVfs({ name: options.pool });
  return { db: wrapWasmDatabase(new pool.OpfsSAHPoolDb(options.filename)), pool };
}
