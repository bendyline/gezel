/**
 * Read-only, immutable catalog database opener. Deliberately NOT the
 * service's `openIndexDatabase`, whose behaviors are all wrong for a signed
 * publisher artifact: it mkdirs the parent, switches on WAL (sidecar files),
 * and quarantine-RENAMES a corrupt database. A catalog reader must fail
 * with a typed reason and never touch the bytes. No extension is loaded:
 * every table in a 0.5 catalog is plain SQLite (plus FTS5).
 */

import { pathToFileURL } from 'node:url';
import { GEZK_APPLICATION_ID, GEZK_INDEX_SCHEMA_VERSION } from '../format/constants.js';
import { DatabaseSync } from '../format/node-sqlite.js';

export class CatalogOpenError extends Error {
  constructor(
    message: string,
    readonly reason: 'not-found' | 'not-a-catalog' | 'schema-version' | 'corrupt',
  ) {
    super(message);
    this.name = 'CatalogOpenError';
  }
}

export interface CatalogDb {
  db: DatabaseSync;
  close(): void;
}

/**
 * Open one catalog SQLite file read-only + immutable and verify the format
 * stamps. `immutable=1` promises SQLite the file cannot change while open —
 * no locking, no journal probing — which is true for a published catalog
 * version and is what makes concurrent readers free.
 */
export function openCatalogDatabase(absPath: string): CatalogDb {
  const uri = `${pathToFileURL(absPath).href}?immutable=1`;
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(uri, { readOnly: true });
  } catch (err) {
    throw new CatalogOpenError(
      `cannot open catalog database ${absPath}: ${err instanceof Error ? err.message : String(err)}`,
      'not-found',
    );
  }
  try {
    const appId = readPragmaNumber(db, 'application_id');
    if (appId !== GEZK_APPLICATION_ID) {
      throw new CatalogOpenError(
        `not a .gezk catalog database (application_id ${appId})`,
        'not-a-catalog',
      );
    }
    const schemaVersion = readPragmaNumber(db, 'user_version');
    if (schemaVersion !== GEZK_INDEX_SCHEMA_VERSION) {
      throw new CatalogOpenError(
        `unsupported index schema version ${schemaVersion} (this reader supports ${GEZK_INDEX_SCHEMA_VERSION}; catalogs built for gezk 0.4 and earlier must be rebuilt)`,
        'schema-version',
      );
    }

    // Warm-read hints; both are per-connection and legal on read-only opens.
    db.exec('PRAGMA mmap_size=536870912');
    db.exec('PRAGMA cache_size=-8192');

    return {
      db,
      close: () => {
        try {
          db.close();
        } catch {
          /* already closed */
        }
      },
    };
  } catch (err) {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    throw err;
  }
}

function readPragmaNumber(db: DatabaseSync, pragma: string): number {
  const row = db.prepare(`PRAGMA ${pragma}`).get() as Record<string, unknown> | undefined;
  const value = row ? Object.values(row)[0] : undefined;
  return typeof value === 'bigint' ? Number(value) : Number(value ?? Number.NaN);
}
