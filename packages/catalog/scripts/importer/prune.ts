/**
 * Reconcile the on-disk community catalog against upstream.
 *
 * The import pipeline is append/update-only: `classify()` drops
 * `status=deleted` entries before they reach the writer, and an entry
 * that disappears from the registry altogether is never yielded at
 * all. Either way the directory written by an earlier run stays on
 * disk forever, so the catalog accumulates toolsets pointing at
 * discontinued servers (bendyline/gilde#2).
 *
 * Pruning is deliberately split from importing because the two have
 * wildly different costs. Importing hashes an npm tarball per entry;
 * reconciling only needs the set of names upstream still vouches for,
 * which is ~90 listing requests. That makes prune cheap enough to run
 * on every refresh instead of only on a full re-import.
 *
 * Safety rules, in order of how much damage they prevent:
 *
 *   1. Only slugs the importer minted (present in the slug map) are
 *      ever removed. A hand-added directory is reported, never
 *      deleted.
 *   2. The name→slug map is NOT pruned. Slug allocation is
 *      first-come-first-served and persisted precisely so an id never
 *      shifts; forgetting a mapping would let a later entry claim the
 *      freed base slug, and a re-published server would come back
 *      under a different id.
 *   3. A removal ratio above `maxRemovalRatio` aborts the whole pass.
 *      A truncated listing sweep (network flake mid-pagination) looks
 *      exactly like "upstream deleted everything", and this is the
 *      backstop that keeps that from landing as a 3000-directory
 *      deletion.
 */

import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { NormalizedRegistryServer } from './types.js';

export interface UpstreamNameSets {
  /** Names upstream lists without a `deleted` status. */
  live: Set<string>;
  /** Names upstream lists carrying `status: deleted`. */
  deleted: Set<string>;
  /** Entries yielded, including repeats across versions. */
  seen: number;
}

/**
 * Fold a complete listing sweep into the two name sets prune needs.
 *
 * Takes an async iterable rather than a client so the reconcile logic
 * is testable without network. Pass a sweep that is complete over
 * servers — `version: 'latest'` is right, `updated_since` is not,
 * since an unchanged server would read as absent.
 *
 * A listing currently omits deleted entries entirely (they surface as
 * absent), but the registry has also served them inline with a status
 * flag, so both are tracked.
 */
export async function collectUpstreamNames(
  entries: AsyncIterable<NormalizedRegistryServer>,
): Promise<UpstreamNameSets> {
  const live = new Set<string>();
  const deleted = new Set<string>();
  let seen = 0;
  for await (const entry of entries) {
    seen++;
    if (entry.official?.status === 'deleted') deleted.add(entry.name);
    else live.add(entry.name);
  }
  // A name seen live under any version outranks a deleted older one —
  // publishing a new version after a deletion resurrects the server.
  for (const name of live) deleted.delete(name);
  return { live, deleted, seen };
}

export type PruneReason =
  /** Upstream still lists it, flagged `status: deleted`. */
  | 'upstream-deleted'
  /** Absent from a complete upstream listing — hard-deleted or unpublished. */
  | 'upstream-absent';

export interface PruneCandidate {
  slug: string;
  dir: string;
  upstreamName: string;
  reason: PruneReason;
}

export interface PruneOptions {
  /** Community data root, e.g. the gilde checkout's `data/community`. */
  root: string;
  /** Names observed upstream that are not marked deleted. */
  liveNames: Set<string>;
  /** Names observed upstream carrying `status: deleted`. */
  deletedNames: Set<string>;
  /** Persisted upstream-name → slug map. Only these slugs are prunable. */
  slugMap: Record<string, string>;
  /** Compute the outcome without touching disk. */
  dryRun?: boolean;
  /**
   * Abort when the candidate set exceeds this fraction of all
   * importer-owned directories. Defaults to 10%: upstream deletions
   * run at a trickle, so anything larger is far more likely to be a
   * truncated sweep than real churn.
   */
  maxRemovalRatio?: number;
  /**
   * Always allow up to this many removals regardless of the ratio.
   * Without it the ratio alone makes a small catalog unprunable — one
   * genuine deletion out of five entries reads as 20% and aborts. A
   * handful of directories is not the failure mode the guard exists
   * to catch.
   */
  minRemovalFloor?: number;
}

