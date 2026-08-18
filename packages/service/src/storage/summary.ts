import { resolve } from 'node:path';
import type { StorageCategory, StorageItem, StorageSummary } from '@bendyline/gezel';
import type { Store } from '../fs/store.js';
import { STORAGE_CATEGORIES, type StoragePathEntry } from './registry.js';
import { SizeCache, measureTree } from './sizes.js';

/**
 * Turns the classification registry into the numbers a person actually sees:
 * how much space each category holds, and which parts of it live outside the
 * Gezel folder and are therefore off-limits to cleanup.
 */

export interface SummaryDeps {
  home: string;
  store: Store;
  env?: NodeJS.ProcessEnv;
}

const cache = new SizeCache();

export async function buildStorageSummary(
  deps: SummaryDeps,
  refresh = false,
): Promise<StorageSummary> {
  return cache.get(() => computeSummary(deps), refresh);
}

/** Drop memoized sizes — called after a cleanup run changes the truth. */
export function invalidateStorageSummary(): void {
  cache.clear();
}

/**
 * Several path helpers name the same directory when no folder has been
 * externalized — `projectDir` and `projectStorageDir` are literally equal on
 * a default install. Measuring both would double a project's reported size.
 * The first entry wins so its item identity and exclusions survive.
 */
function dedupeByPath(entries: StoragePathEntry[]): StoragePathEntry[] {
  const seen = new Set<string>();
  const out: StoragePathEntry[] = [];
  for (const entry of entries) {
    const key = resolve(entry.path);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

async function computeSummary(deps: SummaryDeps): Promise<StorageSummary> {
  const ctx = { home: deps.home, store: deps.store, env: deps.env ?? process.env };
  const categories: StorageCategory[] = [];

  for (const def of STORAGE_CATEGORIES) {
    let entries: StoragePathEntry[] = [];
    try {
      entries = await def.resolve(ctx);
    } catch {
      // A category that cannot enumerate reports zero rather than failing the
      // whole summary — a broken project record must not hide the 60 GB of
      // models sitting next to it.
    }

    const sized = await Promise.all(
      dedupeByPath(entries).map(async (entry) => ({
        entry,
        size: await measureTree(entry.path, entry.excludePaths),
      })),
    );

    let bytes = 0;
    const external: { path: string; bytes: number }[] = [];
    const items = new Map<string, StorageItem>();

    for (const { entry, size } of sized) {
      bytes += size.bytes;
      if (entry.external) external.push({ path: entry.path, bytes: size.bytes });
      if (!entry.itemId) continue;
      const existing = items.get(entry.itemId);
      if (existing) {
        existing.bytes += size.bytes;
        continue;
      }
      items.set(entry.itemId, {
        id: entry.itemId,
        label: entry.itemLabel ?? entry.itemId,
        bytes: size.bytes,
        external: entry.external,
        blockedReason: entry.blockedReason,
      });
    }

    categories.push({
      id: def.id,
      class: def.class,
      label: def.label,
      description: def.description,
      bytes,
      itemCount: def.itemGranular ? items.size : entries.length,
      deletable: def.deletable,
      inBackup: def.inBackup,
      external,
      items: def.itemGranular ? [...items.values()].sort((a, b) => b.bytes - a.bytes) : undefined,
    });
  }

  const sumOf = (cls: StorageCategory['class']) =>
    categories.filter((c) => c.class === cls).reduce((total, c) => total + c.bytes, 0);

  return {
    home: deps.home,
    categories,
    redownloadableBytes: sumOf('redownloadable'),
    userContentBytes: sumOf('user-content'),
    measuredAt: new Date().toISOString(),
  };
}
