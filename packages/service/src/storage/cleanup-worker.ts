import { resolve } from 'node:path';
import type { CleanupRequest, ProviderName, StorageCategoryId, StorageJob } from '@bendyline/gezel';
import { createLogger } from '@bendyline/gezel';
import type { Store } from '../fs/store.js';
import type { StorageJobManager } from './job-manager.js';
import { STORAGE_CATEGORIES, type StoragePathEntry, categoryById } from './registry.js';
import { UndeletablePathError, removeEntry } from './safe-remove.js';
import { measureTree } from './sizes.js';
import { invalidateStorageSummary } from './summary.js';

const log = createLogger('storage');

/**
 * Executes a cleanup request: measure, delete, then leave the install in a
 * state the next boot can recover from.
 *
 * The recovery half is what makes deleting downloads safe to offer at all.
 * `ensureLayout` rebuilds the directory skeleton, the engine and toolset
 * bootstraps re-install on a missing sentinel, and the first-run banner keys
 * on whether the configured model is actually on disk — so a person who
 * clears 60 GB before a trip gets a working Gezel back by re-downloading,
 * not a broken one.
 */

export interface CleanupDeps {
  home: string;
  store: Store;
  jobs: StorageJobManager;
  env?: NodeJS.ProcessEnv;
  /** Live chat turns. Cleanup refuses to pull files out from under one. */
  listInflight?: () => Array<{ sessionId: string }>;
  /** Drop the cached model inventory for a provider after its files go. */
  invalidateModelsCache?: (provider?: ProviderName) => void;
}

export interface CleanupOutcome {
  bytesFreed: number;
  itemsRemoved: number;
  skippedExternal: Array<{ label: string; path: string }>;
  failures: Array<{ label: string; reason: string }>;
}

/** Categories whose files an in-flight chat turn is likely to have open. */
const ENGINE_BACKED: ReadonlySet<StorageCategoryId> = new Set([
  'models',
  'native-engines',
  'engine-caches',
]);