export interface PruneResult {
  /** Directories that were removed (empty when `dryRun` or aborted). */
  removed: PruneCandidate[];
  /** Everything that qualified, whether or not it was removed. */
  candidates: PruneCandidate[];
  /** On-disk slugs with no slug-map entry. Reported, never removed. */
  unmapped: string[];
  /** Total importer-owned directories found on disk. */
  ownedOnDisk: number;
  /** Set when the ratio guard tripped; nothing was deleted. */
  abortedReason?: string;
}

/**
 * Compare `{root}/toolsets/{shard}/{slug}` against the upstream name
 * sets and remove the directories upstream no longer vouches for.
 *
 * Callers must pass name sets gathered from a *complete* listing sweep
 * — a filtered or windowed sweep marks every unseen entry absent.
 */
export async function pruneCommunityToolsets(opts: PruneOptions): Promise<PruneResult> {
  const toolsetsRoot = join(opts.root, 'toolsets');
  const slugToName = new Map<string, string>();
  for (const [name, slug] of Object.entries(opts.slugMap)) slugToName.set(slug, name);

  const onDisk = await listToolsetDirs(toolsetsRoot);
  const candidates: PruneCandidate[] = [];
  const unmapped: string[] = [];
  let ownedOnDisk = 0;

  for (const { slug, dir } of onDisk) {
    const upstreamName = slugToName.get(slug);
    if (!upstreamName) {
      unmapped.push(slug);
      continue;
    }
    ownedOnDisk++;
    if (opts.deletedNames.has(upstreamName)) {
      candidates.push({ slug, dir, upstreamName, reason: 'upstream-deleted' });
    } else if (!opts.liveNames.has(upstreamName)) {
      candidates.push({ slug, dir, upstreamName, reason: 'upstream-absent' });
    }
  }

  const maxRatio = opts.maxRemovalRatio ?? 0.1;
  const floor = opts.minRemovalFloor ?? 5;
  const overRatio = ownedOnDisk > 0 && candidates.length / ownedOnDisk > maxRatio;
  if (overRatio && candidates.length > floor) {
    const pct = ((candidates.length / ownedOnDisk) * 100).toFixed(1);
    const ceiling = (maxRatio * 100).toFixed(0);
    return {
      removed: [],
      candidates,
      unmapped,
      ownedOnDisk,
      abortedReason: `${candidates.length}/${ownedOnDisk} (${pct}%) of imported toolsets look gone upstream, over the ${ceiling}% ceiling. This is what a truncated listing sweep looks like — verify the sweep completed, then re-run with a higher --prune-max-ratio if the churn is real.`,
    };
  }

  if (opts.dryRun) {
    return { removed: [], candidates, unmapped, ownedOnDisk };
  }

  for (const candidate of candidates) {
    await rm(candidate.dir, { recursive: true, force: true });
  }
  await removeEmptyShards(toolsetsRoot);

  return { removed: candidates, candidates, unmapped, ownedOnDisk };
}

/** Enumerate `{root}/{shard}/{slug}` directories. Missing root → empty. */
async function listToolsetDirs(
  toolsetsRoot: string,
): Promise<Array<{ slug: string; dir: string }>> {
  const out: Array<{ slug: string; dir: string }> = [];
  let shards: string[];
  try {
    shards = (await readdir(toolsetsRoot, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return out;
    throw err;
  }
  for (const shard of shards) {
    const shardDir = join(toolsetsRoot, shard);
    const entries = await readdir(shardDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      out.push({ slug: entry.name, dir: join(shardDir, entry.name) });
    }
  }
  return out;
}

/** Drop shard directories left empty by a removal. */
async function removeEmptyShards(toolsetsRoot: string): Promise<void> {
  let shards: string[];
  try {
    shards = (await readdir(toolsetsRoot, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  for (const shard of shards) {
    const shardDir = join(toolsetsRoot, shard);
    const entries = await readdir(shardDir);
    if (entries.length === 0) await rm(shardDir, { recursive: true, force: true });
  }
}

/** True when `path` exists and is a directory. */
export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
