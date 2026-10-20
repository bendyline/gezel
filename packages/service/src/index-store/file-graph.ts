import { createHash } from 'node:crypto';
import {
  type FileGraphEdge,
  type FileGraphFolder,
  type FileGraphNode,
  type FileGraphRequest,
  type FileGraphResponse,
  fileUseOf,
  nowIso,
  summaryLead,
} from '@bendyline/gezel';
import { normalizeSeverity } from '../filemap/health.js';
import { isTestFile } from '../filemap/sections.js';
import { computeFileSignals } from '../filemap/signals.js';
import { packageNameOf } from '../security/scan.js';
import { codeDependencyEdges } from './edges/readers.js';
import { EDGES_PARTIAL_META, fileEdgeCoverage, fileEdgesAvailable } from './edges/refresh.js';
import { type FileEdge, IMPORT_FLAG } from './index-store-types.js';
import type { IndexStore } from './index-store.js';
import { mergeImportFlags } from './symbols.js';

const DEFAULT_MAX_NODES = 500;
const MAX_NAMES = 8;
const MAX_EXTERNALS = 5000;
const LEAD_CHARS = 160;
const JS_LANGS = new Set(['typescript', 'tsx', 'javascript', 'jsx', 'vue', 'svelte']);

/**
 * The project's dependency graph, shaped for a diagram: which files depend on
 * which, how central each one is, and what the folders around them are for.
 * Reads the stored graph (`file_edges`); before the index has resolved one it
 * falls back to relative imports and says so (`resolved: false`). Never
 * writes anything — unlike `fileMap`, this is a pure read.
 */
