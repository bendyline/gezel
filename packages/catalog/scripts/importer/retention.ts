/**
 * Bound how many `versions/{semver}/` folders each imported toolset
 * keeps on disk.
 *
 * This is the second half of the version-sprawl story. The first half
 * is ingest: `Orchestrator` now lists upstream with `version=latest`,
 * so a run mints at most one new folder per server. That stops the
 * bleeding but doesn't heal anything — folders already committed stay,
 * and a genuinely chatty publisher still accumulates one per release
 * forever.
 *
 * Retention is deliberately **opt-in and off by default**. Compacting
 * history rewrites files that are already in gilde's git history, which
 * is churn a routine refresh has no business producing. Ask for it
 * explicitly (`--keep-versions=N`) when the sprawl is worth a diff.
 *
 * ── What "keep the newest N" means ──────────────────────────────────
 *
 * Eligibility mirrors the loaders exactly (`pickVersion` in
 * packages/catalog/src/source.ts and gilde's manifest-merge.mjs): a
 * folder is eligible when its name is semver, it isn't in the
 * identity's `yankedVersions`, and it isn't below `minSupportedVersion`.
 * We keep the newest N eligible and drop everything else in the folder.
 *
 * Keeping N > 1 is functional, not sentimental. When the newest version
 * is later yanked, `pickVersion` falls through to the next eligible
 * folder. At N=1 that fallback doesn't exist: a single yank takes the
 * toolset out of the index entirely.
 *
 * ── Why the guards differ from prune.ts ─────────────────────────────
 *
 * `pruneCommunityToolsets` carries a removal-ratio ceiling because its
 * input is a *network* sweep, and a sweep truncated by a flake is
 * indistinguishable from "upstream deleted everything". Retention reads
 * only local disk, so that failure mode doesn't exist — and a ratio
 * ceiling would be actively wrong here, since the expected first run
 * removes ~70% of all version folders by design.
 *
 * Its guards are structural instead:
 *
 *   1. Only slugs the importer minted are touched. A hand-added
 *      directory is reported, never modified.
 *   2. A missing or unparseable identity manifest skips the toolset.
 *      Without `yankedVersions`/`minSupportedVersion` we can't compute
 *      eligibility, and guessing would delete the wrong folders.
 *   3. A toolset with zero eligible versions is left completely alone.
 *      That state is a deliberate tombstone (every folder yanked), and
 *      the loaders distinguish `tombstoned` from `no-eligible-versions`
 *      — deleting the folders would silently convert one into the other.
 *   4. Folders whose names aren't semver are never removed. The loaders
 *      already ignore them, so they cost nothing, and we can't order
 *      what we can't parse.
 */

import { readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { compareSemver, isSemver } from '@bendyline/gezel';

export interface RetentionOptions {
  /** Community data root, e.g. the gilde checkout's `data/community`. */
  root: string;
  /** How many of the newest eligible versions to keep. Must be >= 1. */
  keep: number;
  /** Persisted upstream-name → slug map. Only these slugs are touched. */
  slugMap: Record<string, string>;
  /** Compute the outcome without touching disk. */
  dryRun?: boolean;
}

export type RetentionSkipReason =
  /** No identity manifest, or it didn't parse. */
  | 'unreadable-identity'
  /** Every folder is yanked or below `minSupportedVersion` — a tombstone. */
  | 'no-eligible-versions';

export interface RetentionRemoval {
  slug: string;
  version: string;
  dir: string;
}

export interface RetentionSkip {
  slug: string;
  reason: RetentionSkipReason;
}

export interface RetentionResult {
  /** Version folders removed (empty when `dryRun`). */
  removed: RetentionRemoval[];
  /** Everything that qualified, whether or not it was removed. */
  candidates: RetentionRemoval[];
  /** Toolsets deliberately left alone, with why. */
  skipped: RetentionSkip[];
  /** On-disk slugs with no slug-map entry. Reported, never touched. */
  unmapped: string[];
  /** Importer-owned toolsets inspected. */
  toolsetsScanned: number;
  /** Version folders those toolsets held before the pass. */
  versionsBefore: number;
}

/**
 * Trim `{root}/toolsets/{shard}/{slug}/versions/` down to the newest
 * `keep` eligible versions, for every importer-owned toolset.
 */
export async function retainNewestVersions(opts: RetentionOptions): Promise<RetentionResult> {
  if (!Number.isInteger(opts.keep) || opts.keep < 1) {
    throw new Error(`retention keep must be an integer >= 1 (got ${opts.keep})`);
  }
  const toolsetsRoot = join(opts.root, 'toolsets');
  const ownedSlugs = new Set(Object.values(opts.slugMap));

  const result: RetentionResult = {
    removed: [],
    candidates: [],
    skipped: [],
    unmapped: [],
    toolsetsScanned: 0,
    versionsBefore: 0,
  };

  for (const { slug, dir } of await listToolsetDirs(toolsetsRoot)) {
    if (!ownedSlugs.has(slug)) {
      result.unmapped.push(slug);
      continue;
    }
    result.toolsetsScanned++;

    const identity = await readIdentity(join(dir, 'manifest.json'));
    if (!identity) {
      result.skipped.push({ slug, reason: 'unreadable-identity' });
      continue;
    }

    const folders = await listVersionFolders(join(dir, 'versions'));
    result.versionsBefore += folders.length;

    const eligible = eligibleDesc(folders, identity);
    if (eligible.length === 0) {
      result.skipped.push({ slug, reason: 'no-eligible-versions' });
      continue;
    }

    const keepSet = new Set(eligible.slice(0, opts.keep));
    for (const version of folders) {
      // Non-semver names are invisible to the loaders and unorderable
      // here; leave them for a human to look at.
      if (!isSemver(version) || keepSet.has(version)) continue;
      result.candidates.push({ slug, version, dir: join(dir, 'versions', version) });
    }
  }

  if (!opts.dryRun) {
    for (const candidate of result.candidates) {
      await rm(candidate.dir, { recursive: true, force: true });
    }
    result.removed = result.candidates;
  }

  return result;
}

interface IdentityFacts {
  yankedVersions: Set<string>;
  minSupportedVersion?: string;
}

/**
 * Newest-first list of versions the loaders would consider usable.
 * Mirrors `pickVersion`/`eligibleVersionsDesc`; keeping the two in step
 * is what guarantees retention never deletes the folder build-index is
 * about to pick.
 */
function eligibleDesc(folders: string[], identity: IdentityFacts): string[] {
  return folders
    .filter((v) => {
      if (!isSemver(v)) return false;
      if (identity.yankedVersions.has(v)) return false;
      if (identity.minSupportedVersion && safeCompare(v, identity.minSupportedVersion) < 0) {
        return false;
      }
      return true;
    })
    .sort((a, b) => safeCompare(b, a));
}

/** Compare two semver strings, swallowing parse errors as "equal". */
function safeCompare(a: string, b: string): number {
  try {
    return compareSemver(a, b);
  } catch {
    return 0;
  }
}

/**
 * Read only the two fields eligibility depends on. Deliberately not a
 * `ToolsetIdentitySchema.parse` — a manifest that fails a full schema
 * check is still a manifest whose yank list we must honour, and
 * refusing to read it would make retention delete folders the loaders
 * consider tombstoned.
 */
async function readIdentity(path: string): Promise<IdentityFacts | null> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return null;
  }
  let json: { yankedVersions?: unknown; minSupportedVersion?: unknown };
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const yanked = Array.isArray(json.yankedVersions)
    ? json.yankedVersions.filter((v): v is string => typeof v === 'string')
    : [];
  return {
    yankedVersions: new Set(yanked),
    ...(typeof json.minSupportedVersion === 'string'
      ? { minSupportedVersion: json.minSupportedVersion }
      : {}),
  };
}

/** Enumerate `{toolsetsRoot}/{shard}/{slug}` directories. Missing root → empty. */
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
    for (const entry of await readdir(shardDir, { withFileTypes: true })) {
      if (entry.isDirectory()) out.push({ slug: entry.name, dir: join(shardDir, entry.name) });
    }
  }
  return out;
}

/** Subdirectory names under an item's `versions/`. Missing dir → empty. */
async function listVersionFolders(versionsDir: string): Promise<string[]> {
  try {
    return (await readdir(versionsDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}
