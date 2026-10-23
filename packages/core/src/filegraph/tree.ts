import type { FileGraphResponse } from '../schemas/api/project-views.js';

/**
 * The folders a Diagram can open and close. A pass-through chain — a folder
 * holding nothing but one subfolder, as `packages/core/src` does under
 * `packages` — is one display folder, so opening it never reveals a lone box
 * that only opens again. A package root takes its manifest's name.
 */
export interface DiagramFolder {
  /** The deepest folder of the chain; files and subfolders hang off it. */
  path: string;
  /** Relative to the parent display folder (`core/src`), or the package name. */
  label: string;
  /** Parent display folder; `''` is the project root. Null only for the root itself. */
  parent: string | null;
  /** Display subfolders, in path order. */
  folders: string[];
  /** Files directly inside, in path order. */
  files: string[];
  /** Files at or below. */
  fileCount: number;
  packageName?: string;
  purpose?: string;
}

export interface DiagramTree {
  /** Every display folder by path, the root (`''`) included. */
  folders: Map<string, DiagramFolder>;
  /** File path → the display folder holding it. */
  folderOfFile: Map<string, string>;
}

type GraphInput = Pick<FileGraphResponse, 'nodes' | 'folders' | 'packageRoots'>;

interface RawFolder {
  path: string;
  children: Map<string, RawFolder>;
  files: string[];
}

function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function buildDiagramTree(graph: GraphInput, files?: readonly string[]): DiagramTree {
  const root: RawFolder = { path: '', children: new Map(), files: [] };
  for (const path of files ?? graph.nodes.map((n) => n.id)) {
    const segs = path.split('/');
    let node = root;
    for (let i = 0; i < segs.length - 1; i++) {
      const name = segs[i]!;
      let child = node.children.get(name);
      if (!child) {
        child = { path: segs.slice(0, i + 1).join('/'), children: new Map(), files: [] };
        node.children.set(name, child);
      }
      node = child;
    }
    node.files.push(path);
  }

  const packageNames = new Map(graph.packageRoots.map((r) => [r.folder, r.name]));
  const purposes = new Map(
    graph.folders.filter((f) => f.purpose).map((f) => [f.path, f.purpose as string]),
  );
  const folders = new Map<string, DiagramFolder>();
  const folderOfFile = new Map<string, string>();

  const add = (raw: RawFolder, parent: string | null): DiagramFolder => {
    // Walk the pass-through chain down to the folder that branches or holds files.
    const chain = [raw];
    let cur = raw;
    while (parent !== null && cur.children.size === 1 && cur.files.length === 0) {
      cur = cur.children.values().next().value as RawFolder;
      chain.push(cur);
    }
    const packageRoot = chain.find((f) => packageNames.has(f.path));
    const relative = parent ? cur.path.slice(parent.length + 1) : cur.path;
    const folder: DiagramFolder = {
      path: cur.path,
      label: packageRoot ? packageNames.get(packageRoot.path)! : relative,
      parent,
      folders: [],
      files: [...cur.files].sort(byCodeUnit),
      fileCount: 0,
      ...(packageRoot ? { packageName: packageNames.get(packageRoot.path)! } : {}),
    };
    const purpose = purposes.get(cur.path) ?? chain.map((f) => purposes.get(f.path)).find(Boolean);
    if (purpose) folder.purpose = purpose;
    folders.set(folder.path, folder);
    for (const file of folder.files) folderOfFile.set(file, folder.path);
    let count = folder.files.length;
    const children = [...cur.children.values()].sort((a, b) => byCodeUnit(a.path, b.path));
    for (const child of children) {
      const sub = add(child, folder.path);
      folder.folders.push(sub.path);
      count += sub.fileCount;
    }
    folder.fileCount = count;
    return folder;
  };
  add(root, null);
  return { folders, folderOfFile };
}

/** The display folders from the root down to `path`'s folder, root excluded. */
export function displayAncestors(tree: DiagramTree, path: string): string[] {
  const out: string[] = [];
  let folder = tree.folders.has(path) ? path : tree.folderOfFile.get(path);
  while (folder !== undefined && folder !== '') {
    out.push(folder);
    folder = tree.folders.get(folder)?.parent ?? undefined;
  }
  return out.reverse();
}

/**
 * The folders to open before the person has chosen, level by level: the
 * shallowest closed folder opens first (the biggest among equals) while what
 * shows stays within `budget` boxes, and one that would overflow stays shut.
 * A small project opens all the way; a monorepo opens onto its packages, few
 * enough to read at a glance, rather than into one deep corner.
 */
export function defaultDiagramExpansion(tree: DiagramTree, budget = 40): Set<string> {
  const open = new Set<string>();
  const tooBig = new Set<string>();
  const root = tree.folders.get('')!;
  const shown = (f: DiagramFolder): number => f.folders.length + f.files.length;
  let visible = shown(root);
  for (;;) {
    let best: DiagramFolder | null = null;
    let bestDepth = Number.POSITIVE_INFINITY;
    const consider = (f: DiagramFolder, depth: number): void => {
      for (const sub of f.folders) {
        const child = tree.folders.get(sub)!;
        if (open.has(sub)) {
          consider(child, depth + 1);
          continue;
        }
        if (tooBig.has(sub)) continue;
        const current: DiagramFolder | null = best;
        const better =
          !current ||
          depth < bestDepth ||
          (depth === bestDepth &&
            (child.fileCount > current.fileCount ||
              (child.fileCount === current.fileCount && child.path < current.path)));
        if (better) {
          best = child;
          bestDepth = depth;
        }
      }
    };
    consider(root, 0);
    const chosen = best as DiagramFolder | null;
    if (!chosen) break;
    if (visible - 1 + shown(chosen) > budget) {
      tooBig.add(chosen.path);
      continue;
    }
    open.add(chosen.path);
    visible += shown(chosen) - 1;
  }
  return open;
}
