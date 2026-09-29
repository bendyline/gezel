import {
  isContainerFolderName,
  isDocumentFileName,
  isStrongProjectMarker,
  projectMarkerWeight,
} from './document-names.js';
import { forbiddenRootReason } from './forbidden-roots.js';
import {
  basenameOf,
  compareKey,
  isSameOrInside,
  isStrictlyInside,
  joinPath,
  normalizePath,
  parentOf,
  pathsEqual,
  segmentsBelow,
} from './path-compare.js';
import {
  type CandidateScore,
  DEFAULT_INFERENCE_POLICY,
  type ExistingProjectRef,
  type ForbiddenContext,
  type FsEntry,
  type FsProbe,
  type InferOutcome,
  type InferWarning,
  type InferencePlatform,
  type InferencePolicy,
  type WellKnownFolder,
} from './types.js';
import { wellKnownFolderFor } from './well-known-folders.js';

/**
 * Document path → project root.
 *
 * Precedence (each step returns when it yields a result):
 *   1. existing  — the deepest existing project whose workingDir contains the
 *                  path. A path inside a project never creates anything (N1).
 *                  For `kind: 'folder'` only an exact match counts: opening a
 *                  folder is an explicit choice of root.
 *   2. folder    — `kind: 'folder'`: the path itself, unless forbidden.
 *   3. well-known— the document sits under Documents/Desktop/a cloud root.
 *                  A strong marker (`.git`, `.gezel`…) between the root and
 *                  the document wins; otherwise the scorer (policy `full`)
 *                  may pick a folder such as `engineeringdocs`; otherwise the
 *                  well-known folder itself becomes the project.
 *   4. climb     — outside well-known roots: score the document's folder and
 *                  its ancestors, stopping at the first forbidden folder.
 *   5. parent    — the document's own folder.
 *   6. default   — the document's folder is itself forbidden (home, a drive
 *                  root, temp…): no folder project, use the Default project.
 */

export interface InferInput {
  /** Absolute path of the document (or folder, for `kind: 'folder'`). */
  path: string;
  kind: 'document' | 'folder';
  ctx: ForbiddenContext;
  /** Well-known folders, existence-filtered by the caller. */
  wellKnown: readonly WellKnownFolder[];
  existing: readonly ExistingProjectRef[];
  policy?: Partial<InferencePolicy>;
}

interface Candidate {
  dir: string;
  level: number;
  score: CandidateScore;
}

function warningsFor(root: string, ctx: ForbiddenContext): InferWarning[] {
  return forbiddenRootReason(root, ctx) ? ['existing-project-at-forbidden-root'] : [];
}

function existingOutcome(p: ExistingProjectRef, ctx: ForbiddenContext): InferOutcome {
  return {
    matchedBy: 'existing',
    projectId: p.id,
    root: normalizePath(p.workingDir, ctx.platform),
    name: p.name,
    sharedLibrary: p.sharedLibrary,
    warnings: warningsFor(p.workingDir, ctx),
  };
}

/** The deepest existing project whose workingDir contains `path`. */
export function deepestContainingProject(
  path: string,
  existing: readonly ExistingProjectRef[],
  platform: InferencePlatform,
): ExistingProjectRef | null {
  let best: ExistingProjectRef | null = null;
  for (const p of existing) {
    if (!p.workingDir || !isSameOrInside(path, p.workingDir, platform)) continue;
    if (
      !best ||
      compareKey(p.workingDir, platform).length > compareKey(best.workingDir, platform).length
    ) {
      best = p;
    }
  }
  return best;
}

export function containsExistingProject(
  dir: string,
  existing: readonly ExistingProjectRef[],
  platform: InferencePlatform,
): boolean {
  return existing.some((p) => p.workingDir && isStrictlyInside(p.workingDir, dir, platform));
}

export function scoreMarker(entries: readonly FsEntry[]): number {
  let best = 0;
  for (const e of entries) best = Math.max(best, projectMarkerWeight(e.name));
  return best;
}

export function scoreContainerName(dir: string, platform: InferencePlatform): number {
  return isContainerFolderName(basenameOf(dir, platform)) ? -2 : 0;
}

