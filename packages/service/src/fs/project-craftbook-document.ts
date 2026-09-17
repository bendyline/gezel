/** Project books can use the same self-contained document as catalog books. */
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type Craftbook,
  craftbookFromDoc,
  docFromCraftbook,
  nowIso,
  parseCraftbookDoc,
  serializeCraftbookDoc,
} from '@bendyline/gezel';
import { writeFileAtomic } from './atomic.js';

/** Missing is undefined; present-but-invalid is null and must never fall back to stale legacy files. */
export async function readProjectCraftbookDocument(
  versionDir: string,
  id: string,
  version: string,
): Promise<Craftbook | null | undefined> {
  let text: string;
  try {
    text = await readFile(join(versionDir, 'craftbook.json'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const parsed = parseCraftbookDoc(text, 'json');
  if (!parsed.ok || (parsed.doc.id && parsed.doc.id !== id)) return null;
  const built = craftbookFromDoc({ ...parsed.doc, version }, { id, now: nowIso() });
  return built.ok ? built.craftbook : null;
}

/** Preserve the authoring format on edits; legacy books retain their existing file layout. */
export async function updateProjectCraftbookDocument(
  versionDir: string,
  book: Craftbook,
): Promise<boolean> {
  const file = join(versionDir, 'craftbook.json');
  try {
    await stat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  await writeFileAtomic(file, serializeCraftbookDoc(docFromCraftbook(book), 'json'));
  return true;
}
