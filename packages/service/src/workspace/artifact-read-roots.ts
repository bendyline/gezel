import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { artifactKey } from '../connectors/corpus-path.js';

/** Past this many grants a folder is left out whole: less access, never more. */
const MAX_ROOTS = 200;

/**
 * The folders of the artifacts drawer a sandboxed script may read when some
 * of it stays on models on this computer. A read grant covers everything
 * below it, so the kept paths are left out by granting what is beside them.
 */
export async function artifactReadRoots(
  artifactsDir: string,
  hidden: readonly string[],
): Promise<string[]> {
  if (hidden.length === 0) return [artifactsDir];
  const keys = hidden.map((path) => artifactKey(path));
  const walk = async (rel: string): Promise<string[]> => {
    const entries = await readdir(join(artifactsDir, rel), { withFileTypes: true }).catch(() => []);
    if (entries.length > MAX_ROOTS) return [];
    const roots: string[] = [];
    for (const entry of entries) {
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      const key = artifactKey(path);
      if (keys.includes(key)) continue;
      // A link could lead back into what was left out.
      if (entry.isSymbolicLink()) continue;
      if (keys.some((k) => k.startsWith(`${key}/`))) roots.push(...(await walk(path)));
      else roots.push(join(artifactsDir, path));
    }
    return roots.length > MAX_ROOTS ? [] : roots;
  };
  return walk('');
}
