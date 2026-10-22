import type {
  FileGraphEdge,
  FileGraphNode,
  FileGraphResponse,
} from '../schemas/api/project-views.js';
import { redundantEdges, stronglyConnected } from './graph-algorithms.js';
import type { DiagramFolder, DiagramTree } from './tree.js';

/**
 * Shape a project's file graph into what a Diagram draws: closed folders as
 * single boxes, open folders as frames, file imports summed into one weighted
 * edge per pair of boxes. Pure and deterministic — the same graph and choices
 * always give the same nodes and edges in the same order, which is what lets
 * a layout keyed on them be reused.
 */

export interface DiagramFocus {
  /** The file at the center. */
  path: string;
  /** How many steps to follow what it imports, and what imports it. Default 1 each. */
  uses?: number;
  usedBy?: number;
  /** Most files shown. Default 120. */
  cap?: number;
}

export interface DiagramShapeOptions {
  /** Display folders the person opened (overview only). */
  expanded: ReadonlySet<string>;
  /** Show one file and its neighborhood instead of the whole project. */
  focus?: DiagramFocus | null;
  /** Drop an edge another path already implies. Default true. */
  hideShortcuts?: boolean;
  /** Leave out the incoming edges of a box nearly everything uses. Default true. */
  stubHubs?: boolean;
  /** Keep data, config and style files. Default false. */
  includeAssets?: boolean;
}

export interface DiagramNodeShape {
  /** The file path, or `folder:<path>`. */
  id: string;
  kind: 'file' | 'folder';
  path: string;
  label: string;
  /** Id of the open folder drawn around it; null at the top level. */
  parent: string | null;
  /** A folder drawn as a frame around its contents. */
  open: boolean;
  /** Files it stands for. */
  fileCount: number;
  file?: FileGraphNode;
  folder?: DiagramFolder;
  /** Its incoming edges were left out because nearly everything uses it. */
  hub: boolean;
  /** Boxes whose edges into this hub were left out. */
  stubbedIn: number;
  /** Focus mode: neighbors left outside the focus. */
  hiddenNeighbors: number;
  /** A file in a runtime import cycle, or a closed folder holding one. */
  inCycle: boolean;
}

export interface DiagramEdgeShape {
  id: string;
  source: string;
  target: string;
  /** File-to-file edges it carries. */
  weight: number;
  /** Every carried edge is `import type`. */
  typeOnly: boolean;
  /** Every carried edge is a lazy `import()`. */
  dynamic: boolean;
  /** Both boxes use each other; drawn with two arrowheads. */
  bidirectional: boolean;
  /** Carries an edge of a runtime import cycle. */
  cycle: boolean;
  /** Up to five of the file edges it carries. */
  sample: { source: string; target: string }[];
}

export interface ShapedDiagram {
  nodes: DiagramNodeShape[];
  edges: DiagramEdgeShape[];
  stats: {
    /** Files in scope, and how many show as their own box. */
    files: number;
    visibleFiles: number;
    /** File edges in scope, and how many fell inside one closed folder. */
    fileEdges: number;
    internalEdges: number;
    shortcutsHidden: number;
    hubs: string[];
    /** Runtime import cycles among files (two or more files each). */
    cycles: number;
  };
}

const ASSET_USES = new Set(['data', 'config', 'style']);
const SAMPLE = 5;

export function folderNodeId(path: string): string {
  return `folder:${path}`;
}

/** The box that stands for `path` (a file, or a display folder) under `expanded`. */
export function visibleIdForPath(
  tree: DiagramTree,
  expanded: ReadonlySet<string>,
  path: string,
): string {
  const start = tree.folders.has(path) ? path : tree.folderOfFile.get(path);
  if (start === undefined) return path;
  const chain: string[] = [];
  for (let f: string | null | undefined = start; f; f = tree.folders.get(f)?.parent) chain.push(f);
  for (let i = chain.length - 1; i >= 0; i--) {
    if (!expanded.has(chain[i]!)) return folderNodeId(chain[i]!);
  }
  return tree.folders.has(path) ? folderNodeId(path) : path;
}

