/**
 * The folders a project's files fall into, coarse enough to read: one group
 * per top-level folder, splitting any folder that holds most of the files
 * into its subfolders (a monorepo's `packages/` becomes one group per
 * package). Files at the top level group under `''`. The Gallery's folder
 * shelves and the Timeline's lanes both read it.
 */

/** A folder holding more than this share of the files is split into its subfolders. */
const SPLIT_SHARE = 0.4;

export const TOP_LEVEL = '';

/** path → its group's folder (`''` for top-level files). */
export function folderGroups(paths: readonly string[], maxGroups = 16): Map<string, string> {
  const keyOf = new Map<string, string>(paths.map((p) => [p, topFolder(p)]));
  const total = paths.length;
  for (;;) {
    const sizes = new Map<string, number>();
    for (const key of keyOf.values()) sizes.set(key, (sizes.get(key) ?? 0) + 1);
    if (sizes.size >= maxGroups) break;
    const [largest, size] = [...sizes.entries()]
      .filter(([key]) => key !== TOP_LEVEL)
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0] ?? [TOP_LEVEL, 0];
    if (largest === TOP_LEVEL || size <= total * SPLIT_SHARE) break;
    const children = new Map<string, string>();
    for (const [path, key] of keyOf) {
      if (key === largest) children.set(path, childFolder(path, largest));
    }
    if (new Set(children.values()).size < 2) break;
    for (const [path, key] of children) keyOf.set(path, key);
  }
  return keyOf;
}

export function topFolder(path: string): string {
  const i = path.indexOf('/');
  return i < 0 ? TOP_LEVEL : path.slice(0, i);
}

/** The folder one level below `parent` that holds `path`; `parent` itself for its own files. */
function childFolder(path: string, parent: string): string {
  const rest = path.slice(parent.length + 1);
  const i = rest.indexOf('/');
  return i < 0 ? parent : `${parent}/${rest.slice(0, i)}`;
}
