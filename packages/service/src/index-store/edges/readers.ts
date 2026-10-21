import {
  type ResolvedEdge,
  type ResolvedEdgeDetailed,
  resolveImportEdges,
  resolveImportEdgesDetailed,
  resolveSpecifier,
} from '../../filemap/affinity.js';
import type { FileEdge } from '../index-store-types.js';
import type { IndexStore } from '../index-store.js';
import { fileEdgesAvailable } from './refresh.js';

/** Code dependencies, as opposed to a document's links. */
const CODE_KINDS: readonly FileEdge['kind'][] = ['import', 'include'];

/**
 * Who imports a file, one row per importer with its bindings merged across
 * the specifiers it used. Reads the stored graph; before the first resolution
 * has run, falls back to resolving relative imports the old way.
 */
export function importersOf(index: IndexStore, path: string): ResolvedEdgeDetailed[] {
  if (!fileEdgesAvailable(index)) {
    return resolveImportEdgesDetailed(index.allFilePaths(), index.allImportsWithBindings()).filter(
      (e) => e.dst === path,
    );
  }
  const bySrc = new Map<string, ResolvedEdgeDetailed>();
  for (const e of index.fileEdges.to(path, CODE_KINDS)) {
    const prev = bySrc.get(e.src);
    if (!prev) {
      bySrc.set(e.src, { src: e.src, dst: e.dst, bindings: e.bindings ? [...e.bindings] : null });
      continue;
    }
    if (prev.bindings === null || e.bindings === null) {
      prev.bindings = null;
      continue;
    }
    for (const b of e.bindings) {
      if (
        !prev.bindings.some((p) => p.kind === b.kind && p.name === b.name && p.local === b.local)
      ) {
        prev.bindings.push(b);
      }
    }
  }
  return [...bySrc.values()];
}

/** For one file: which project file each of its specifiers names (null = outside). */
export function specifierResolver(index: IndexStore, path: string): (raw: string) => string | null {
  if (!fileEdgesAvailable(index)) {
    const pathSet = new Set(index.allFilePaths());
    return (raw) => resolveSpecifier(path, raw, pathSet);
  }
  const byRaw = new Map<string, string>();
  for (const e of index.fileEdges.from(path)) if (!byRaw.has(e.raw)) byRaw.set(e.raw, e.dst);
  return (raw) => byRaw.get(raw) ?? null;
}

/** The whole code dependency graph, one edge per (importer, imported) pair. */
export function codeDependencyEdges(index: IndexStore): ResolvedEdge[] {
  if (!fileEdgesAvailable(index)) {
    return resolveImportEdges(
      index.allFilePaths(),
      index.allImports().map((i) => ({ srcPath: i.srcPath, raw: i.raw })),
    );
  }
  const seen = new Set<string>();
  const out: ResolvedEdge[] = [];
  for (const e of index.fileEdges.all(CODE_KINDS)) {
    const key = `${e.src}\u0000${e.dst}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ src: e.src, dst: e.dst });
  }
  return out;
}
