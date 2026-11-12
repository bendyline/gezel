/**
 * Write `dist/route-graph.json`: for the shell and for each top-level
 * destination, the chunks that must load before it can render, with raw and
 * gzip sizes, and the largest modules inside each chunk.
 *
 * The startup budget (scripts/check-ui-startup-budget.mjs) measures only what
 * index.html loads eagerly. A destination's *blocking* graph is everything
 * its module statically imports that the shell has not already loaded: the
 * bytes a person waits for between clicking a destination and seeing it.
 * That is where a stray static import of an editor or a renderer hides, so it
 * is reported per destination, and `chain` names the import path that pulled
 * each chunk in.
 */
import { gzipSync } from 'node:zlib';
import type { Plugin } from 'vite';

/** Top-level destinations are the lazy view modules directly under src/views/. */
const DESTINATION_MODULE = /[\\/]src[\\/]views[\\/]([^\\/]+)\.tsx$/;
const TOP_MODULES_PER_CHUNK = 12;

interface ChunkLike {
  type: 'chunk';
  fileName: string;
  code: string;
  isEntry: boolean;
  isDynamicEntry: boolean;
  facadeModuleId: string | null;
  imports: string[];
  dynamicImports: string[];
  modules: Record<string, { renderedLength: number }>;
  viteMetadata?: { importedCss?: Set<string> };
}

interface AssetLike {
  type: 'asset';
  fileName: string;
  source: string | Uint8Array;
}

type BundleItem = ChunkLike | AssetLike;

export interface RouteGraphEntry {
  /** Chunks (JS) in the closure, beyond the shell for a destination. */
  files: number;
  rawBytes: number;
  gzipBytes: number;
  cssFiles: number;
  cssRawBytes: number;
  cssGzipBytes: number;
  /** Each chunk in the closure, largest first, with the chunk that imported it. */
  chunks: { file: string; rawBytes: number; gzipBytes: number; via: string | null }[];
}

export interface RouteGraph {
  shell: RouteGraphEntry;
  /** Destination name (the view file's basename) to what it adds beyond the shell. */
  destinations: Record<string, RouteGraphEntry>;
  /** Largest modules per chunk file, for "why is this chunk so big". */
  modules: Record<string, { id: string; bytes: number }[]>;
}

function staticClosure(
  start: string,
  bundle: Record<string, BundleItem>,
): Map<string, string | null> {
  const via = new Map<string, string | null>([[start, null]]);
  const queue = [start];
  while (queue.length > 0) {
    const file = queue.shift()!;
    const chunk = bundle[file];
    if (chunk?.type !== 'chunk') continue;
    for (const next of chunk.imports) {
      if (via.has(next)) continue;
      via.set(next, file);
      queue.push(next);
    }
  }
  return via;
}

function shortModuleId(id: string): string {
  const normalized = id.replace(/\\/g, '/');
  const nodeModules = normalized.lastIndexOf('/node_modules/');
  if (nodeModules >= 0) return normalized.slice(nodeModules + '/node_modules/'.length);
  const src = normalized.lastIndexOf('/packages/');
  return src >= 0 ? normalized.slice(src + 1) : normalized;
}

export function buildRouteGraph(bundle: Record<string, BundleItem>): RouteGraph {
  const sizes = new Map<string, { raw: number; gzip: number }>();
  const sizeOf = (file: string) => {
    let size = sizes.get(file);
    if (size) return size;
    const item = bundle[file];
    const bytes =
      item?.type === 'chunk'
        ? Buffer.from(item.code)
        : item?.type === 'asset'
          ? Buffer.from(item.source)
          : Buffer.alloc(0);
    size = { raw: bytes.byteLength, gzip: gzipSync(bytes).byteLength };
    sizes.set(file, size);
    return size;
  };

  const entryOf = (closure: Map<string, string | null>, exclude: Set<string>): RouteGraphEntry => {
    const chunks: RouteGraphEntry['chunks'] = [];
    const css = new Set<string>();
    for (const [file, parent] of closure) {
      if (exclude.has(file)) continue;
      const size = sizeOf(file);
      chunks.push({ file, rawBytes: size.raw, gzipBytes: size.gzip, via: parent });
      const item = bundle[file];
      if (item?.type === 'chunk') {
        for (const sheet of item.viteMetadata?.importedCss ?? []) css.add(sheet);
      }
    }
    chunks.sort((a, b) => b.rawBytes - a.rawBytes);
    const cssSizes = [...css].map(sizeOf);
    return {
      files: chunks.length,
      rawBytes: chunks.reduce((sum, chunk) => sum + chunk.rawBytes, 0),
      gzipBytes: chunks.reduce((sum, chunk) => sum + chunk.gzipBytes, 0),
      cssFiles: css.size,
      cssRawBytes: cssSizes.reduce((sum, size) => sum + size.raw, 0),
      cssGzipBytes: cssSizes.reduce((sum, size) => sum + size.gzip, 0),
      chunks,
    };
  };

  const items = Object.values(bundle);
  const entry = items.find((item): item is ChunkLike => item.type === 'chunk' && item.isEntry);
  const shellClosure = entry ? staticClosure(entry.fileName, bundle) : new Map();
  const shellFiles = new Set(shellClosure.keys());
  const destinations: Record<string, RouteGraphEntry> = {};
  for (const item of items) {
    if (item.type !== 'chunk' || !item.isDynamicEntry || !item.facadeModuleId) continue;
    const match = DESTINATION_MODULE.exec(item.facadeModuleId);
    if (!match) continue;
    destinations[match[1]!] = entryOf(staticClosure(item.fileName, bundle), shellFiles);
  }

  const modules: RouteGraph['modules'] = {};
  for (const item of items) {
    if (item.type !== 'chunk') continue;
    modules[item.fileName] = Object.entries(item.modules)
      .map(([id, info]) => ({ id: shortModuleId(id), bytes: info.renderedLength }))
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, TOP_MODULES_PER_CHUNK);
  }

  return {
    shell: entryOf(shellClosure, new Set()),
    destinations: Object.fromEntries(
      Object.entries(destinations).sort(([a], [b]) => a.localeCompare(b)),
    ),
    modules,
  };
}

export function routeGraphPlugin(): Plugin {
  return {
    name: 'gezel-route-graph',
    apply: 'build',
    generateBundle(_options, bundle) {
      const graph = buildRouteGraph(bundle as unknown as Record<string, BundleItem>);
      this.emitFile({
        type: 'asset',
        fileName: 'route-graph.json',
        source: `${JSON.stringify(graph, null, 2)}\n`,
      });
    },
  };
}
