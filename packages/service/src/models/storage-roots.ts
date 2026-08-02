import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, lstat, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

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
      await publishMigratedModel(join(roots.writableRoot, entry.name), env);
    }
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

/** Hash every published payload file except the self-describing manifest. */
export async function hashModelPayloadFiles(modelDir: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const root = resolve(modelDir);
  for (const path of await listModelPayloadFiles(root)) {
    result[path] = await sha256File(join(root, ...path.split('/')));
  }
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
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
  let reason: string | null;
  try {
    reason = await verifyReadOnlyModelPayloadUnchecked(roots, modelRoot, id, expected);
  } catch (err) {
    reason = err instanceof Error ? err.message : String(err);
  }
  if (reason !== null) onReject?.(reason);
  return reason === null;
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
  cache[cacheKey] = identities;
  await writeVerificationCache(cachePath, cache);
  return null;
}

/**
 * Machine daemons use a restrictive umask for private state. After a model
 * has been fully downloaded and hash-verified, make only that published
 * bundle traversable/readable by ordinary users. Windows gets this access
 * from the installer's inherited DACL; chmod is a harmless no-op there.
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

function sha256File(path: string): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
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