export function buildFileGraph(
  index: IndexStore,
  req: FileGraphRequest,
  ctx: {
    ignoredPaths?: ReadonlySet<string>;
    /** Folders holding a package manifest, by the name the manifest gives. */
    packageRoots?: ReadonlyArray<{ folder: string; name: string }>;
  } = {},
): FileGraphResponse {
  const kind = req.kind ?? 'code';
  const scope = req.scope ?? 'core';
  const max = req.max ?? DEFAULT_MAX_NODES;
  const ignored = ctx.ignoredPaths ?? new Set<string>();
  const resolved = fileEdgesAvailable(index);
  const edgeKinds: FileEdge['kind'][] =
    kind === 'code'
      ? ['import', 'include']
      : kind === 'docs'
        ? ['link']
        : ['import', 'include', 'link'];

  const fileRecs = index.allFiles().filter((f) => !f.trivial && !ignored.has(f.path));
  const byPath = new Map(fileRecs.map((f) => [f.path, f]));
  const inScope = (path: string): boolean => {
    const test = isTestFile(path);
    return scope === 'all' || (scope === 'tests' ? test : !test);
  };

  // Every edge between two files this graph shows, merged per pair.
  const raw = resolved
    ? index.fileEdges.all(edgeKinds)
    : kind === 'docs'
      ? []
      : codeDependencyEdges(index).map(
          (e): FileEdge => ({
            ...e,
            raw: '',
            kind: 'import',
            resolver: 'relative',
            bindings: null,
            flags: 0,
          }),
        );
  const isNodeFile = (path: string): boolean => {
    const f = byPath.get(path);
    if (!f || !inScope(path)) return false;
    if (kind === 'code') return f.kind === 'code';
    return true;
  };
  const merged = new Map<string, { edge: FileGraphEdge; names: Set<string>; flags: number }>();
  for (const e of raw) {
    if (!isNodeFile(e.src) || !isNodeFile(e.dst) || e.src === e.dst) continue;
    const key = `${e.src}\u0000${e.dst}`;
    const names = (e.bindings ?? []).filter((b) => b.kind === 'named').map((b) => b.name);
    const prev = merged.get(key);
    if (prev) {
      for (const n of names) prev.names.add(n);
      prev.flags = mergeImportFlags(prev.flags, e.flags);
      continue;
    }
    merged.set(key, {
      edge: {
        source: e.src,
        target: e.dst,
        kind: e.kind,
        names: [],
        nameCount: 0,
        typeOnly: false,
        dynamic: false,
        reexport: false,
      },
      names: new Set(names),
      flags: e.flags,
    });
  }
  const allEdges: FileGraphEdge[] = [...merged.values()].map(({ edge, names, flags }) => ({
    ...edge,
    names: [...names].sort().slice(0, MAX_NAMES),
    nameCount: names.size,
    typeOnly: (flags & IMPORT_FLAG.typeOnly) !== 0,
    dynamic: (flags & IMPORT_FLAG.dynamic) !== 0,
    reexport: (flags & IMPORT_FLAG.reexport) !== 0,
  }));

  // Nodes: for code, every code file in scope; for documents, the files a
  // link touches (a document with no links is not part of a link graph).
  let nodePaths: string[];
  if (kind === 'code') {
    nodePaths = fileRecs.filter((f) => isNodeFile(f.path)).map((f) => f.path);
  } else {
    const touched = new Set<string>();
    for (const e of allEdges) {
      touched.add(e.source);
      touched.add(e.target);
    }
    if (kind === 'all') {
      for (const f of fileRecs) if (f.kind === 'code' && inScope(f.path)) touched.add(f.path);
    }
    nodePaths = [...touched];
  }
  nodePaths.sort();

  const symbolCounts = new Map<string, number>();
  for (const s of index.allSymbols())
    symbolCounts.set(s.filePath, (symbolCounts.get(s.filePath) ?? 0) + 1);
  const locOf = (path: string): number => {
    const f = byPath.get(path);
    return f?.loc ?? Math.max(1, Math.round((f?.size ?? 0) / 40));
  };
  const signals = computeFileSignals(index, {
    files: nodePaths.map((path) => ({ path, weight: locOf(path) })),
    edges: allEdges.map((e) => ({ src: e.source, dst: e.target })),
    symbolCount: (path) => symbolCounts.get(path) ?? 0,
  });

  // The cap keeps the most central files, plus the focus and its neighborhood.
  let kept = nodePaths;
  if (nodePaths.length > max || req.focus) {
    const keep = new Set<string>();
    if (req.focus && byPath.has(req.focus)) {
      for (const p of neighborhood(allEdges, req.focus, req.hops ?? 1)) keep.add(p);
    }
    if (nodePaths.length > max) {
      const ranked = [...nodePaths].sort(
        (a, b) =>
          (signals.importance.get(b) ?? 0) - (signals.importance.get(a) ?? 0) ||
          (signals.fanIn.get(b) ?? 0) - (signals.fanIn.get(a) ?? 0) ||
          (a < b ? -1 : a > b ? 1 : 0),
      );
      // The focus neighborhood stays whole even when it alone passes the cap.
      for (const p of ranked) {
        if (keep.size >= max) break;
        keep.add(p);
      }
    } else {
      for (const p of nodePaths) keep.add(p);
    }
    kept = nodePaths.filter((p) => keep.has(p));
  }
  const keptSet = new Set(kept);
  const edges = allEdges.filter((e) => keptSet.has(e.source) && keptSet.has(e.target));

  const leads = new Map<string, string>();
  for (const row of index.fileSummaries()) {
    if (keptSet.has(row.path)) leads.set(row.path, summaryLead(row.summaryMd, LEAD_CHARS));
  }
  const findings = index.securityFindingCountsByFile();
  const nodes: FileGraphNode[] = kept.map((path) => {
    const f = byPath.get(path)!;
    const found = findings.get(path);
    const lead = leads.get(path);
    return {
      id: path,
      label: path.slice(path.lastIndexOf('/') + 1),
      folder: folderOf(path),
      lang: f.lang,
      modality: f.modality,
      use:
        f.kind === 'code' || f.kind === 'config' || f.kind === 'data'
          ? fileUseOf(path, f.lang)
          : null,
      test: isTestFile(path),
      loc: locOf(path),
      fanIn: signals.fanIn.get(path) ?? 0,
      fanOut: signals.fanOut.get(path) ?? 0,
      importance: signals.importance.get(path) ?? 0,
      findings: found?.count ?? 0,
      maxSeverity: normalizeSeverity(found?.maxSeverity),
      ...(signals.gitAvailable ? { churn: signals.churnOf(path) } : {}),
      ...(lead ? { lead } : {}),
    };
  });

  return {
    indexed: fileRecs.length > 0,
    builtAt: nowIso(),
    kind,
    scope,
    resolved,
    partial: index.getMeta(EDGES_PARTIAL_META) === '1',
    nodes,
    edges,
    externals: kind === 'docs' ? [] : externalsOf(index, keptSet, byPath, resolved),
    folders: foldersOf(kept, index),
    packageRoots: (ctx.packageRoots ?? []).filter((r) =>
      kept.some((p) => r.folder === '' || p === r.folder || p.startsWith(`${r.folder}/`)),
    ),
    coverage: fileEdgeCoverage(index) ?? {},
    signature: signatureOf(nodes, edges),
    truncated:
      kept.length < nodePaths.length
        ? { nodes: nodePaths.length - kept.length, edges: allEdges.length - edges.length }
        : null,
  };
}

