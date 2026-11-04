/**
 * The part of node:sqlite's DatabaseSync the catalog reader uses, over
 * sqlite-wasm. The worker bundle swaps it in for the reader's node:sqlite
 * loader (knowledge/src/format/node-sqlite.ts), so the reader runs unchanged.
 */
import type { Database, PreparedStatement, SqlValue, Sqlite3Static } from '@sqlite.org/sqlite-wasm';

let sqlite3: Sqlite3Static | undefined;
let vfsName = '';
export function configureSqlite(module: Sqlite3Static, vfs: string): void {
  sqlite3 = module;
  vfsName = vfs;
}

type Row = Record<string, SqlValue>;

function bind(stmt: PreparedStatement, params: unknown[]) {
  stmt.clearBindings();
  if (params.length)
    stmt.bind(params.map((value) => (value === undefined ? null : value)) as SqlValue[]);
}

function row(stmt: PreparedStatement): Row {
  const out: Row = {};
  for (let i = 0; i < stmt.columnCount; i++) {
    const value = stmt.get(i) as SqlValue;
    out[stmt.getColumnName(i)] = value instanceof Uint8Array ? value.slice() : value;
  }
  return out;
}

class StatementSync {
  readonly #stmt: PreparedStatement;
  constructor(
    readonly db: Database,
    readonly sql: string,
  ) {
    this.#stmt = db.prepare(sql);
  }
  get(...params: unknown[]): Row | undefined {
    try {
      bind(this.#stmt, params);
      return this.#stmt.step() ? row(this.#stmt) : undefined;
    } finally {
      this.#stmt.reset();
    }
  }
  all(...params: unknown[]): Row[] {
    const rows: Row[] = [];
    try {
      bind(this.#stmt, params);
      while (this.#stmt.step()) rows.push(row(this.#stmt));
      return rows;
    } finally {
      this.#stmt.reset();
    }
  }
  *iterate(...params: unknown[]): Generator<Row> {
    // Its own statement: a caller may prepare the same SQL while iterating.
    const stmt = this.db.prepare(this.sql);
    try {
      bind(stmt, params);
      while (stmt.step()) yield row(stmt);
    } finally {
      stmt.finalize();
    }
  }
  run(...params: unknown[]) {
    this.all(...params);
    return { changes: 0, lastInsertRowid: 0 };
  }
}

export class DatabaseSync {
  readonly #db: Database;
  readonly #statements = new Map<string, StatementSync>();
  constructor(location: string, options: { readOnly?: boolean } = {}) {
    if (!sqlite3) throw new Error('SQLite is not ready');
    if (options.readOnly === false)
      throw new Error('Catalog databases are read-only on this device');
    // The reader opens `file:///abs/path?immutable=1`; the VFS is read-only regardless.
    const url = new URL(location.startsWith('file:') ? location : `file://${location}`);
    const path = decodeURIComponent(url.pathname);
    this.#db = new sqlite3.oo1.DB({
      filename: `file:${path}?immutable=1`,
      flags: 'r',
      vfs: vfsName,
    });
  }
  exec(sql: string): void {
    this.#db.exec(sql);
  }
  prepare(sql: string): StatementSync {
    let statement = this.#statements.get(sql);
    if (!statement) {
      statement = new StatementSync(this.#db, sql);
      this.#statements.set(sql, statement);
    }
    return statement;
  }
  close(): void {
    this.#statements.clear();
    this.#db.close();
  }
}
