/**
 * Whether the sqlite-vec extension loads on this host. It publishes no build
 * for some platforms (Windows ARM64), where the index runs without vectors, so
 * a test of vector search itself has nothing to measure there.
 */

import { openIndexDatabase } from '../sqlite-driver.js';

let cached: Promise<boolean> | undefined;

export function sqliteVecLoads(): Promise<boolean> {
  cached ??= (async () => {
    const db = await openIndexDatabase(':memory:');
    if (!db) return false;
    try {
      return db.vecAvailable;
    } finally {
      db.close();
    }
  })();
  return cached;
}