/** −1 for every level above the document's folder beyond the first. */
export function scoreDepth(level: number): number {
  return -Math.max(0, level - 1);
}

class ListingCache {
  private readonly cache = new Map<string, readonly FsEntry[] | null>();
  constructor(
    private readonly fs: FsProbe,
    private readonly platform: InferencePlatform,
    private readonly maxEntries: number,
  ) {}

  async list(dir: string): Promise<readonly FsEntry[] | null> {
    const key = compareKey(dir, this.platform);
    if (this.cache.has(key)) return this.cache.get(key) ?? null;
    let entries: readonly FsEntry[] | null;
    try {
      entries = await this.fs.listDir(dir);
    } catch {
      entries = null;
    }
    if (entries && entries.length > this.maxEntries) entries = null;
    this.cache.set(key, entries);
    return entries;
  }
}

function visibleDirs(entries: readonly FsEntry[]): FsEntry[] {
  return entries.filter((e) => e.isDir && !e.name.startsWith('.'));
}

async function holdsDocuments(
  dir: string,
  listing: ListingCache,
  platform: InferencePlatform,
  maxGrandchildren: number,
): Promise<boolean> {
  const entries = await listing.list(dir);
  if (!entries) return false;
  if (entries.some((e) => !e.isDir && isDocumentFileName(e.name))) return true;
  for (const sub of visibleDirs(entries).slice(0, maxGrandchildren)) {
    const inner = await listing.list(joinPath(platform, dir, sub.name));
    if (inner?.some((e) => !e.isDir && isDocumentFileName(e.name))) return true;
  }
  return false;
}

/**
 * +2 when `dir` looks like a folder of sibling work folders: at least two
 * child folders hold documents (the one leading to the document counts by
 * construction), and `dir` itself has few loose documents.
 */
async function scoreSiblingShape(
  dir: string,
  childOnPath: string,
  entries: readonly FsEntry[],
  listing: ListingCache,
  platform: InferencePlatform,
  policy: InferencePolicy,
): Promise<number> {
  const dirs = visibleDirs(entries);
  if (dirs.length < 2) return 0;
  const onPathName = basenameOf(childOnPath, platform);
  let holders = 1;
  let probed = 0;
  for (const child of dirs) {
    if (holders >= 2) break;
    if (probed >= policy.maxChildrenProbed) break;
    if (
      pathsEqual(joinPath(platform, dir, child.name), joinPath(platform, dir, onPathName), platform)
    ) {
      continue;
    }
    probed++;
    if (
      await holdsDocuments(
        joinPath(platform, dir, child.name),
        listing,
        platform,
        policy.maxGrandchildrenProbed,
      )
    ) {
      holders++;
    }
  }
  if (holders < 2) return 0;
  const looseDocs = entries.filter((e) => !e.isDir && isDocumentFileName(e.name)).length;
  if (looseDocs > Math.max(3, Math.floor(dirs.length * 0.25))) return 0;
  return 2;
}

type ClimbResult =
  | { kind: 'marker'; candidate: Candidate }
  | { kind: 'best'; candidate: Candidate }
  | null;

/**
 * Walk up from `start` (inclusive) toward `ceiling` (exclusive, when given),
 * never past a forbidden folder, an oversized/unreadable folder, or a folder
 * that already contains another project. The nearest strong marker wins
 * outright; otherwise the best score ≥ threshold, ties to the deeper folder.
 */
