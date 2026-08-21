/**
 * node:sqlite loader shim. The repo's tsup/esbuild pipeline rewrites static
 * `node:`-prefixed imports to their bare legacy names, which is harmless for
 * `fs`/`crypto` but fatal for `sqlite` — the builtin exists ONLY under the
 * `node:` prefix, so the bundled import resolves to a nonexistent npm
 * package. The service hit the same wall and loads it by string at runtime
 * (sqlite-driver.ts `nodeRequire('node:sqlite')`); this shim is that pattern
 * with the types re-exported so call sites stay typed.
 */

import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';

const nodeRequire = createRequire(import.meta.url);
const sqlite = nodeRequire('node:sqlite') as typeof import('node:sqlite');

export const DatabaseSync = sqlite.DatabaseSync;
export type DatabaseSync = DatabaseSyncType;
