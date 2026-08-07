import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { createLogger } from '@bendyline/gezel';
import { windowsDetachedSpawnOptions } from '@bendyline/gezel/native';

const execFileAsync = promisify(execFile);
const log = createLogger('assets');

// A first adoption can require hashing tens of gigabytes. Model inventory is
// requested by several UI paths, so share that work instead of letting each
// request start another full read of the same payload.
const readOnlyVerificationInFlight = new Map<string, Promise<string | null>>();
const verificationCacheWrites = new Map<string, Promise<void>>();

/**
 * Public machine assets are intentionally separate from the machine
 * service's private GEZEL_HOME state. The installer/service host supplies
 * this variable; standalone CLI launches supply the same canonical path as a
 * read-only overlay.
 */
export const SHARED_ASSETS_ENV = 'GEZEL_SHARED_ASSETS_DIR';

export interface ModelStorageRoots {
  /** The only root this process may create, replace, or delete models in. */
  writableRoot: string;
  /**
   * Lower-priority, read-only roots. A standalone CLI uses the machine asset
   * store here; a machine service has none because that store is its writer.
   */
  readOnlyRoots: string[];
}

export interface ModelStorageRootOptions {
  home: string;
  engine: string;
  env?: NodeJS.ProcessEnv;
}

const SHARED_MODEL_ENGINES = [
  'llama-cpp',
  'ds4',
  'mlx',
  'video',
  'sd-cpp',
  'whisper-cpp',
  'recognition',
] as const;

/**
 * Resolve a model store without ever treating the machine service's private
 * home as a fallback. Local assets shadow machine assets with the same id.
 */
export function modelStorageRoots(opts: ModelStorageRootOptions): ModelStorageRoots {
  const env = opts.env ?? process.env;
  const localRoot = join(opts.home, 'engines', opts.engine, 'models');
  const configured = env[SHARED_ASSETS_ENV]?.trim();
  const sharedAssetsRoot = configured && isAbsolute(configured) ? resolve(configured) : undefined;
  const sharedModelRoot = sharedAssetsRoot
    ? join(sharedAssetsRoot, 'models', opts.engine)
    : undefined;

  if (env.GEZEL_SYSTEM_SCOPE === '1' && sharedModelRoot) {
    return { writableRoot: sharedModelRoot, readOnlyRoots: [] };
  }

  return {
    writableRoot: localRoot,
    readOnlyRoots:
      sharedModelRoot && resolve(sharedModelRoot) !== resolve(localRoot) ? [sharedModelRoot] : [],
  };
}

/**
 * One-shot upgrade bridge for machine services that downloaded models into
 * the formerly-private `<home>/engines/<engine>/models` tree. Both locations are on
 * the same machine volume in supported installers, so directory renames are
 * atomic and avoid copying multi-gigabyte weights.
 */