async function climb(
  start: string,
  ceiling: string | null,
  input: InferInput,
  listing: ListingCache,
  policy: InferencePolicy,
  markersOnly: boolean,
): Promise<ClimbResult> {
  const { ctx } = input;
  const platform = ctx.platform;
  const candidates: Candidate[] = [];
  let dir: string | null = start;
  let previous: string | null = null;
  for (let level = 0; dir !== null && level <= policy.maxClimb; level++) {
    if (ceiling && !isStrictlyInside(dir, ceiling, platform)) break;
    if (forbiddenRootReason(dir, ctx)) break;
    if (level > 0 && containsExistingProject(dir, input.existing, platform)) break;
    const entries = await listing.list(dir);
    if (!entries) break;
    if (entries.some((e) => isStrongProjectMarker(e.name))) {
      return {
        kind: 'marker',
        candidate: {
          dir,
          level,
          score: { marker: 3, shape: 0, container: 0, depth: 0, total: 3 },
        },
      };
    }
    if (!markersOnly) {
      const marker = scoreMarker(entries);
      const shape =
        level >= 1 && level <= policy.shapeProbeLevels && previous
          ? await scoreSiblingShape(dir, previous, entries, listing, platform, policy)
          : 0;
      const container = scoreContainerName(dir, platform);
      const depth = scoreDepth(level);
      candidates.push({
        dir,
        level,
        score: { marker, shape, container, depth, total: marker + shape + container + depth },
      });
    }
    previous = dir;
    dir = parentOf(dir, platform);
  }
  let best: Candidate | null = null;
  for (const c of candidates) {
    if (c.score.total < policy.scoreThreshold) continue;
    if (!best || c.score.total > best.score.total) best = c;
  }
  return best ? { kind: 'best', candidate: best } : null;
}

export async function inferProjectRoot(input: InferInput, fs: FsProbe): Promise<InferOutcome> {
  const policy: InferencePolicy = { ...DEFAULT_INFERENCE_POLICY, ...input.policy };
  const { ctx } = input;
  const platform = ctx.platform;
  const target = normalizePath(input.path, platform);
  const listing = new ListingCache(fs, platform, policy.maxEntriesPerDir);

  if (input.kind === 'folder') {
    const exact = input.existing.find(
      (p) => p.workingDir && pathsEqual(p.workingDir, target, platform),
    );
    if (exact) return existingOutcome(exact, ctx);
    const reason = forbiddenRootReason(target, ctx, { explicit: true });
    if (reason) return { matchedBy: 'default', reason, warnings: [] };
    const folder = wellKnownFolderFor(target, input.wellKnown, platform);
    if (folder && pathsEqual(folder.path, target, platform)) {
      return { matchedBy: 'well-known', root: target, name: folder.label, folder, warnings: [] };
    }
    return {
      matchedBy: 'parent',
      root: target,
      name: basenameOf(target, platform),
      ...(folder ? { folder } : {}),
      warnings: [],
    };
  }

  const existing = deepestContainingProject(target, input.existing, platform);
  if (existing) return existingOutcome(existing, ctx);

  const start = parentOf(target, platform);
  if (!start) return { matchedBy: 'default', reason: 'filesystem-root', warnings: [] };
  const startReason = forbiddenRootReason(start, ctx);

  const folder = wellKnownFolderFor(start, input.wellKnown, platform);
  if (folder && !forbiddenRootReason(folder.path, ctx)) {
    const wellKnown: InferOutcome = {
      matchedBy: 'well-known',
      root: normalizePath(folder.path, platform),
      name: folder.label,
      folder,
      warnings: [],
    };
    if (pathsEqual(start, folder.path, platform) || startReason) return wellKnown;
    const found = await climb(
      start,
      folder.path,
      input,
      listing,
      policy,
      policy.climbInsideWellKnown === 'markers-only',
    );
    if (found) {
      return {
        matchedBy: 'climb',
        root: found.candidate.dir,
        name: basenameOf(found.candidate.dir, platform),
        score: found.candidate.score,
        folder,
        warnings: [],
      };
    }
    return wellKnown;
  }

  if (startReason) return { matchedBy: 'default', reason: startReason, warnings: [] };

  const found = await climb(start, null, input, listing, policy, false);
  if (found) {
    return {
      matchedBy: 'climb',
      root: found.candidate.dir,
      name: basenameOf(found.candidate.dir, platform),
      score: found.candidate.score,
      warnings: [],
    };
  }
  return { matchedBy: 'parent', root: start, name: basenameOf(start, platform), warnings: [] };
}

/** Depth of `path` below its well-known root, for callers that want to show it. */
export function depthBelowWellKnown(
  path: string,
  folder: WellKnownFolder,
  platform: InferencePlatform,
): number | null {
  const segs = segmentsBelow(folder.path, path, platform);
  return segs === null ? null : segs.length;
}
