/**
 * How many records a document corpus holds: the files that match the
 * writer's record grammar, wherever the adapter put them. Attachments and the
 * engine's own folders (`_actions/`, …) are not records. The count is taken at
 * the end of a pass that changed the corpus and kept in `_meta.json`, so the
 * Connections tab can say "1,204 emails" without walking the corpus.
 */

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveInside } from '@bendyline/gezel-inference/internal/fs/safe-paths';
import { RECORD_FILE_RE } from './writer.js';

async function countIn(dir: string): Promise<number> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  let count = 0;
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (entry.name === 'attachments' || entry.name.startsWith('_')) continue;
      count += await countIn(join(dir, entry.name));
    } else if (entry.isFile() && RECORD_FILE_RE.test(entry.name)) {
      count++;
    }
  }
  return count;
}

/** The records under `<storageDir>/<corpusDir>`; 0 when the corpus does not exist yet. */
export async function countCorpusRecords(storageDir: string, corpusDir: string): Promise<number> {
  const root = await resolveInside(storageDir, corpusDir).catch(() => null);
  return root ? countIn(root) : 0;
}