/** A file and everything within `hops` of it, along edges in either direction. */
function neighborhood(edges: readonly FileGraphEdge[], focus: string, hops: number): Set<string> {
  const adj = new Map<string, string[]>();
  const link = (a: string, b: string) => {
    const list = adj.get(a);
    if (list) list.push(b);
    else adj.set(a, [b]);
  };
  for (const e of edges) {
    link(e.source, e.target);
    link(e.target, e.source);
  }
  const seen = new Set([focus]);
  let frontier = [focus];
  for (let d = 0; d < hops && frontier.length > 0; d++) {
    const next: string[] = [];
    for (const p of frontier) {
      for (const q of adj.get(p) ?? []) {
        if (seen.has(q)) continue;
        seen.add(q);
        next.push(q);
      }
    }
    frontier = next;
  }
  return seen;
}

/** Every folder that holds a node, with its parent and file count. */
function foldersOf(paths: readonly string[], index: IndexStore): FileGraphFolder[] {
  const counts = new Map<string, number>();
  for (const p of paths) {
    let dir = folderOf(p);
    while (dir) {
      counts.set(dir, (counts.get(dir) ?? 0) + 1);
      dir = folderOf(dir);
    }
  }
  const purposes = new Map(index.allAreaSummaries().map((a) => [a.areaPath, a.summaryMd]));
  return [...counts.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, fileCount]) => {
      const purpose = purposes.get(path);
      const parent = folderOf(path);
      return {
        path,
        parent: parent || null,
        fileCount,
        ...(purpose ? { purpose: summaryLead(purpose, LEAD_CHARS) } : {}),
      };
    });
}

/** Packages a kept JS/TS file imports from outside the project. */
function externalsOf(
  index: IndexStore,
  kept: ReadonlySet<string>,
  byPath: ReadonlyMap<string, { lang: string | null }>,
  resolved: boolean,
): Array<{ from: string; pkg: string }> {
  const resolvedRaws = new Set<string>();
  if (resolved) for (const e of index.fileEdges.all()) resolvedRaws.add(`${e.src}\u0000${e.raw}`);
  const seen = new Set<string>();
  const out: Array<{ from: string; pkg: string }> = [];
  for (const row of index.fileEdges.importRows()) {
    if (out.length >= MAX_EXTERNALS) break;
    if (!kept.has(row.srcPath) || !JS_LANGS.has(byPath.get(row.srcPath)?.lang ?? '')) continue;
    if (resolvedRaws.has(`${row.srcPath}\u0000${row.raw}`)) continue;
    const pkg = row.raw.startsWith('node:') ? 'node' : packageNameOf(row.raw);
    if (!pkg) continue;
    const key = `${row.srcPath}\u0000${pkg}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ from: row.srcPath, pkg });
  }
  return out;
}

function signatureOf(nodes: readonly FileGraphNode[], edges: readonly FileGraphEdge[]): string {
  const h = createHash('sha256');
  for (const n of nodes) h.update(`${n.id}\u0001`);
  h.update('\u0002');
  for (const e of edges) {
    h.update(
      `${e.source}\u0000${e.target}\u0000${e.kind}\u0000${e.typeOnly ? 1 : 0}${e.dynamic ? 1 : 0}${e.reexport ? 1 : 0}\u0001`,
    );
  }
  return h.digest('hex').slice(0, 32);
}

function folderOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}