export async function runCleanup(
  deps: CleanupDeps,
  request: CleanupRequest,
  job: StorageJob,
): Promise<CleanupOutcome> {
  const { jobs } = deps;
  const env = deps.env ?? process.env;
  const outcome: CleanupOutcome = {
    bytesFreed: 0,
    itemsRemoved: 0,
    skippedExternal: [],
    failures: [],
  };

  jobs.update(job.id, { status: 'running' });

  try {
    jobs.setPhase(job.id, 'quiesce');
    assertNoConflictingWork(deps, request);

    const plan = await planEntries(deps, request);
    jobs.update(job.id, { totalItems: plan.length });

    jobs.setPhase(job.id, 'delete');
    for (const { category, entry, label } of plan) {
      if (jobs.get(job.id)?.cancelRequested) break;

      if (entry.external || entry.blockedReason) {
        outcome.skippedExternal.push({ label, path: entry.path });
        jobs.update(job.id, {
          itemsDone: (jobs.get(job.id)?.itemsDone ?? 0) + 1,
          skippedExternal: outcome.skippedExternal,
        });
        continue;
      }

      jobs.setPhase(job.id, 'delete', label);
      // Measured before removal — afterwards there is nothing left to size,
      // and the freed total is the number the whole feature exists to move.
      const size = await measureTree(entry.path);
      try {
        await deleteOne(deps, category, entry, env);
        outcome.bytesFreed += size.bytes;
        outcome.itemsRemoved += 1;
        if (category === 'models') {
          const provider = cachedProviderOf(entry.itemId);
          if (provider) deps.invalidateModelsCache?.(provider);
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        // One locked model must not abandon the other 60 GB the user asked
        // to reclaim, so a failure is recorded and the run continues.
        outcome.failures.push({ label, reason });
        log.warn(`[cleanup] could not remove ${entry.path}: ${reason}`);
      }
      jobs.update(job.id, {
        itemsDone: (jobs.get(job.id)?.itemsDone ?? 0) + 1,
        bytesDone: outcome.bytesFreed,
      });
    }

    jobs.setPhase(job.id, 'verify-recovery');
    await deps.store.ensureLayout();
    invalidateStorageSummary();

    const cancelled = jobs.get(job.id)?.cancelRequested === true;
    jobs.update(job.id, { skippedExternal: outcome.skippedExternal });
    jobs.finish(job.id, {
      cancelled,
      ...(outcome.failures.length > 0 && outcome.itemsRemoved === 0
        ? { error: outcome.failures[0]?.reason }
        : {}),
    });
    return outcome;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    jobs.finish(job.id, { error: reason });
    throw err;
  }
}

/**
 * Refuses the run when a chat is mid-turn and the request would delete files
 * that turn is using. Stopping the turn ourselves would truncate a reply the
 * person is watching arrive; asking them to finish it costs seconds.
 */
function assertNoConflictingWork(deps: CleanupDeps, request: CleanupRequest): void {
  const touchesEngines = request.categories.some((id) => ENGINE_BACKED.has(id));
  if (!touchesEngines) return;
  const inflight = deps.listInflight?.() ?? [];
  if (inflight.length === 0) return;
  throw new Error(
    inflight.length === 1
      ? 'A chat is still replying. Wait for it to finish, then clean up.'
      : `${inflight.length} chats are still replying. Wait for them to finish, then clean up.`,
  );
}

interface PlannedEntry {
  category: StorageCategoryId;
  entry: StoragePathEntry;
  label: string;
}

/**
 * Gezels and projects are records, not just directories: deleting one has to
 * drop the gezel from project rosters, clear a voorman pointer, and refuse
 * the cases the Store already refuses (the default project, and the shared
 * library whose workspace is the Documents area). Removing the folder behind
 * the Store's back would leave those references dangling, so these go through
 * the same methods the rest of the app deletes with.
 */
async function deleteOne(
  deps: CleanupDeps,
  category: StorageCategoryId,
  entry: StoragePathEntry,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  if (category === 'gezels' && entry.itemId) {
    await deps.store.deleteGezel(entry.itemId);
    return;
  }
  if (category === 'projects' && entry.itemId) {
    // Only an internal workspace is ever removed; the Store refuses to touch
    // a working directory the user pointed at.
    await deps.store.deleteProject(entry.itemId, { removeWorkspace: true });
    return;
  }
  await removeEntry(entry, { home: deps.home, env });
}

async function planEntries(deps: CleanupDeps, request: CleanupRequest): Promise<PlannedEntry[]> {
  const ctx = { home: deps.home, store: deps.store, env: deps.env ?? process.env };
  const requested = new Set(request.categories);
  const planned: PlannedEntry[] = [];
  const seenPaths = new Set<string>();
  const seenRecords = new Set<string>();

  // Registry order, not request order: the categories are listed
  // cheapest-to-riskiest, and a partial run should have done the safe work.
  for (const def of STORAGE_CATEGORIES) {
    if (!requested.has(def.id)) continue;
    if (!def.deletable) continue;

    const wanted = request.itemIds?.[def.id];
    for (const entry of await def.resolve(ctx)) {
      if (wanted && wanted.length > 0) {
        if (!entry.itemId || !wanted.includes(entry.itemId)) continue;
      }

      // Several path helpers name the same directory on a default install,
      // and a record-based delete must run once per record however many
      // directories the registry listed for it.
      const recordKey =
        STORE_MEDIATED.has(def.id) && entry.itemId ? `${def.id}:${entry.itemId}` : null;
      if (recordKey) {
        if (seenRecords.has(recordKey)) continue;
        seenRecords.add(recordKey);
      } else {
        const pathKey = resolve(entry.path);
        if (seenPaths.has(pathKey)) continue;
        seenPaths.add(pathKey);
      }

      planned.push({
        category: def.id,
        entry,
        label: entry.itemLabel ?? def.label,
      });
    }
  }
  return planned;
}

/** Categories deleted through Store methods rather than by path. */
const STORE_MEDIATED: ReadonlySet<StorageCategoryId> = new Set(['gezels', 'projects']);

/**
 * `llama-cpp/demo-7b` → `llama-cpp`, so the right inventory cache drops.
 * Only the chat engines have an entry in that cache; image, video, speech,
 * and recognition models are listed straight from disk.
 */
const CACHED_MODEL_PROVIDERS = new Set<ProviderName>(['llama-cpp', 'mlx', 'ds4']);

function cachedProviderOf(itemId?: string): ProviderName | undefined {
  const engine = itemId?.includes('/') ? itemId.split('/')[0] : undefined;
  return engine && CACHED_MODEL_PROVIDERS.has(engine as ProviderName)
    ? (engine as ProviderName)
    : undefined;
}

/**
 * Categories the request may name. Anything else — program files, code
 * checkouts, ephemeral state — is rejected at the route rather than silently
 * ignored, so a caller asking for the impossible learns that it is.
 */
export function undeletableCategories(ids: StorageCategoryId[]): StorageCategoryId[] {
  return ids.filter((id) => categoryById(id)?.deletable !== true);
}

/** Category ids in the request that destroy content only the user has. */
export function userContentCategories(ids: StorageCategoryId[]): StorageCategoryId[] {
  return ids.filter((id) => categoryById(id)?.class === 'user-content');
}

export { UndeletablePathError };
