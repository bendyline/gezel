import type { FileEdge, ImportBinding } from './index-store-types.js';
import type { SqliteDriver } from './sqlite-driver.js';

export function parseBindings(raw: string | null): ImportBinding[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as ImportBinding[]) : null;
  } catch {
    return null;
  }
}

/**
 * The resolved dependency graph (`file_edges`) and the raw import rows it is
 * resolved from. Reached through `IndexStore.fileEdges`; the static pass
 * rebuilds it wholesale (see `edges/refresh.ts`).
 */
export class FileEdgeTable {
  constructor(
    private readonly db: SqliteDriver,
    private readonly collectionId: string,
  ) {}

  /** Raw import rows with what resolution needs (bindings and flags); one file's, or all. */
  importRows(srcPath?: string): Array<{
    srcPath: string;
    raw: string;
    bindings: ImportBinding[] | null;
    flags: number;
  }> {
    return this.db
      .prepare(
        `SELECT src_path, raw_specifier, bindings, flags FROM imports
         WHERE collection_id = ?${srcPath === undefined ? '' : ' AND src_path = ?'}`,
      )
      .all<{
        src_path: string;
        raw_specifier: string;
        bindings: string | null;
        flags: number | null;
      }>(this.collectionId, ...(srcPath === undefined ? [] : [srcPath]))
      .map((r) => ({
        srcPath: r.src_path,
        raw: r.raw_specifier,
        bindings: parseBindings(r.bindings),
        flags: r.flags ?? 0,
      }));
  }

  /** Replace the whole graph in one transaction. */
  replace(edges: readonly FileEdge[]): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM file_edges WHERE collection_id = ?').run(this.collectionId);
      const ins = this.db.prepare(
        `INSERT OR IGNORE INTO file_edges
           (collection_id, src_path, dst_path, raw_specifier, kind, resolver, bindings, flags)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const e of edges) {
        ins.run(
          this.collectionId,
          e.src,
          e.dst,
          e.raw,
          e.kind,
          e.resolver,
          e.bindings ? JSON.stringify(e.bindings) : null,
          e.flags,
        );
      }
    });
  }

  /** The whole graph, optionally limited to some edge kinds. */
  all(kinds?: readonly FileEdge['kind'][]): FileEdge[] {
    return this.rows('', [], kinds);
  }

  /** Edges out of one file (what it depends on). */
  from(srcPath: string, kinds?: readonly FileEdge['kind'][]): FileEdge[] {
    return this.rows(' AND src_path = ?', [srcPath], kinds);
  }

  /** Edges into one file (who depends on it). */
  to(dstPath: string, kinds?: readonly FileEdge['kind'][]): FileEdge[] {
    return this.rows(' AND dst_path = ?', [dstPath], kinds);
  }

  /** Forget every edge touching a file that is gone. */
  deleteForPath(path: string): void {
    this.db
      .prepare('DELETE FROM file_edges WHERE collection_id = ? AND (src_path = ? OR dst_path = ?)')
      .run(this.collectionId, path, path);
  }

  private rows(where: string, params: string[], kinds?: readonly FileEdge['kind'][]): FileEdge[] {
    const kindSql =
      kinds && kinds.length > 0 ? ` AND kind IN (${kinds.map(() => '?').join(', ')})` : '';
    return this.db
      .prepare(
        `SELECT src_path, dst_path, raw_specifier, kind, resolver, bindings, flags
         FROM file_edges WHERE collection_id = ?${where}${kindSql}
         ORDER BY src_path, dst_path, raw_specifier`,
      )
      .all<{
        src_path: string;
        dst_path: string;
        raw_specifier: string;
        kind: FileEdge['kind'];
        resolver: string;
        bindings: string | null;
        flags: number;
      }>(this.collectionId, ...params, ...(kinds ?? []))
      .map((r) => ({
        src: r.src_path,
        dst: r.dst_path,
        raw: r.raw_specifier,
        kind: r.kind,
        resolver: r.resolver,
        bindings: parseBindings(r.bindings),
        flags: r.flags,
      }));
  }
}
