import type { Rect } from '../schemas/api.js';
import type { LayoutFileInput } from './types.js';

/**
 * Display districts and their label plates. The v2 map labeled every folder
 * prefix at its rect corner, so pass-through chains (`packages/x/src` where
 * each level has one child and no files) painted three near-coincident labels
 * — the single worst legibility bug on the old map. Here the chain collapses
 * structurally into ONE display district labeled once (`x/src`), and every
 * display district reserves a real plate rect the renderer draws into.
 */

/** Reserved label headroom inside a folder box (world units). Must stay under
 *  the street router's BRIDGE distance (20) minus the deepest folder pad, so
 *  district interiors remain routable: max folderPad (5) + PLATE_H < 20. */
export const PLATE_H = 11;
/** Approximate world-units per label character for plate sizing. */
export const PLATE_CHAR_W = 4.2;

export interface FileTreeNode {
  path: string;
  children: Map<string, FileTreeNode>;
  files: LayoutFileInput[];
  weight: number;
}

export function buildFileTree(files: LayoutFileInput[]): FileTreeNode {
  const root: FileTreeNode = { path: '', children: new Map(), files: [], weight: 0 };
  for (const f of files) {
    const segs = f.path.split('/');
    let node = root;
    for (let i = 0; i < segs.length - 1; i++) {
      const folderPath = segs.slice(0, i + 1).join('/');
      let child = node.children.get(segs[i]!);
      if (!child) {
        child = { path: folderPath, children: new Map(), files: [], weight: 0 };
        node.children.set(segs[i]!, child);
      }
      node = child;
    }
    node.files.push(f);
  }
  const computeWeight = (n: FileTreeNode): number => {
    let w = 0;
    for (const f of n.files) w += Math.max(1, f.weight);
    for (const c of n.children.values()) w += computeWeight(c);
    n.weight = w;
    return w;
  };
  computeWeight(root);
  return root;
}

/** A folder tree with pass-through chains folded into single display nodes. */
export interface CollapsedNode {
  /** Full folder path ('' at the root, which is never itself collapsed). */
  path: string;
  /** Label relative to the parent display node (e.g. 'x/src'). '' at root. */
  label: string;
  children: CollapsedNode[];
  files: LayoutFileInput[];
  weight: number;
}

function collapseNode(node: FileTreeNode, parentDisplayPath: string): CollapsedNode {
  let cur = node;
  while (cur.children.size === 1 && cur.files.length === 0) {
    cur = cur.children.values().next().value!;
  }
  const label = parentDisplayPath === '' ? cur.path : cur.path.slice(parentDisplayPath.length + 1);
  return {
    path: cur.path,
    label,
    children: [...cur.children.values()]
      .sort((a, b) => (a.path < b.path ? -1 : 1))
      .map((c) => collapseNode(c, cur.path)),
    files: cur.files,
    weight: cur.weight,
  };
}

/** Collapse a file set into a display tree. The root stays the root. */
export function collapseFiles(files: LayoutFileInput[]): CollapsedNode {
  const root = buildFileTree(files);
  return {
    path: '',
    label: '',
    children: [...root.children.values()]
      .sort((a, b) => (a.path < b.path ? -1 : 1))
      .map((c) => collapseNode(c, '')),
    files: root.files,
    weight: root.weight,
  };
}

/** folder path → display label, for every display district in the live tree.
 *  Folders absent from this map (interior links of a collapsed chain, and the
 *  root) must not be labeled at all. */
export function displayLabels(files: LayoutFileInput[]): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (node: CollapsedNode): void => {
    if (node.path !== '') out.set(node.path, node.label);
    for (const c of node.children) walk(c);
  };
  walk(collapseFiles(files));
  return out;
}

/** The plate rect for a label at a district's interior top-left. */
export function plateRectFor(label: string, x: number, y: number, availW: number): Rect {
  return {
    x,
    y,
    w: Math.max(8, Math.min(availW, PLATE_CHAR_W * label.length + 8)),
    h: PLATE_H,
  };
}
