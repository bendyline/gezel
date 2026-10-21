import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { createLogger } from '@bendyline/gezel';
import { safeJoin } from '@bendyline/gezel-inference/internal/fs/safe-paths';
import { jsoncToJson } from '../../utils/jsonc.js';
import type { IndexStore } from '../index-store.js';
import { cargoPackageName, isRecord } from './context.js';
import { baseOf } from './paths.js';
import { type RequireJsConfig, requireJsConfigFor, requireJsPage } from './requirejs.js';
import { EDGE_RESOLVER_VERSION, resolveFileEdges } from './resolve.js';
import type { EdgeCoverage, ProjectConfigFiles } from './types.js';

const log = createLogger('index:edges');

export const EDGES_RESOLVER_META = 'edges_resolver_version';
export const EDGES_FINGERPRINT_META = 'edges_fingerprint';
export const EDGES_COVERAGE_META = 'edges_coverage';
/** Set when the walk that fed the graph hit its file cap. */
export const EDGES_PARTIAL_META = 'edges_partial';

/** A manifest bigger than this is not one a resolver needs. */
const MAX_CONFIG_BYTES = 512 * 1024;

/**
 * Rebuild the project's resolved dependency graph when it may have changed:
 * the file set (paths and content hashes, so a moved or edited manifest
 * counts) or the resolver version. Wholesale rather than per file, because a
 * new file can satisfy a specifier nothing resolved before. Never throws; a
 * failure leaves the previous graph in place.
 */