export function shapeDiagram(
  graph: Pick<FileGraphResponse, 'nodes' | 'edges'>,
  tree: DiagramTree,
  options: DiagramShapeOptions,
): ShapedDiagram {
  const inScope = graph.nodes.filter(
    (n) => options.includeAssets || !n.use || !ASSET_USES.has(n.use),
  );
  const fileById = new Map(inScope.map((n) => [n.id, n]));
  const fileEdges = graph.edges.filter((e) => fileById.has(e.source) && fileById.has(e.target));

  // Runtime cycles among files: type-only imports vanish at compile time.
  const fileIndex = new Map(inScope.map((n, i) => [n.id, i]));
  const runtimeSucc: number[][] = inScope.map(() => []);
  for (const e of fileEdges) {
    if (!e.typeOnly) runtimeSucc[fileIndex.get(e.source)!]!.push(fileIndex.get(e.target)!);
  }
  const scc = stronglyConnected(inScope.length, runtimeSucc);
  const fileInCycle = (id: string): boolean => scc.size[scc.comp[fileIndex.get(id)!]!]! > 1;
  const edgeInCycle = (e: FileGraphEdge): boolean =>
    !e.typeOnly &&
    scc.comp[fileIndex.get(e.source)!] === scc.comp[fileIndex.get(e.target)!] &&
    fileInCycle(e.source);

  const focus = options.focus && fileById.has(options.focus.path) ? options.focus : null;
  const shown = focus ? focusSet(focus, fileEdges, fileById) : null;
  const isOpen = (path: string): boolean => focus !== null || options.expanded.has(path);

  // Files in scope at or below each display folder, for counts and for skipping empty folders.
  const scopedCount = new Map<string, number>();
  const countFolder = (path: string): number => {
    const f = tree.folders.get(path)!;
    let count = f.files.filter((id) => fileById.has(id) && (!shown || shown.has(id))).length;
    for (const sub of f.folders) count += countFolder(sub);
    scopedCount.set(path, count);
    return count;
  };
  countFolder('');

  const nodes: DiagramNodeShape[] = [];
  const repOf = new Map<string, string>();
  const folderHasCycle = new Map<string, boolean>();
  const blank = { hub: false, stubbedIn: 0, hiddenNeighbors: 0 };
  const visit = (path: string, parent: string | null): void => {
    const folder = tree.folders.get(path)!;
    for (const sub of folder.folders) {
      if ((scopedCount.get(sub) ?? 0) === 0) continue;
      const child = tree.folders.get(sub)!;
      const id = folderNodeId(sub);
      const open = isOpen(sub);
      nodes.push({
        id,
        kind: 'folder',
        path: sub,
        label: child.label,
        parent,
        open,
        fileCount: scopedCount.get(sub)!,
        folder: child,
        ...blank,
        inCycle: false,
      });
      if (open) {
        visit(sub, id);
      } else {
        const stack = [sub];
        while (stack.length > 0) {
          const f = tree.folders.get(stack.pop()!)!;
          for (const file of f.files) if (fileById.has(file)) repOf.set(file, id);
          stack.push(...f.folders);
        }
      }
    }
    for (const file of folder.files) {
      const node = fileById.get(file);
      if (!node || (shown && !shown.has(file))) continue;
      repOf.set(file, file);
      nodes.push({
        id: file,
        kind: 'file',
        path: file,
        label: file.slice(file.lastIndexOf('/') + 1),
        parent,
        open: false,
        fileCount: 1,
        file: node,
        ...blank,
        inCycle: fileInCycle(file),
      });
    }
  };
  visit('', null);

  // Sum file edges into one edge per ordered pair of boxes.
  const byPair = new Map<string, DiagramEdgeShape>();
  let internalEdges = 0;
  for (const e of fileEdges) {
    const s = repOf.get(e.source);
    const t = repOf.get(e.target);
    if (s === undefined || t === undefined) continue;
    const cycle = edgeInCycle(e);
    if (s === t) {
      internalEdges++;
      if (cycle) folderHasCycle.set(s, true);
      continue;
    }
    const key = `${s}\u0000${t}`;
    let acc = byPair.get(key);
    if (!acc) {
      acc = {
        id: '',
        source: s,
        target: t,
        weight: 0,
        typeOnly: true,
        dynamic: true,
        bidirectional: false,
        cycle: false,
        sample: [],
      };
      byPair.set(key, acc);
    }
    acc.weight++;
    acc.typeOnly &&= e.typeOnly;
    acc.dynamic &&= e.dynamic;
    acc.cycle ||= cycle;
    if (acc.sample.length < SAMPLE) acc.sample.push({ source: e.source, target: e.target });
  }

  // Two boxes that use each other become one two-way edge, drawn the heavier way.
  const edges: DiagramEdgeShape[] = [];
  for (const [key, acc] of byPair) {
    const reverseKey = `${acc.target}\u0000${acc.source}`;
    const reverse = byPair.get(reverseKey);
    if (reverse) {
      const keep =
        acc.weight > reverse.weight || (acc.weight === reverse.weight && key < reverseKey);
      if (!keep) continue;
      acc.weight += reverse.weight;
      acc.typeOnly &&= reverse.typeOnly;
      acc.dynamic &&= reverse.dynamic;
      acc.cycle ||= reverse.cycle;
      acc.bidirectional = true;
      acc.sample = [...acc.sample, ...reverse.sample].slice(0, SAMPLE);
    }
    edges.push(acc);
  }

  for (const node of nodes) {
    if (node.kind === 'folder' && !node.open) node.inCycle = folderHasCycle.get(node.id) === true;
  }

  // A box nearly everything uses would draw a fan of lines into one place.
  const hubs: string[] = [];
  let kept = edges;
  if (options.stubHubs !== false && !focus) {
    const into = new Map<string, Set<string>>();
    for (const e of edges) {
      if (e.bidirectional) continue;
      let set = into.get(e.target);
      if (!set) {
        set = new Set();
        into.set(e.target, set);
      }
      set.add(e.source);
    }
    const threshold = Math.max(12, Math.ceil(nodes.length * 0.08));
    const hubIds = new Set(
      [...into].filter(([, from]) => from.size >= threshold).map(([id]) => id),
    );
    if (hubIds.size > 0) {
      for (const node of nodes) {
        if (!hubIds.has(node.id)) continue;
        node.hub = true;
        node.stubbedIn = into.get(node.id)!.size;
        hubs.push(node.id);
      }
      kept = edges.filter((e) => e.bidirectional || !hubIds.has(e.target));
    }
  }

  let shortcutsHidden = 0;
  if (options.hideShortcuts !== false && nodes.length <= 6000) {
    const at = new Map(nodes.map((n, i) => [n.id, i]));
    const redundant = redundantEdges(
      nodes.length,
      kept.map((e) => [at.get(e.source)!, at.get(e.target)!] as const),
    );
    const before = kept.length;
    // In focus, every line into or out of the focus file stays: its direct
    // neighbors are what the person asked to see.
    const center = focus?.path;
    kept = kept.filter(
      (e, k) =>
        !redundant[k] || e.bidirectional || e.cycle || e.source === center || e.target === center,
    );
    shortcutsHidden = before - kept.length;
  }

  if (shown) {
    for (const node of nodes) {
      if (node.kind !== 'file') continue;
      let hidden = 0;
      for (const e of fileEdges) {
        if (e.source === node.id && !shown.has(e.target)) hidden++;
        else if (e.target === node.id && !shown.has(e.source)) hidden++;
      }
      node.hiddenNeighbors = hidden;
    }
  }

  kept.sort((a, b) => cmp(a.source, b.source) || cmp(a.target, b.target));
  for (const e of kept) e.id = `${e.source}>${e.target}`;
  return {
    nodes,
    edges: kept,
    stats: {
      files: inScope.length,
      visibleFiles: nodes.filter((n) => n.kind === 'file').length,
      fileEdges: fileEdges.length,
      internalEdges,
      shortcutsHidden,
      hubs,
      cycles: scc.size.filter((s) => s > 1).length,
    },
  };
}

