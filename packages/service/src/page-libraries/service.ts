import { readFile, stat } from 'node:fs/promises';
import { resolveDistributionProfile, resolveSecurityPolicy } from '@bendyline/gezel';
import type { CatalogService } from '@bendyline/gezel-catalog';
import { realpathContained, safeJoin } from '@bendyline/gezel-inference/internal/fs/safe-paths';
import {
  type PageLibraryDownloadBlock,
  type PageLibraryEnsureResult,
  PageLibraryManager,
} from '@bendyline/gezel-inference/internal/page-libraries/manager';
import { PageLibraryStore } from '@bendyline/gezel-inference/internal/page-libraries/store';
import { scanPreviewModuleImports } from '@bendyline/gezel-script-runtime/preview-module';
import {
  type CollectedPageLibraries,
  type PageLibraryLine,
  type PageLibraryPins,
  collectPageLibraries,
  pinsForUses,
} from '@bendyline/gezel/pages';
import type { Store } from '../fs/store.js';

/** A project file larger than this is not read to find the libraries it imports. */
const MAX_COLLECTED_FILE_BYTES = 2 * 1024 * 1024;

/**
 * The page-library manager this daemon runs, with its gates: a store build
 * never downloads; a download the person asks for in Settings is theirs to
 * start at any security level, as a model or knowledge download is; one a
 * page triggers needs app network and the automatic-download setting.
 */
export function createPageLibraryManager(opts: {
  home: string;
  store: Store;
  catalog: CatalogService;
  env?: NodeJS.ProcessEnv;
}): PageLibraryManager {
  const env = opts.env ?? process.env;
  return new PageLibraryManager({
    store: new PageLibraryStore({ home: opts.home, env }),
    catalogLines: async () => catalogPageLibraryLines(opts.catalog),
    blockReason: async (trigger): Promise<PageLibraryDownloadBlock | null> => {
      if (!resolveDistributionProfile(env).allowPageLibraryDownloads) return 'build';
      if (trigger === 'person') return null;
      const config = await opts.store.readConfig().catch(() => null);
      if (!config) return 'network';
      if (!resolveSecurityPolicy(config).allowAppNetwork) return 'network';
      if (config.pageLibraries?.autoDownload === false) return 'setting';
      return null;
    },
    ...(env.GEZEL_PAGE_LIBRARIES_REGISTRY ? { registry: env.GEZEL_PAGE_LIBRARIES_REGISTRY } : {}),
  });
}

/** Every line the catalog's page-library items list. */
export async function catalogPageLibraryLines(catalog: CatalogService): Promise<PageLibraryLine[]> {
  const items = await catalog.list('page-library').catch(() => []);
  return items.flatMap((item) =>
    item.manifest.kind === 'page-library' ? item.manifest.lines : [],
  );
}

export interface PageLibraryNeeds {
  collected: CollectedPageLibraries;
  ensure: PageLibraryEnsureResult;
}

/**
 * What a workspace page needs from the shelf, fetched when allowed and
 * waited for up to `waitMs`. Records a pin for each library the page used
 * without naming a version, so the project keeps it when the default moves.
 */
export async function ensurePageLibrariesForPage(opts: {
  store: Store;
  manager: PageLibraryManager;
  projectId: string;
  entry: string;
  waitMs: number;
}): Promise<PageLibraryNeeds> {
  const baseDir = await opts.store.projectWorkspaceDir(opts.projectId);
  const read = async (path: string): Promise<string | null> => {
    const full = safeJoin(baseDir, path);
    if (!full || !(await realpathContained(baseDir, full).catch(() => false))) return null;
    const info = await stat(full).catch(() => null);
    if (!info?.isFile() || info.size > MAX_COLLECTED_FILE_BYTES) return null;
    return readFile(full, 'utf8').catch(() => null);
  };
  const pins = await opts.store.readPageLibraryPins(opts.projectId);
  const collected = await collectPageLibraries({
    entry: opts.entry,
    read,
    lines: await opts.manager.usableLines(),
    pins,
    scanImports: (code, path) => scanPreviewModuleImports(code, path),
  });
  const ensure = await opts.manager.ensure(collected.lines, { waitMs: opts.waitMs });
  const ready = new Set(ensure.ready);
  const settled = pinsForUses(
    collected.uses.filter((use) => ready.has(`${use.line.library}@${use.line.version}`)),
    pins,
  );
  if (settled) await opts.store.writePageLibraryPins(opts.projectId, settled).catch(() => {});
  return { collected, ensure };
}

/** The pins to serve a project's pages with, read at most once a second. */
export function projectPinsReader(store: Store): (projectId: string) => Promise<PageLibraryPins> {
  const cache = new Map<string, { at: number; pins: Promise<PageLibraryPins> }>();
  return (projectId) => {
    const hit = cache.get(projectId);
    if (hit && Date.now() - hit.at < 1_000) return hit.pins;
    const pins = store.readPageLibraryPins(projectId).catch(() => ({}));
    cache.set(projectId, { at: Date.now(), pins });
    if (cache.size > 256) cache.delete(cache.keys().next().value!);
    return pins;
  };
}