export async function refreshFileEdges(
  store: IndexStore,
  workspaceDir: string,
  opts: { partial?: boolean } = {},
): Promise<{ refreshed: boolean; edges: number }> {
  try {
    const files = store.allFiles();
    const imports = store.fileEdges.importRows();
    // The import rows too: an extractor upgrade rewrites them without
    // changing any file's hash.
    const fingerprint = createHash('sha256');
    for (const f of files) fingerprint.update(`${f.path}\u0000${f.hash ?? ''}\u0001`);
    fingerprint.update('\u0002');
    for (const r of imports) fingerprint.update(`${r.srcPath}\u0000${r.raw}\u0000${r.flags}\u0001`);
    const digest = fingerprint.digest('hex');
    if (
      store.getMeta(EDGES_RESOLVER_META) === String(EDGE_RESOLVER_VERSION) &&
      store.getMeta(EDGES_FINGERPRINT_META) === digest
    ) {
      return { refreshed: false, edges: -1 };
    }
    const configs = await readProjectConfigs(
      workspaceDir,
      files.map((f) => f.path),
    );
    const graph = resolveFileEdges({
      files: files.map((f) => ({ path: f.path, lang: f.lang, kind: f.kind })),
      imports,
      configs,
    });
    store.fileEdges.replace(graph.edges);
    store.setMeta(EDGES_COVERAGE_META, JSON.stringify(graph.coverage));
    store.setMeta(EDGES_PARTIAL_META, opts.partial ? '1' : '0');
    store.setMeta(EDGES_RESOLVER_META, String(EDGE_RESOLVER_VERSION));
    store.setMeta(EDGES_FINGERPRINT_META, digest);
    return { refreshed: true, edges: graph.edges.length };
  } catch (err) {
    log.warn(
      `resolving the dependency graph failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { refreshed: false, edges: -1 };
  }
}

/** Whether this index has a resolved graph a reader can use instead of re-resolving. */
export function fileEdgesAvailable(store: IndexStore): boolean {
  return store.getMeta(EDGES_RESOLVER_META) !== undefined;
}

/** The per-language coverage the last resolution recorded, when it ran. */
export function fileEdgeCoverage(store: IndexStore): Record<string, EdgeCoverage> | null {
  const raw = store.getMeta(EDGES_COVERAGE_META);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, EdgeCoverage>;
  } catch {
    return null;
  }
}

/** Folders holding a package manifest, named as the manifest names the package. */
export function manifestRoots(
  configs: ProjectConfigFiles,
): Array<{ folder: string; name: string }> {
  const out: Array<{ folder: string; name: string }> = [];
  const folder = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
  for (const [path, manifest] of configs.packageJsons) {
    if (isRecord(manifest) && typeof manifest.name === 'string' && manifest.name) {
      out.push({ folder: folder(path), name: manifest.name });
    }
  }
  for (const [path, text] of configs.cargoTomls) {
    const name = cargoPackageName(text);
    if (name) out.push({ folder: folder(path), name });
  }
  for (const [path, text] of configs.goMods) {
    const m = /^\s*module\s+(\S+)/m.exec(text);
    if (m?.[1]) out.push({ folder: folder(path), name: m[1] });
  }
  return out.sort((a, b) => (a.folder < b.folder ? -1 : a.folder > b.folder ? 1 : 0));
}

/** Read the manifests resolution needs, from the indexed file set. */
export async function readProjectConfigs(
  workspaceDir: string,
  paths: readonly string[],
): Promise<ProjectConfigFiles> {
  const configs: ProjectConfigFiles = {
    tsconfigs: new Map(),
    packageJsons: new Map(),
    goMods: new Map(),
    cargoTomls: new Map(),
  };
  for (const path of paths) {
    if (path.split('/').includes('node_modules')) continue;
    const base = baseOf(path);
    const isTsconfig = /^(?:tsconfig(?:\.[\w.-]+)?|jsconfig)\.json$/.test(base);
    if (!isTsconfig && base !== 'package.json' && base !== 'go.mod' && base !== 'Cargo.toml') {
      continue;
    }
    const text = await readConfig(workspaceDir, path);
    if (text === null) continue;
    try {
      if (isTsconfig) configs.tsconfigs.set(path, JSON.parse(jsoncToJson(text)));
      else if (base === 'package.json') configs.packageJsons.set(path, JSON.parse(text));
      else if (base === 'go.mod') configs.goMods.set(path, text);
      else configs.cargoTomls.set(path, text);
    } catch {
      /* a malformed manifest just resolves nothing */
    }
  }
  configs.requireJs = await readRequireJsConfigs(workspaceDir, paths);
  return configs;
}

/** Pages read for a RequireJS setup, shallowest first: test fixtures pile up deep. */
const MAX_REQUIREJS_PAGES = 200;
const MAX_REQUIREJS_SCRIPTS = 8;

/** The RequireJS setup of every page that loads the loader, from its local scripts. */
async function readRequireJsConfigs(
  workspaceDir: string,
  paths: readonly string[],
): Promise<RequireJsConfig[]> {
  const indexed = new Set(paths);
  const pages = paths
    .filter((p) => /\.html?$/i.test(p) && !p.split('/').includes('node_modules'))
    .sort((a, b) => a.split('/').length - b.split('/').length || (a < b ? -1 : 1))
    .slice(0, MAX_REQUIREJS_PAGES);
  const out: RequireJsConfig[] = [];
  for (const pagePath of pages) {
    const html = await readConfig(workspaceDir, pagePath);
    if (html === null || !/require(?:\.min)?\.js/i.test(html)) continue;
    const page = requireJsPage(html, pagePath);
    if (!page) continue;
    // Global `var require = {…}` scripts run before the loader, data-main after it.
    const scripts = [...page.scripts, ...(page.dataMain ? [page.dataMain] : [])]
      .filter((s) => indexed.has(s))
      .slice(0, MAX_REQUIREJS_SCRIPTS);
    const texts: string[] = [];
    for (const script of scripts) {
      const text = await readConfig(workspaceDir, script);
      if (text !== null) texts.push(text);
    }
    const config = requireJsConfigFor(pagePath, page, texts);
    if (config) out.push(config);
  }
  return out;
}

async function readConfig(workspaceDir: string, path: string): Promise<string | null> {
  const abs = safeJoin(workspaceDir, path);
  if (!abs) return null;
  try {
    if ((await stat(abs)).size > MAX_CONFIG_BYTES) return null;
    return (await readFile(abs, 'utf8')).replace(/^﻿/, '');
  } catch {
    return null;
  }
}