/** The focus file and its neighborhood, nearest first, busiest first within a step. */
function focusSet(
  focus: DiagramFocus,
  edges: readonly FileGraphEdge[],
  files: ReadonlyMap<string, FileGraphNode>,
): Set<string> {
  const cap = Math.max(1, focus.cap ?? 120);
  const out = new Map<string, string[]>();
  const into = new Map<string, string[]>();
  for (const e of edges) {
    (out.get(e.source) ?? out.set(e.source, []).get(e.source)!).push(e.target);
    (into.get(e.target) ?? into.set(e.target, []).get(e.target)!).push(e.source);
  }
  const chosen = new Set([focus.path]);
  const walk = (adjacency: Map<string, string[]>, depth: number): void => {
    let frontier = [focus.path];
    for (let step = 0; step < depth && frontier.length > 0 && chosen.size < cap; step++) {
      const next = new Set<string>();
      for (const id of frontier)
        for (const n of adjacency.get(id) ?? []) if (!chosen.has(n)) next.add(n);
      const ranked = [...next].sort(
        (a, b) => (files.get(b)?.importance ?? 0) - (files.get(a)?.importance ?? 0) || cmp(a, b),
      );
      frontier = [];
      for (const id of ranked) {
        if (chosen.size >= cap) break;
        chosen.add(id);
        frontier.push(id);
      }
    }
  };
  walk(out, Math.max(0, focus.uses ?? 1));
  walk(into, Math.max(0, focus.usedBy ?? 1));
  return chosen;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
