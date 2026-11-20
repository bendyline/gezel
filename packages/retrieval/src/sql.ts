/**
 * The slice of a synchronous SQLite binding the live index uses. Node's
 * `node:sqlite` `DatabaseSync` satisfies it as is; `./sqlite-wasm` adapts
 * sqlite-wasm's oo1 API for a Web Worker or WebView. Synchronous on purpose:
 * the index runs in a worker or a Node process, off any UI thread.
 *
 * The binding must include FTS5 and the JSON functions (both are in Node's
 * build and the official sqlite-wasm build) and support `RETURNING`.
 */
export type SqlValue = string | number | bigint | Uint8Array | null;

export type SqlRow = Record<string, SqlValue>;

export interface SqlStatement {
  run(...params: SqlValue[]): { readonly changes: number | bigint };
  get(...params: SqlValue[]): SqlRow | undefined;
  all(...params: SqlValue[]): SqlRow[];
}

export interface SqlDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
}