export async function migrateLegacySystemModels(
  home: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  if (env.GEZEL_SYSTEM_SCOPE !== '1' || !env[SHARED_ASSETS_ENV]?.trim()) return 0;
  let moved = 0;
  const publishFailures: string[] = [];
  for (const engine of SHARED_MODEL_ENGINES) {
    const roots = modelStorageRoots({ home, engine, env });
    const legacyRoot = join(home, 'engines', engine, 'models');
    if (resolve(legacyRoot) === resolve(roots.writableRoot)) continue;
    const entries = await readdir(legacyRoot, { withFileTypes: true }).catch(() => null);
    await mkdir(roots.writableRoot, { recursive: true });
    if (entries) {
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const source = join(legacyRoot, entry.name);
        const target = join(roots.writableRoot, entry.name);
        try {
          await lstat(target);
          continue;
        } catch {
          // Missing target is the only state we migrate.
        }
        await rename(source, target);
        moved += 1;
      }
    }

    // Releases before the public asset store did not record a complete
    // per-file hash map. Backfill it while the bundle is still service-only,
    // then widen read access. Also repairs bundles moved by an interrupted
    // upgrade before this loop was introduced.
    const sharedEntries = await readdir(roots.writableRoot, { withFileTypes: true }).catch(
      () => [],
    );
    for (const entry of sharedEntries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const modelDir = join(roots.writableRoot, entry.name);
      try {
        await publishMigratedModel(modelDir, env);
      } catch (error) {
        // Publishing widens read access on ONE bundle. It must never decide
        // whether the daemon boots.
        //
        // This ran unguarded through v1.26219.44 and took the whole service
        // down: the Windows installer had just made Administrators the owner
        // of every pre-existing model while granting the service only Modify,
        // so `icacls /reset` — which needs WRITE_DAC — failed with "Access is
        // denied", the throw escaped startService, and gezeld crash-looped on
        // SCM 1066. The installer grant is fixed (see nsis-hooks.nsh), but the
        // structural bug was that a per-model permission repair was allowed to
        // be fatal at all. Degrade the bundle, not the machine.
        //
        // Consequence of skipping: that bundle keeps its narrower ACL, so other
        // accounts cannot read it until the next successful publish. The broker
        // itself still uses it, so on-device inference is unaffected.
        publishFailures.push(
          `${entry.name}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
  if (publishFailures.length > 0) {
    log.warn(
      `${publishFailures.length} shared model bundle(s) could not be published for ` +
        `cross-account read access and stay broker-only: ${publishFailures.join('; ')}`,
    );
  }
  return moved;
}

async function publishMigratedModel(modelDir: string, env: NodeJS.ProcessEnv): Promise<void> {
  const manifestPath = join(modelDir, 'manifest.json');
  const info = await lstat(manifestPath).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink()) return;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
  } catch {
    return;
  }
  const existing = parsed.fileSha256;
  const hasValidHashes =
    !!existing &&
    typeof existing === 'object' &&
    !Array.isArray(existing) &&
    Object.keys(existing).length > 0 &&
    Object.entries(existing).every(([path, sha]) => isSafeModelPath(path) && isSha256(String(sha)));
  if (!hasValidHashes) {
    const fileSha256 = await hashModelPayloadFiles(modelDir);
    if (Object.keys(fileSha256).length === 0) return;
    await writeFile(
      manifestPath,
      `${JSON.stringify({ ...parsed, fileSha256 }, null, 2)}\n`,
      'utf8',
    );
  }
  await makeSharedModelReadable(modelDir, env);
}

/** Search order: user-owned/writable first, then machine-owned/read-only. */
export function modelSearchRoots(roots: ModelStorageRoots): string[] {
  return [roots.writableRoot, ...roots.readOnlyRoots];
}

/**
 * List ids across an overlay, de-duplicating in search order so a user-owned
 * model intentionally shadows a machine model with the same catalog id.
 */
export async function listOverlayModelIds(roots: ModelStorageRoots): Promise<string[]> {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const root of modelSearchRoots(roots)) {
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch {
      continue;
    }
    for (const id of entries) {
      // Dot-entries are never model ids: `publishStagedModel` parks the old
      // install at `.<id>.gezmodel-backup-<uuid>` during a replace, and a
      // crash mid-publish must not surface that backup as a duplicate model.
      if (id.startsWith('.')) continue;
      if (seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

/**
 * Return the first overlay root containing a readable model manifest.
 * Presence of an incomplete directory in a higher-priority root does not
 * hide a complete machine model.
 */
export async function findModelRoot(roots: ModelStorageRoots, id: string): Promise<string | null> {
  for (const root of modelSearchRoots(roots)) {
    try {
      const info = await lstat(join(root, id, 'manifest.json'));
      if (info.isFile() && !info.isSymbolicLink()) return root;
    } catch {
      // Try the next overlay root.
    }
  }
  return null;
}

export async function modelExistsOnlyReadOnly(
  roots: ModelStorageRoots,
  id: string,
): Promise<boolean> {
  const root = await findModelRoot(roots, id);
  return root !== null && resolve(root) !== resolve(roots.writableRoot);
}

export function readOnlyModelError(id: string): Error {
  return new Error(
    `model "${id}" is supplied by the read-only machine asset store; install a user-owned copy to replace it`,
  );
}

/**
 * Remove a model directory, tolerating the file locks that make a naive
 * `rm` flaky on Windows. Antivirus / Search-Indexer transient holds clear in
 * a few hundred ms, so we retry with backoff. A *persistent* lock (a running
 * llama-server has the GGUF open) never clears on its own — we surface an
 * actionable message rather than the raw `EBUSY`/`EPERM` so the UI can tell
 * the user to switch models first, instead of the delete looking like a no-op.
 */
export async function removeModelDir(itemDir: string): Promise<void> {
  const maxAttempts = 4;
  for (let attempt = 1; ; attempt++) {
    try {
      await rm(itemDir, { recursive: true, force: true });
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      const locked =
        code === 'EBUSY' || code === 'EPERM' || code === 'EACCES' || code === 'ENOTEMPTY';
      if (locked && attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 150 * attempt));
        continue;
      }
      if (locked) {
        throw new Error(
          'Could not delete the model files — a file is still in use. If this model is loaded in a running chat, switch to another model (or wait a moment), then try deleting again.',
        );
      }
      throw err;
    }
  }
}

/**
 * Hash every published payload file except the self-describing manifest.
 *
 * `precomputed` lets a caller that has *already* streamed a file through
 * SHA-256 (the install path verifies every shard against the catalog hash
 * before this runs) hand those digests in, keyed by the same '/'-joined
 * relative path this returns. Matching files are taken from the cache
 * instead of re-read — a multi-GB install would otherwise hash the whole
 * payload from disk twice. Files on disk but absent from the cache (stale
 * shards from a prior install, a dropped mmproj) are still enumerated and
 * hashed, so the returned map always describes the real on-disk payload.
 */
export async function hashModelPayloadFiles(
  modelDir: string,
  precomputed?: Record<string, string>,
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const root = resolve(modelDir);
  for (const path of await listModelPayloadFiles(root)) {
    result[path] = precomputed?.[path] ?? (await sha256File(join(root, ...path.split('/'))));
  }
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * Delete payload files in a model directory that the freshly-written install no
 * longer references. When a model updates in place to a different quant/filename
 * (e.g. gemma4-12b-q4 moving from `…-Q4_K_M.gguf` to `…-qat-UD-Q4_K_XL.gguf`),
 * the rename publishes the new weights but the old file lingers — tens of GB of
 * orphaned weights for one slot. `keep` is the set of '/'-joined relative paths
 * the new manifest references (weights + shards + mmproj + draft). manifest.json
 * and in-flight `.partial` files are never candidates (listModelPayloadFiles
 * already excludes them). Returns the relative paths removed. Best-effort per
 * file — a file we can't remove is left rather than aborting the install.
 */
export async function pruneModelPayloadFiles(
  modelDir: string,
  keep: ReadonlySet<string>,
): Promise<string[]> {
  const removed: string[] = [];
  const root = resolve(modelDir);
  for (const rel of await listModelPayloadFiles(root)) {
    if (keep.has(rel)) continue;
    try {
      await rm(join(root, ...rel.split('/')), { force: true });
      removed.push(rel);
    } catch {
      // Leave a file we can't remove; the reclaim/prune runs again later.
    }
  }
  return removed;
}

/**
 * Revalidate a read-only machine model on first adoption. The user-owned
 * cache records file identity + size + mtime; any change forces full SHA-256
 * verification again. The cache itself never lives beside shared models.
 */
export async function verifyReadOnlyModelPayload(
  roots: ModelStorageRoots,
  modelRoot: string,
  id: string,
  expected: Record<string, string> | undefined,
  onReject?: (reason: string) => void,
): Promise<boolean> {
  if (resolve(modelRoot) === resolve(roots.writableRoot)) return true;

  const key = readOnlyVerificationKey(roots, modelRoot, id, expected);
  let verification = readOnlyVerificationInFlight.get(key);
  if (!verification) {
    verification = (async () => {
      try {
        return await verifyReadOnlyModelPayloadUnchecked(roots, modelRoot, id, expected);
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    })();
    readOnlyVerificationInFlight.set(key, verification);
    void verification.then(() => {
      if (readOnlyVerificationInFlight.get(key) === verification) {
        readOnlyVerificationInFlight.delete(key);
      }
    });
  }

  const reason = await verification;
  if (reason !== null) onReject?.(reason);
  return reason === null;
}

function readOnlyVerificationKey(
  roots: ModelStorageRoots,
  modelRoot: string,
  id: string,
  expected: Record<string, string> | undefined,
): string {
  const expectedFingerprint = createHash('sha256')
    .update(
      JSON.stringify(
        Object.entries(expected ?? {})
          .map(([path, sha]) => [path, sha.toLowerCase()] as const)
          .sort(([left], [right]) => left.localeCompare(right)),
      ),
    )
    .digest('hex');
  return `${resolve(roots.writableRoot)}\n${resolve(modelRoot)}\n${id}\n${expectedFingerprint}`;
}

/** Returns null when the payload verifies, else a human-readable rejection reason. */
async function verifyReadOnlyModelPayloadUnchecked(
  roots: ModelStorageRoots,
  modelRoot: string,
  id: string,
  expected: Record<string, string> | undefined,
): Promise<string | null> {
  if (resolve(modelRoot) === resolve(roots.writableRoot)) return null;
  if (!expected || Object.keys(expected).length === 0) {
    return 'shared manifest has no fileSha256 map (published before hash backfill?)';
  }
  if (Object.entries(expected).some(([path, sha]) => !isSafeModelPath(path) || !isSha256(sha))) {
    return 'shared manifest fileSha256 map contains an unsafe path or malformed hash';
  }

  const modelDir = resolve(modelRoot, id);
  const actualPaths = await listModelPayloadFiles(modelDir);
  const expectedPaths = Object.keys(expected).sort();
  if (
    actualPaths.length !== expectedPaths.length ||
    actualPaths.some((path, index) => path !== expectedPaths[index])
  ) {
    const extra = actualPaths.filter((path) => !expectedPaths.includes(path));
    const missing = expectedPaths.filter((path) => !actualPaths.includes(path));
    return `shared payload files do not match the manifest (extra: [${extra.join(', ')}], missing: [${missing.join(', ')}])`;
  }

  const identities: Record<
    string,
    { dev: number; ino: number; size: number; mtimeMs: number; sha256: string }
  > = {};
  for (const path of expectedPaths) {
    const absolute = join(modelDir, ...path.split('/'));
    const info = await lstat(absolute);
    if (!info.isFile() || info.isSymbolicLink()) {
      return `shared payload entry is not a regular file: ${path}`;
    }
    identities[path] = {
      dev: info.dev,
      ino: info.ino,
      size: info.size,
      mtimeMs: info.mtimeMs,
      sha256: expected[path]!.toLowerCase(),
    };
  }

  const cachePath = join(dirname(roots.writableRoot), 'shared-model-verification.json');
  const cacheKey = `${resolve(modelRoot)}\n${id}`;
  const cache = await readVerificationCache(cachePath);
  if (JSON.stringify(cache[cacheKey]) === JSON.stringify(identities)) return null;

  for (const path of expectedPaths) {
    const actual = await sha256File(join(modelDir, ...path.split('/')));
    if (actual !== expected[path]!.toLowerCase()) {
      return `shared payload hash mismatch for ${path}`;
    }
  }
  await updateVerificationCache(cachePath, cacheKey, identities);
  return null;
}

/**
 * Machine daemons use a restrictive umask for private state. After a model
 * has been fully downloaded and hash-verified, make only that published
 * bundle traversable/readable by ordinary users.
 *
 * Windows needs an explicit inheritance reset. A model imported through the
 * private transaction area, or moved from the legacy private model store,
 * keeps its old DACL when it is renamed within the ProgramData volume. Merely
 * placing that directory below the public `assets` container therefore does
 * not make it readable. Resetting the published tree makes it inherit the
 * installer's read-only BUILTIN\Users ACE without granting users write access.
 */
export async function makeSharedModelReadable(
  modelDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (env.GEZEL_SYSTEM_SCOPE !== '1') return;
  const configured = env[SHARED_ASSETS_ENV]?.trim();
  if (!configured || !isAbsolute(configured)) return;

  const sharedModels = resolve(configured, 'models');
  const target = resolve(modelDir);
  const rel = relative(sharedModels, target);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`refusing to publish model outside the shared asset store: ${target}`);
  }

  await chmodTree(target);
  if (process.platform === 'win32') {
    await resetWindowsAclToInherited(target);
  }
  let ancestor = dirname(target);
  while (ancestor === sharedModels || ancestor.startsWith(`${sharedModels}${sep}`)) {
    const info = await lstat(ancestor);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`refusing a non-directory ancestor in the shared model store: ${ancestor}`);
    }
    try {
      await chmod(ancestor, 0o755);
    } catch {
      // Windows permissions are established by the installer DACL.
    }
    if (ancestor === sharedModels) break;
    ancestor = dirname(ancestor);
  }
}

async function resetWindowsAclToInherited(target: string): Promise<void> {
  try {
    await execFileAsync('icacls.exe', [target, '/reset', '/T', '/L', '/Q'], {
      maxBuffer: 256 * 1024,
      ...windowsDetachedSpawnOptions(),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`could not publish shared model permissions for ${target}: ${detail}`);
  }
}

async function chmodTree(path: string): Promise<void> {
  const info = await lstat(path).catch(() => null);
  if (!info) return;
  if (info.isSymbolicLink()) {
    throw new Error(`refusing to publish a symlink in the shared model store: ${path}`);
  }
  if (!info.isDirectory()) {
    try {
      await chmod(path, 0o644);
    } catch {
      // Windows permissions are established by the installer DACL.
    }
    return;
  }

  const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    await chmodTree(join(path, entry.name));
  }
  try {
    await chmod(path, 0o755);
  } catch {
    // Windows permissions are established by the installer DACL.
  }
}

export interface ReclaimedDownload {
  id: string;
  bytes: number;
}

/** Grace period before an abandoned download is reclaimed. Within it the
 *  `.partial` files still serve as resume credit for a retried install. */
export const ABANDONED_DOWNLOAD_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Delete abandoned model downloads from the writable root.
 *
 * A directory qualifies only when ALL of these hold — the gates are meant to
 * make "we delete something the user wanted" impossible:
 *   - no `manifest.json` (never completed an install, invisible to every
 *     listing surface),
 *   - contains at least one `.partial` file (the downloader's signature —
 *     a hand-placed model directory without one is never touched),
 *   - nothing in it was written for `ttlMs` (default 7 days — within that
 *     window the `.partial` files are resume credit for a retried install),
 *   - not currently being installed (`activeIds`).
 *
 * Only the writable root is swept — read-only machine roots belong to the
 * machine service, which runs its own sweep. Callers run this once at boot;
 * errors are contained per-directory so one unreadable entry can't stop the
 * sweep.
 */
export async function reclaimAbandonedModelDownloads(opts: {
  writableRoot: string;
  activeIds?: ReadonlySet<string>;
  ttlMs?: number;
  now?: number;
}): Promise<ReclaimedDownload[]> {
  const ttlMs = opts.ttlMs ?? ABANDONED_DOWNLOAD_TTL_MS;
  const now = opts.now ?? Date.now();
  const reclaimed: ReclaimedDownload[] = [];
  let entries: string[];
  try {
    entries = await readdir(opts.writableRoot);
  } catch {
    return reclaimed;
  }
  for (const id of entries) {
    if (id.startsWith('.') || opts.activeIds?.has(id)) continue;
    const dir = join(opts.writableRoot, id);
    try {
      const info = await lstat(dir);
      if (!info.isDirectory() || info.isSymbolicLink()) continue;
      const scan = await scanAbandonedCandidate(dir);
      if (!scan || !scan.hasPartial || now - scan.newestMtimeMs < ttlMs) continue;
      await rm(dir, { recursive: true, force: true });
      reclaimed.push({ id, bytes: scan.totalBytes });
    } catch {
      // Skip directories we can't read or remove; the next sweep retries.
    }
  }
  return reclaimed;
}

export interface IncompleteModelDownload {
  id: string;
  /** Total bytes on disk across the directory (payload + `.partial`). */
  bytes: number;
  /** ISO timestamp of the newest write in the directory. */
  updatedAt: string;
  /** Whether a `.partial` is present (a resumable in-flight download vs
   *  stray files left without one). */
  hasPartial: boolean;
}

/**
 * An incomplete download enriched with per-engine catalog context. Managers
 * return this from `listIncomplete()`; the route serializes it as-is.
 */
export interface IncompleteModelDownloadInfo extends IncompleteModelDownload {
  /**
   * True when this id still resolves to a catalog entry the owning engine can
   * source — a re-install resumes from the on-disk `.partial` files rather
   * than starting over. False for stale/removed ids, where delete is the only
   * sensible action.
   */
  resumable: boolean;
  /** Display name from the catalog, when the id still resolves. */
  name?: string;
}

/**
 * List incomplete model downloads in the writable root — directories with no
 * `manifest.json` (so they're invisible to `listInstalled` and every other
 * listing surface) that nonetheless hold bytes. These are interrupted or
 * unverified downloads: they can hold tens of GB yet the user has no way to
 * see or manage them until the 7-day {@link reclaimAbandonedModelDownloads}
 * sweep silently removes them. Surfacing them lets the UI offer resume/delete
 * immediately. Currently-installing ids are excluded (they show as live
 * progress elsewhere). Sorted largest-first — the most disk to reclaim.
 */
export async function listIncompleteModelDownloads(opts: {
  writableRoot: string;
  activeIds?: ReadonlySet<string>;
}): Promise<IncompleteModelDownload[]> {
  const out: IncompleteModelDownload[] = [];
  let entries: string[];
  try {
    entries = await readdir(opts.writableRoot);
  } catch {
    return out;
  }
  for (const id of entries) {
    if (id.startsWith('.') || opts.activeIds?.has(id)) continue;
    const dir = join(opts.writableRoot, id);
    try {
      const info = await lstat(dir);
      if (!info.isDirectory() || info.isSymbolicLink()) continue;
      const scan = await scanAbandonedCandidate(dir);
      if (!scan || scan.totalBytes === 0) continue;
      out.push({
        id,
        bytes: scan.totalBytes,
        updatedAt: new Date(scan.newestMtimeMs).toISOString(),
        hasPartial: scan.hasPartial,
      });
    } catch {
      // Skip directories we can't read; they simply don't surface.
    }
  }
  out.sort((a, b) => b.bytes - a.bytes);
  return out;
}

/**
 * Returns null when the directory holds a `manifest.json` (a real install —
 * never a reclamation candidate), else its abandoned-download profile.
 */
async function scanAbandonedCandidate(
  dir: string,
): Promise<{ hasPartial: boolean; newestMtimeMs: number; totalBytes: number } | null> {
  let hasPartial = false;
  let totalBytes = 0;
  const dirInfo = await lstat(dir);
  let newestMtimeMs = dirInfo.mtimeMs;
  const visit = async (current: string): Promise<boolean> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!(await visit(absolute))) return false;
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name === 'manifest.json') return false;
      const info = await lstat(absolute);
      newestMtimeMs = Math.max(newestMtimeMs, info.mtimeMs);
      totalBytes += info.size;
      if (entry.name.endsWith('.partial')) hasPartial = true;
    }
    return true;
  };
  if (!(await visit(dir))) return null;
  return { hasPartial, newestMtimeMs, totalBytes };
}

function isSafeModelPath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith('/') &&
    !path.includes('\\') &&
    path.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
  );
}

async function listModelPayloadFiles(modelDir: string): Promise<string[]> {
  const root = resolve(modelDir);
  const result: string[] = [];
  const visit = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`refusing a symlink in a model bundle: ${absolute}`);
      }
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (entry.isFile()) {
        // `.partial` is an in-flight download (same rule as
        // listBundleModelFiles); dot-files are OS droppings like .DS_Store.
        // Neither is payload — an interrupted update or a Finder visit must
        // not make an otherwise-complete shared model fail verification.
        if (entry.name.endsWith('.partial') || entry.name.startsWith('.')) continue;
        const path = relative(root, absolute).split(sep).join('/');
        if (path !== 'manifest.json') result.push(path);
      }
    }
  };
  await visit(root);
  return result.sort();
}

function isSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/i.test(value);
}

/**
 * Read buffer for hashing multi-GB model files off disk. The default
 * `createReadStream` highWaterMark is 64 KB, which for a 7 GB file means
 * ~110k `'data'` events — one event-loop turn each. Inside the daemon's busy
 * event loop (chat, scheduler, index scans) those turns queue behind other
 * work and the hash starves: a file that hashes in ~9s idle took 15+ minutes
 * in the running service. A 16 MB buffer cuts it to ~400 turns, so a
 * congested loop barely affects wall time (measured: a 6.3 GB file that
 * hashed in ~9s idle did not finish in 2 min at 64 KB under a busy loop, but
 * stayed ~10s at 16 MB). Hash correctness with this buffer is covered by the
 * hashModelPayloadFiles tests in storage-roots.test.ts.
 */
export const MODEL_HASH_READ_BUFFER_BYTES = 16 * 1024 * 1024;

function sha256File(path: string): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path, { highWaterMark: MODEL_HASH_READ_BUFFER_BYTES });
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolveHash(hash.digest('hex')));
  });
}

type VerificationCache = Record<string, unknown>;

async function readVerificationCache(path: string): Promise<VerificationCache> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as VerificationCache)
      : {};
  } catch {
    return {};
  }
}

async function writeVerificationCache(path: string, cache: VerificationCache): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(cache, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
}

/** Merge cache entries serially so concurrent checks for different models do
 * not overwrite each other's freshly verified identity records. */
async function updateVerificationCache(
  path: string,
  key: string,
  identities: unknown,
): Promise<void> {
  const previous = verificationCacheWrites.get(path) ?? Promise.resolve();
  const write = previous
    .catch(() => {})
    .then(async () => {
      const latest = await readVerificationCache(path);
      latest[key] = identities;
      await writeVerificationCache(path, latest);
    });
  verificationCacheWrites.set(path, write);
  try {
    await write;
  } finally {
    if (verificationCacheWrites.get(path) === write) verificationCacheWrites.delete(path);
  }
}
