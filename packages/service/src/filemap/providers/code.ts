import { type FileMapScope, type LayoutFileInput, fileUseOf } from '@bendyline/gezel';
import { fileEdgesAvailable } from '../../index-store/edges/refresh.js';
import type { IndexStore } from '../../index-store/index-store.js';
import { type ResolvedEdge, resolveImportEdges } from '../affinity.js';
import { isExcludedFromCodeMap } from '../sections.js';

/**
 * The `code` data provider: turns the per-project content index into the
 * domain-agnostic inputs the layout engine + map builder consume. Districts are
 * folders, a block's weight is its LoC, buildings are its symbols, and edges are
 * the resolved import graph. This is the one provider M1 ships; `docs`/`data`
 * providers slot in behind the same shape later.
 */

export interface CollectedSymbol {
  name: string;
  kind: string;
  lineStart: number;
  lineEnd: number;
}

export interface CollectedMap {
  domain: 'code';
  files: LayoutFileInput[];
  meta: Map<string, { lang: string | null; kind: string | null }>;
  symbolsByFile: Map<string, CollectedSymbol[]>;
  /** The import graph for the policy asked for. */
  edges: ResolvedEdge[];
  /** The same files' graph under another policy (to price an upgrade). */
  edgesForPolicy: (policy: number) => ResolvedEdge[];
}

/** Line-count ceiling for a data file's footprint. */
const MAX_FIELD_LOC = 800;

/**
 * `edgePolicy` picks the import graph (see `VillageDomainState.edgePolicy`):
 * 1 is the relative-imports-only resolution every village was founded on,
 * computed here exactly as it always was; 2 is the stored resolved graph,
 * limited to imports and includes between files on this map.
 */
export function collectCodeMap(
  index: IndexStore,
  scope: FileMapScope = 'core',
  ignoredPaths: ReadonlySet<string> = new Set(),
  edgePolicy = 1,
): CollectedMap {
  const files: LayoutFileInput[] = [];
  const meta = new Map<string, { lang: string | null; kind: string | null }>();
  // Policy 1 reads every code file's rows, mapped or not, as it always did;
  // documents' link rows are not imports.
  const codeSources = new Set<string>();
  for (const f of index.allFiles()) {
    if (f.kind === 'code') codeSources.add(f.path);
    if (f.trivial || f.modality === 'image') continue; // images aren't city blocks
    if (ignoredPaths.has(f.path)) continue; // workspace Git ignore policy
    if (isExcludedFromCodeMap(f.path, scope)) continue; // tests per scope
    // loc is the block size; estimate from bytes when we never line-counted it.
    const loc = f.loc ?? Math.max(1, Math.round((f.size ?? 0) / 40));
    // A data file is a field on the map, and a field is bounded: a 40k-line
    // fixture must read as a big field, not as the largest thing in town.
    const weight = fileUseOf(f.path, f.lang) === 'data' ? Math.min(loc, MAX_FIELD_LOC) : loc;
    files.push({ path: f.path, weight, contentHash: f.hash });
    meta.set(f.path, { lang: f.lang, kind: f.kind });
  }

  const paths = files.map((f) => f.path);
  const edgesForPolicy = (policy: number): ResolvedEdge[] => {
    if (policy >= 2 && fileEdgesAvailable(index)) return storedEdges(index, paths);
    return resolveImportEdges(
      paths,
      index.allImports().filter((r) => codeSources.has(r.srcPath)),
    );
  };
  const edges = edgesForPolicy(edgePolicy);

  const symbolsByFile = new Map<string, CollectedSymbol[]>();
  for (const s of index.allSymbols()) {
    if (!meta.has(s.filePath)) continue;
    const arr = symbolsByFile.get(s.filePath);
    const sym = { name: s.name, kind: s.kind, lineStart: s.lineStart, lineEnd: s.lineEnd };
    if (arr) arr.push(sym);
    else symbolsByFile.set(s.filePath, [sym]);
  }

  return { domain: 'code', files, meta, symbolsByFile, edges, edgesForPolicy };
}

/** Imports and includes between two files on this map, one edge per pair. */
function storedEdges(index: IndexStore, paths: readonly string[]): ResolvedEdge[] {
  const onMap = new Set(paths);
  const seen = new Set<string>();
  const out: ResolvedEdge[] = [];
  for (const e of index.fileEdges.all(['import', 'include'])) {
    if (!onMap.has(e.src) || !onMap.has(e.dst)) continue;
    const key = `${e.src}\u0000${e.dst}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ src: e.src, dst: e.dst });
  }
  return out;
}
