import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { writeFileAtomic } from '../fs/atomic.js';
import { withFrontmatter } from '../index-store/frontmatter.js';
import type { SourceAdapter } from './types.js';

/**
 * Run a source adapter over one file and write the result into a mirror folder
 * as `<relPath>.md` with YAML frontmatter. The mirror is then indexed like any
 * other folder (content indexer → metadata + chunks), so the source becomes
 * searchable with no source-specific search code. Returns the written path, or
 * null if the adapter skipped the file.
 */
export async function materializeSource(
  adapter: SourceAdapter,
  absPath: string,
  mirrorDir: string,
): Promise<string | null> {
  const doc = await adapter.convert(absPath);
  if (!doc) return null;
  const outPath = join(mirrorDir, `${doc.relPath}.md`);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFileAtomic(outPath, withFrontmatter(doc.frontmatter, doc.markdown));
  return outPath;
}
