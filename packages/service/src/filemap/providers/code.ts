import type { FileMapScope, LayoutFileInput } from '@bendyline/gezel';
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
  edges: ResolvedEdge[];
}

export function collectCodeMap(
  index: IndexStore,
  scope: FileMapScope = 'core',
  ignoredPaths: ReadonlySet<string> = new Set(),
): CollectedMap {
  const files: LayoutFileInput[] = [];
  const meta = new Map<string, { lang: string | null; kind: string | null }>();
  for (const f of index.allFiles()) {
    if (f.trivial || f.modality === 'image') continue; // images aren't city blocks
    if (ignoredPaths.has(f.path)) continue; // workspace Git ignore policy
    if (isExcludedFromCodeMap(f.path, scope)) continue; // JSON always; tests per scope
    // loc is the block size; estimate from bytes when we never line-counted it.
    const loc = f.loc ?? Math.max(1, Math.round((f.size ?? 0) / 40));
    files.push({ path: f.path, weight: loc, contentHash: f.hash });
    meta.set(f.path, { lang: f.lang, kind: f.kind });
  }

  const edges = resolveImportEdges(
    files.map((f) => f.path),
    index.allImports(),
  );

  const symbolsByFile = new Map<string, CollectedSymbol[]>();
  for (const s of index.allSymbols()) {
    if (!meta.has(s.filePath)) continue;
    const arr = symbolsByFile.get(s.filePath);
    const sym = { name: s.name, kind: s.kind, lineStart: s.lineStart, lineEnd: s.lineEnd };
    if (arr) arr.push(sym);
    else symbolsByFile.set(s.filePath, [sym]);
  }

  return { domain: 'code', files, meta, symbolsByFile, edges };
}
