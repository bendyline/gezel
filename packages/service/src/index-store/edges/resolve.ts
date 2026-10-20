import type { FileEdge } from '../index-store-types.js';
import { type ResolveContext, buildResolveContext } from './context.js';
import { resolveJsImport } from './js.js';
import { resolvePythonImport } from './python.js';
import {
  resolveCInclude,
  resolveGoImport,
  resolveMarkdownLink,
  resolveRustImport,
} from './systems.js';
import type {
  EdgeCoverage,
  EdgeFile,
  ProjectConfigFiles,
  RawImport,
  Resolution,
  ResolvedGraph,
} from './types.js';

/**
 * Bump when any resolver's answers change, so every project's stored graph
 * is rebuilt once. 1: relative, ts-paths, workspace, py-rel, py-abs, go-mod,
 * rust, c-include, md-link.
 */
export const EDGE_RESOLVER_VERSION = 1;

const JS_LANGS = new Set(['typescript', 'tsx', 'javascript', 'jsx', 'vue', 'svelte']);

/**
 * Resolve every raw import row to the project files it names. Pure: the file
 * set, the rows, and the manifests in; the graph and per-language coverage
 * out. Rows whose specifier names nothing in the project (npm packages, the
 * standard library) simply produce no edge.
 */
export function resolveFileEdges(input: {
  files: readonly EdgeFile[];
  imports: readonly RawImport[];
  configs: ProjectConfigFiles;
}): ResolvedGraph {
  const ctx = buildResolveContext(input.files, input.configs);
  const langOf = new Map(input.files.map((f) => [f.path, f.lang]));
  const edges: FileEdge[] = [];
  const seen = new Set<string>();
  const coverage: Record<string, EdgeCoverage> = {};
  const withImports = new Set<string>();
  const withEdges = new Set<string>();

  // Coverage is about what can import: code and documents, not config or styles.
  for (const f of input.files) {
    if (!f.lang || (f.kind !== 'code' && f.kind !== 'markdown')) continue;
    coverage[f.lang] ??= { files: 0, filesWithImports: 0, filesWithEdges: 0, edges: 0 };
    coverage[f.lang]!.files++;
  }

  for (const row of input.imports) {
    const lang = langOf.get(row.srcPath);
    if (lang === undefined) continue; // the importer is no longer indexed
    withImports.add(row.srcPath);
    const resolution = resolveOne(ctx, lang, row);
    if (!resolution) continue;
    const kind = edgeKindFor(lang);
    for (const dst of resolution.dsts) {
      if (dst === row.srcPath) continue;
      const key = `${row.srcPath}\u0000${dst}\u0000${row.raw}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({
        src: row.srcPath,
        dst,
        raw: row.raw,
        kind,
        resolver: resolution.resolver,
        bindings: row.bindings,
        flags: row.flags,
      });
      withEdges.add(row.srcPath);
      if (lang) coverage[lang]!.edges++;
    }
  }
  for (const path of withImports) {
    const lang = langOf.get(path);
    if (lang && coverage[lang]) coverage[lang]!.filesWithImports++;
  }
  for (const path of withEdges) {
    const lang = langOf.get(path);
    if (lang && coverage[lang]) coverage[lang]!.filesWithEdges++;
  }
  // Code-unit order, as SQLite's ORDER BY gives it: the same graph on every machine.
  edges.sort(
    (a, b) => byCodeUnit(a.src, b.src) || byCodeUnit(a.dst, b.dst) || byCodeUnit(a.raw, b.raw),
  );
  return { edges, coverage };
}

function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function resolveOne(ctx: ResolveContext, lang: string | null, row: RawImport): Resolution | null {
  if (lang && JS_LANGS.has(lang)) return resolveJsImport(ctx, row.srcPath, row.raw);
  switch (lang) {
    case 'python':
      return resolvePythonImport(ctx, row.srcPath, row.raw, row.bindings);
    case 'go':
      return resolveGoImport(ctx, row.raw);
    case 'rust':
      return resolveRustImport(ctx, row.srcPath, row.raw);
    case 'c':
    case 'cpp':
      return resolveCInclude(ctx, row.srcPath, row.raw);
    case 'markdown':
      return resolveMarkdownLink(ctx, row.srcPath, row.raw);
    default:
      // Languages without a resolver of their own keep the Village's rule:
      // a relative specifier, probed beside the importer.
      return row.raw.startsWith('.') ? resolveJsImport(ctx, row.srcPath, row.raw) : null;
  }
}

export function edgeKindFor(lang: string | null): FileEdge['kind'] {
  if (lang === 'markdown') return 'link';
  if (lang === 'c' || lang === 'cpp') return 'include';
  return 'import';
}
