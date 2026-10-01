/**
 * The built JavaScript `import '@bendyline/gezel'` evaluates: `dist/index.js`
 * and every local chunk it reaches. Core's build splits modules shared between
 * entries into chunks, so a constant the entry exports — `GEZEL_VERSION`,
 * `GEZEL_CONTENT_COMPAT` — usually lives in one of them rather than in the
 * entry file. Release checks that prove the build carries the stamped version
 * read this text instead of the entry file alone.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const LOCAL_IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*)["'](\.{1,2}\/[^"']+\.js)["']/g;

export function coreEntryPath(repoRoot) {
  return resolve(repoRoot, 'packages/core/dist/index.js');
}

/** The entry's source followed by each chunk it reaches, each file once. */
export function readCoreBuiltEntry(entryPath) {
  const seen = new Set();
  const parts = [];
  const visit = (path) => {
    if (seen.has(path) || !existsSync(path)) return;
    seen.add(path);
    const source = readFileSync(path, 'utf8');
    parts.push(source);
    for (const match of source.matchAll(LOCAL_IMPORT)) {
      visit(resolve(dirname(path), match[1]));
    }
  };
  visit(entryPath);
  return parts.join('\n');
}
