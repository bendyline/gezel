/**
 * The per-scope cursor envelope a connector binding persists, and the
 * bookkeeping a sync pass keeps beside a scope's records: the progress of a
 * full listing that spans batches, the scopes a settings change dropped, and
 * the directory each scope's records land in. Used by `syncWithAdapter`.
 */

import { mkdir, readFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createLogger } from '@bendyline/gezel';
import { writeFileAtomic } from '@bendyline/gezel-inference/internal/fs/atomic';
import { resolveInside } from '@bendyline/gezel-inference/internal/fs/safe-paths';
import { type PruneInput, type PruneResult, type SweepInput, sha8, slug } from './writer.js';

const log = createLogger('connectors');

/** Persisted shape of a per-scope cursor envelope. */
export interface ScopedCursor {
  v: 2;
  scopes: Record<string, unknown>;
  /**
   * Per scope, how many separate passes each still-failing record ref has
   * failed in while the rest of its batch landed. Cleared when the scope's
   * cursor advances. Absent when nothing is failing.
   */
  failures?: Record<string, Record<string, number>>;
  /**
   * The binding's settings changed since the last pass: scopes the adapter
   * no longer lists lose their cursor, and a mirror's records with them.
   * Only then, so a listing that once comes back short never empties a scope.
   */
  reconcileScopes?: true;
}

function asFailureCounts(raw: unknown): ScopedCursor['failures'] | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const out: NonNullable<ScopedCursor['failures']> = {};
  for (const [scope, counts] of Object.entries(raw as Record<string, unknown>)) {
    if (counts === null || typeof counts !== 'object') continue;
    const kept: Record<string, number> = {};
    for (const [id, n] of Object.entries(counts as Record<string, unknown>)) {
      if (typeof n === 'number' && Number.isFinite(n) && n > 0) kept[id] = n;
    }
    if (Object.keys(kept).length > 0) out[scope] = kept;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Read a persisted cursor as a per-scope envelope. Anything that isn't a v2
 * envelope (including pre-envelope flat cursors) is discarded — the writer's
 * idempotency makes the resulting re-backfill safe, just a wasted re-fetch.
 */
export function asScopedCursor(raw: unknown): ScopedCursor {
  if (
    raw !== null &&
    typeof raw === 'object' &&
    (raw as ScopedCursor).v === 2 &&
    typeof (raw as ScopedCursor).scopes === 'object' &&
    (raw as ScopedCursor).scopes !== null
  ) {
    const failures = asFailureCounts((raw as ScopedCursor).failures);
    return {
      v: 2,
      scopes: { ...(raw as ScopedCursor).scopes },
      ...(failures ? { failures } : {}),
      ...((raw as ScopedCursor).reconcileScopes === true ? { reconcileScopes: true as const } : {}),
    };
  }
  return { v: 2, scopes: {} };
}

/** What a full listing has returned so far, kept beside the scope's records. */
interface ListingProgress {
  hashes: string[];
  /** A batch overflowed or gave up on a record: absence proves nothing. */
  incomplete?: boolean;
  /** The date range the listing covers, from its first batch. */
  within?: { start: string; end: string };
}

const LISTING_FILE = '_listing.json';

/**
 * One batch of a full listing that spans batches. Returns how many records
 * it pruned (only on the last batch, only for a mirror, only when every
 * batch of the listing landed).
 */
export async function trackFullListing(input: {
  storageDir: string;
  corpusDir: string;
  listing: { first: boolean; last: boolean; within?: { start: string; end: string } };
  seen: Set<string>;
  complete: boolean;
  prune?: (input: PruneInput) => Promise<PruneResult>;
}): Promise<number> {
  const file = await resolveInside(input.storageDir, `${input.corpusDir}/${LISTING_FILE}`);
  let progress: ListingProgress | null = { hashes: [] };
  if (!input.listing.first) {
    progress = await readFile(file, 'utf8')
      .then((text) => JSON.parse(text) as ListingProgress)
      .catch(() => null);
  }
  // A continuation without its start (the sidecar was lost) can still sync,
  // but cannot prove what is gone.
  const hashes = new Set(progress?.hashes ?? []);
  for (const h of input.seen) hashes.add(h);
  const within = input.listing.first ? input.listing.within : progress?.within;
  // A listing whose range changed between its batches proves nothing.
  const rangeMoved =
    !input.listing.first &&
    JSON.stringify(progress?.within) !== JSON.stringify(input.listing.within);
  const incomplete = !progress || Boolean(progress.incomplete) || !input.complete || rangeMoved;
  if (!input.listing.last) {
    await mkdir(dirname(file), { recursive: true });
    await writeFileAtomic(
      file,
      JSON.stringify({
        hashes: [...hashes],
        ...(incomplete ? { incomplete } : {}),
        ...(within ? { within } : {}),
      }),
    );
    return 0;
  }
  await rm(file, { force: true });
  if (!input.prune || incomplete) return 0;
  const r = await input.prune({
    storageDir: input.storageDir,
    corpusDir: input.corpusDir,
    keepHashes: hashes,
    ...(within ? { within } : {}),
  });
  return r.pruned;
}

/**
 * After a settings change: forget the scopes the adapter no longer lists.
 * A mirror's records for them go too (the person removed that source); a
 * window type keeps them, since that history cannot be fetched again.
 */
export async function dropUnlistedScopes(
  envelope: ScopedCursor,
  listed: readonly string[],
  where: {
    storageDir: string;
    corpusDir: string;
    asDir: boolean;
    sweep?: (input: SweepInput) => Promise<{ removed: number }>;
  },
): Promise<number> {
  let removed = 0;
  for (const scope of Object.keys(envelope.scopes)) {
    if (listed.includes(scope)) continue;
    delete envelope.scopes[scope];
    if (envelope.failures) delete envelope.failures[scope];
    if (!where.sweep || !where.asDir || scope === '') continue;
    try {
      const r = await where.sweep({
        storageDir: where.storageDir,
        corpusDir: `${where.corpusDir}/${scopeDirName(scope)}`,
        remove: () => true,
      });
      removed += r.removed;
    } catch (err) {
      log.warn(`removing the records of dropped scope ${scope} failed: ${err}`);
    }
  }
  if (envelope.failures && Object.keys(envelope.failures).length === 0) delete envelope.failures;
  return removed;
}

const SCOPE_DIR_MAX = 48;

/**
 * The directory a scope's records land in. A scope whose slug fits keeps it
 * verbatim (existing corpora never move); a longer one is cut and suffixed
 * with a hash of the full scope, because long scopes tend to share their
 * first 48 characters — Graph calendar and folder ids carry a per-mailbox
 * prefix, and every YouTube channel feed URL starts the same way — and plain
 * truncation filed them all into one folder.
 */
export function scopeDirName(scope: string): string {
  const full = slug(scope, 400);
  if (full.length <= SCOPE_DIR_MAX) return full;
  return `${full.slice(0, SCOPE_DIR_MAX - 9).replace(/-+$/, '')}-${sha8(scope)}`;
}
