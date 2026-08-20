import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';

const nodeRequire = createRequire(import.meta.url);

/**
 * Load the vendored sqlite-vec loadable extension into a WRITABLE build
 * connection (the read path has its own copy in reader/open.ts with
 * different failure semantics). A compiler without vec is a hard error —
 * there is no catalog to build without vector tables.
 */
export function loadVecExtension(db: DatabaseSync): void {
  try {
    db.enableLoadExtension(true);
    const sqliteVec = nodeRequire('sqlite-vec') as { getLoadablePath(): string };
    db.loadExtension(sqliteVec.getLoadablePath());
  } catch (err) {
    throw new Error(
      `sqlite-vec extension failed to load — the compiler cannot build vector tables: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    try {
      db.enableLoadExtension(false);
    } catch {
      /* harmless */
    }
  }
}
