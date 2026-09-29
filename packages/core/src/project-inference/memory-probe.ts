import { compareKey, normalizePath, parentOf, separatorFor } from './path-compare.js';
import type { FsEntry, FsProbe, InferencePlatform } from './types.js';

/**
 * An in-memory {@link FsProbe} for tests and previews. Pass file paths
 * (`'/home/u/Documents/a/report.docx'`) and directory paths ending in a
 * separator (`'/home/u/empty/'`); parent directories are implied.
 */
export function memoryFsProbe(
  paths: readonly string[],
  platform: InferencePlatform,
  opts: { unreadable?: readonly string[] } = {},
): FsProbe {
  const sep = separatorFor(platform);
  const children = new Map<string, Map<string, FsEntry>>();
  const addChild = (parent: string, name: string, isDir: boolean): void => {
    const key = compareKey(parent, platform);
    let map = children.get(key);
    if (!map) {
      map = new Map();
      children.set(key, map);
    }
    const existing = map.get(name);
    if (!existing || (isDir && !existing.isDir)) map.set(name, { name, isDir });
  };
  for (const raw of paths) {
    const isDir = raw.endsWith(sep) || raw.endsWith('/');
    let cur = normalizePath(raw, platform);
    let curIsDir = isDir;
    if (curIsDir && !children.has(compareKey(cur, platform))) {
      children.set(compareKey(cur, platform), new Map());
    }
    for (
      let parent = parentOf(cur, platform);
      parent !== null;
      parent = parentOf(parent, platform)
    ) {
      const name = cur.slice(cur.lastIndexOf(sep) + 1);
      addChild(parent, name, curIsDir);
      cur = parent;
      curIsDir = true;
    }
  }
  const unreadable = new Set((opts.unreadable ?? []).map((p) => compareKey(p, platform)));
  return {
    async listDir(path: string) {
      const key = compareKey(path, platform);
      if (unreadable.has(key)) return null;
      const map = children.get(key);
      return map ? [...map.values()] : null;
    },
  };
}
