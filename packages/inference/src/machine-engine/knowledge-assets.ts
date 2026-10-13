/**
 * Machine-side knowledge asset broker (docs/service-boundaries.md,
 * `machine-knowledge-assets`): a narrow installer of TRUSTED COORDINATES into
 * the machine-shared asset store. It never receives queries, prompts, chunk
 * requests, project/session/gezel ids, user paths, or URLs — the request
 * shape is `TrustedKnowledgeCoordinate`, nothing else, and archive bytes are
 * resolved broker-side in a fixed ladder: the operator drop directory
 * (`GEZEL_KNOWLEDGE_REGISTRY_DIR`), the shipped gilde `knowledge-catalog`
 * pin (the same trust root the user daemon uses), then the optional signed
 * publisher registry (`GEZEL_KNOWLEDGE_REGISTRY_URL`). Installs run as
 * background jobs in a ChatModelInstallRegistry keyed by coordinate, so a
 * requesting daemon can stream progress, disconnect without abandoning the
 * download, attach again, or cancel explicitly. ACL publication follows the
 * shared-model pattern and its SCM-1066 failure posture: a permission repair
 * failure degrades the one catalog, never the service.
 */

import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type {
  KnowledgeCatalogRef,
  KnowledgeInstallEvent,
  KnowledgeMachineInventory,
  KnowledgeRegistryIndex,
  TrustedKnowledgeCoordinate,
} from '@bendyline/gezel';
import {
  KnowledgeMachineInventorySchema,
  TrustedKnowledgeCoordinateSchema,
  awakeTimeoutSignal,
  createLogger,
} from '@bendyline/gezel';
import type { CatalogService } from '@bendyline/gezel-catalog';
import {
  extractGezkVerified,
  fetchKnowledgeRegistry,
  findRegistryEntry,
  inspectGezkArchive,
  validateExtractedCatalog,
} from '@bendyline/gezel-knowledge';
import { isPathInside, realpathContained } from '../fs/safe-paths.js';
import { resolveKnowledgeCatalogSource } from '../knowledge/catalog-source.js';
import { loadKnowledgeTrustAnchors } from '../knowledge/trust-anchors.js';
import { ChatModelInstallRegistry } from '../models/install-registry.js';
import { SHARED_ASSETS_ENV } from '../models/storage-roots.js';
import { downloadWithRetry } from '../utils/download-with-retry.js';

const log = createLogger('knowledge-assets');

export const KNOWLEDGE_REGISTRY_DIR_ENV = 'GEZEL_KNOWLEDGE_REGISTRY_DIR';
/**
 * A signed publisher registry URL (Phase 6). Operator-configured on the
 * BROKER side only — a requesting daemon can never supply a URL; its request
 * stays a bare TrustedKnowledgeCoordinate. The registry merely locates
 * bytes: the coordinate's expectedDigest is still verified on the download.
 */
export const KNOWLEDGE_REGISTRY_URL_ENV = 'GEZEL_KNOWLEDGE_REGISTRY_URL';

const REGISTRY_CACHE_TTL_MS = 5 * 60 * 1000;
const REGISTRY_FETCH_BUDGET_MS = 30_000;
const ARCHIVE_DOWNLOAD_BUDGET_MS = 30 * 60 * 1000;
/** Finished installs stay attachable long enough for a slow requester to observe the result. */
const FINISHED_TTL_MS = 60_000;

export type EnsureErrorCode =
  | 'unavailable'
  | 'not-found'
  | 'digest-mismatch'
  | 'invalid'
  | 'cancelled';

export type EnsureOutcome =
  | { status: 'ready'; path: string }
  | { status: 'error'; code: EnsureErrorCode; error: string };

/**
 * The broker's install stream: the shared install-event vocabulary, with
 * the outcome code riding on errors so the one-shot `ensure` can map it to
 * an HTTP status. Absent on the registry's own synthesized cancel error.
 */
export type BrokerInstallEvent =
  | Exclude<KnowledgeInstallEvent, { type: 'error' }>
  | {
      type: 'error';
      error: string;
      code?: EnsureErrorCode;
      mismatch?: { expected: string; actual: string };
    };

export interface KnowledgeAssetsBroker {
  available(): boolean;
  /** Install (or find) the coordinate and wait for the result. */
  ensure(coordinate: TrustedKnowledgeCoordinate): Promise<EnsureOutcome>;
  /** Start the install as a background job, or attach to the running one. */
  startStream(coordinate: TrustedKnowledgeCoordinate): { key: string; alreadyRunning: boolean };
  cancel(coordinate: TrustedKnowledgeCoordinate): boolean;
  /** The job registry `startStream` feeds; subscribe by the key it returns. */
  readonly installs: ChatModelInstallRegistry<BrokerInstallEvent, TrustedKnowledgeCoordinate>;
  status(coordinate: TrustedKnowledgeCoordinate): Promise<{ installed: boolean }>;
  inventory(): Promise<KnowledgeMachineInventory>;
  reclaim(coordinate: TrustedKnowledgeCoordinate): Promise<{ removed: boolean }>;
}

export function sharedKnowledgeRoot(env: NodeJS.ProcessEnv = process.env): string | null {
  const configured = env[SHARED_ASSETS_ENV]?.trim();
  if (!configured || !isAbsolute(configured)) return null;
  return join(resolve(configured), 'knowledge');
}

export function sharedKnowledgeVersionDir(
  root: string,
  coordinate: TrustedKnowledgeCoordinate,
): string {
  const trusted = TrustedKnowledgeCoordinateSchema.parse(coordinate);
  return join(
    root,
    trusted.publisherId,
    trusted.catalogId,
    trusted.version,
    trusted.expectedDigest.slice(0, 16),
  );
}

export function coordinateKey(coordinate: TrustedKnowledgeCoordinate): string {
  return `${coordinate.publisherId}/${coordinate.catalogId}/${coordinate.version}/${coordinate.expectedDigest}`;
}

type LocatedArchive =
  | { kind: 'local'; path: string }
  | { kind: 'remote'; url: string; archiveBytes: number; source: 'catalog' | 'registry' };

export function createKnowledgeAssetsBroker(
  env: NodeJS.ProcessEnv = process.env,
  opts: {
    /** The gilde loader: a `knowledge-catalog` pin is the second rung of the ladder. */
    catalog?: CatalogService;
  } = {},
): KnowledgeAssetsBroker {
  const root = sharedKnowledgeRoot(env);
  const inventoryFile = root ? join(root, 'inventory.json') : null;

  const readInventory = async (): Promise<KnowledgeMachineInventory> => {
    if (!inventoryFile) return { version: 1, catalogs: [] };
    try {
      return KnowledgeMachineInventorySchema.parse(
        JSON.parse(await readFile(inventoryFile, 'utf8')),
      );
    } catch {
      return { version: 1, catalogs: [] };
    }
  };

  const writeInventory = async (inventory: KnowledgeMachineInventory): Promise<void> => {
    if (!inventoryFile) return;
    await mkdir(dirname(inventoryFile), { recursive: true });
    const tmp = `${inventoryFile}.tmp`;
    await writeFile(tmp, `${JSON.stringify(inventory, null, 2)}\n`, 'utf8');
    await rename(tmp, inventoryFile);
  };

  /** Verified registry document cache — one fetch per TTL window, not per ensure. */
  let registryCache: { url: string; fetchedAt: number; registry: KnowledgeRegistryIndex } | null =
    null;

  const fetchRegistry = async (): Promise<KnowledgeRegistryIndex | null> => {
    const url = env[KNOWLEDGE_REGISTRY_URL_ENV]?.trim();
    if (!url) return null;
    if (
      registryCache &&
      registryCache.url === url &&
      Date.now() - registryCache.fetchedAt < REGISTRY_CACHE_TTL_MS
    ) {
      return registryCache.registry;
    }
    const anchors = loadKnowledgeTrustAnchors(env);
    if (anchors.length === 0) {
      log.warn(`${KNOWLEDGE_REGISTRY_URL_ENV} is set but no trust anchors are available; ignoring`);
      return null;
    }
    try {
      const { registry, keyId } = await fetchKnowledgeRegistry(url, {
        anchors,
        signal: awakeTimeoutSignal(REGISTRY_FETCH_BUDGET_MS),
      });
      log.info(`knowledge registry verified (publisher ${registry.publisher.id}, key ${keyId})`);
      registryCache = { url, fetchedAt: Date.now(), registry };
      return registry;
    } catch (err) {
      log.warn(
        `knowledge registry fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  };

  /**
   * The gilde rung: the shipped `knowledge-catalog` entry for this id and
   * version, accepted only when its publisher and pinned sha256 equal the
   * coordinate's — a pin that disagrees is not this rung's answer.
   */
  const locateFromCatalog = async (
    coordinate: TrustedKnowledgeCoordinate,
  ): Promise<LocatedArchive | null> => {
    if (!opts.catalog) return null;
    const resolved = await resolveKnowledgeCatalogSource(
      opts.catalog,
      coordinate.catalogId,
      coordinate.version,
    ).catch(() => null);
    if (!resolved) return null;
    if (
      resolved.coordinate.publisherId !== coordinate.publisherId ||
      resolved.sha256 !== coordinate.expectedDigest
    ) {
      return null;
    }
    return {
      kind: 'remote',
      url: resolved.url,
      archiveBytes: resolved.archiveBytes,
      source: 'catalog',
    };
  };

  /**
   * Broker-side archive resolution — the ladder. Nothing about the
   * requesting daemon reaches any rung. Downloaded archives are ephemeral:
   * deleted after extraction.
   */
  const locateArchive = async (
    coordinate: TrustedKnowledgeCoordinate,
  ): Promise<LocatedArchive | null> => {
    const registryDir = env[KNOWLEDGE_REGISTRY_DIR_ENV]?.trim();
    if (registryDir && isAbsolute(registryDir)) {
      const preferred = join(registryDir, `${coordinate.catalogId}-${coordinate.version}.gezk`);
      const candidates: string[] = [];
      if (await stat(preferred).catch(() => null)) candidates.push(preferred);
      for (const name of await readdir(registryDir).catch(() => [])) {
        const abs = join(registryDir, name);
        if (name.endsWith('.gezk') && abs !== preferred) candidates.push(abs);
      }
      for (const candidate of candidates) {
        if ((await hashFile(candidate)) === coordinate.expectedDigest) {
          return { kind: 'local', path: candidate };
        }
      }
    }

    const pinned = await locateFromCatalog(coordinate);
    if (pinned) return pinned;

    const registry = await fetchRegistry();
    if (registry) {
      const entry = findRegistryEntry(registry, {
        publisherId: coordinate.publisherId,
        catalogId: coordinate.catalogId,
        version: coordinate.version,
        contentDigest: coordinate.expectedDigest,
      });
      if (entry) {
        return {
          kind: 'remote',
          url: entry.url,
          archiveBytes: entry.archiveBytes,
          source: 'registry',
        };
      }
    }
    return null;
  };

  /**
   * Download a located archive into the broker's staging area through the
   * shared downloader (resume, retry, stall detection, Xet), streaming its
   * progress. The declared byte size is a hard cap; the caller verifies the
   * coordinate digest on the result. Returns the failure message, or null.
   * A budget timeout or a cancel leaves the `.partial` in place so the next
   * request resumes instead of restarting.
   */
  async function* downloadArchive(
    url: string,
    maxBytes: number,
    destination: string,
    signal: AbortSignal,
  ): AsyncGenerator<BrokerInstallEvent, string | null> {
    await mkdir(dirname(destination), { recursive: true });
    const download = downloadWithRetry({
      url,
      destPath: destination,
      approxSizeBytes: maxBytes,
      maxBytes,
      signal,
    });
    try {
      while (true) {
        const step = await download.next();
        if (step.done) {
          const result = step.value;
          if (result.kind === 'ok') {
            await rm(destination, { force: true });
            await rename(`${destination}.partial`, destination);
            return null;
          }
          if (result.kind === 'aborted') {
            return 'archive download ran out of its time budget; it resumes on the next request';
          }
          return result.error;
        }
        if (step.value.type === 'progress') {
          yield {
            type: 'progress',
            phase: 'download',
            bytesDone: step.value.bytesWritten,
            bytesTotal: step.value.totalBytes,
          };
        } else {
          yield {
            type: 'retrying',
            attempt: step.value.attempt,
            maxAttempts: step.value.maxAttempts,
            delayMs: step.value.delayMs,
            reason: step.value.reason,
          };
        }
      }
    } finally {
      // A cancel closes this generator at a yield; unwind the download too
      // so its file handle does not outlive the job.
      await download.return(undefined as never).catch(() => {});
    }
  }

  async function* ensureEvents(
    coordinate: TrustedKnowledgeCoordinate,
  ): AsyncGenerator<BrokerInstallEvent> {
    if (!root) {
      yield { type: 'error', code: 'unavailable', error: 'shared asset store not configured' };
      return;
    }
    await mkdir(root, { recursive: true });
    const target = sharedKnowledgeVersionDir(root, coordinate);
    await assertKnowledgePathContained(root, target);
    const ref: KnowledgeCatalogRef = {
      publisherId: coordinate.publisherId,
      catalogId: coordinate.catalogId,
      version: coordinate.version,
      contentDigest: coordinate.expectedDigest,
      storageScope: 'machine-shared',
    };
    if (await stat(join(target, 'manifest.json')).catch(() => null)) {
      yield { type: 'done', ref, rootDir: target, storageScope: 'machine-shared' };
      return;
    }
    const located = await locateArchive(coordinate);
    if (!located) {
      yield {
        type: 'error',
        code: 'not-found',
        error: `no archive for ${coordinate.catalogId}@${coordinate.version} with digest ${coordinate.expectedDigest.slice(0, 16)}… in the machine knowledge registry`,
      };
      return;
    }

    // The abort covers a cancel that lands while the download is mid-flight;
    // the awake budget bounds a download nobody cancelled.
    const abort = new AbortController();
    let archive: string | null = null;
    let ephemeral = false;
    try {
      if (located.kind === 'local') {
        archive = located.path;
      } else {
        archive = join(root, 'downloads', `${coordinate.expectedDigest.slice(0, 16)}.gezk`);
        await assertKnowledgePathContained(root, archive);
        ephemeral = true;
        const failure = yield* downloadArchive(
          located.url,
          located.archiveBytes,
          archive,
          AbortSignal.any([abort.signal, awakeTimeoutSignal(ARCHIVE_DOWNLOAD_BUDGET_MS)]),
        );
        if (failure) {
          log.warn(
            `${located.source} archive download failed for ${coordinate.catalogId}@${coordinate.version}: ${failure}`,
          );
          yield { type: 'error', code: 'not-found', error: failure };
          return;
        }
        yield { type: 'verifying' };
        const actual = await hashFile(archive);
        if (actual !== coordinate.expectedDigest) {
          await rm(archive, { force: true }).catch(() => {});
          ephemeral = false;
          log.warn(
            `${located.source} archive for ${coordinate.catalogId}@${coordinate.version} failed digest verification`,
          );
          yield {
            type: 'error',
            code: 'digest-mismatch',
            error: `archive sha256 mismatch: expected ${coordinate.expectedDigest}, got ${actual}`,
            mismatch: { expected: coordinate.expectedDigest, actual },
          };
          return;
        }
      }

      const inspection = await inspectGezkArchive(archive).catch(() => null);
      const manifest = inspection?.manifest;
      if (
        !manifest ||
        manifest.publisher.id !== coordinate.publisherId ||
        manifest.id !== coordinate.catalogId ||
        manifest.version !== coordinate.version
      ) {
        yield {
          type: 'error',
          code: 'invalid',
          error: 'archive manifest identity does not match the trusted coordinate',
        };
        return;
      }

      yield {
        type: 'progress',
        phase: 'extract',
        bytesDone: 0,
        bytesTotal: inspection.totalUncompressedBytes,
      };
      const staging = `${target}.staging-${process.pid}-${randomUUID()}`;
      try {
        await mkdir(dirname(target), { recursive: true });
        await assertKnowledgePathContained(root, target);
        await extractGezkVerified(archive, staging);
        const report = await validateExtractedCatalog(staging, { deep: true });
        if (!report.ok) {
          const failed = report.checks.find((c) => !c.ok);
          yield {
            type: 'error',
            code: 'invalid',
            error: `catalog failed validation: ${failed?.name}${failed?.detail ? ` (${failed.detail})` : ''}`,
          };
          return;
        }
        await assertKnowledgePathContained(root, target);
        await rm(target, { recursive: true, force: true });
        await rename(staging, target);
      } catch (err) {
        yield {
          type: 'error',
          code: 'invalid',
          error: err instanceof Error ? err.message : String(err),
        };
        return;
      } finally {
        await rm(staging, { recursive: true, force: true }).catch(() => {});
      }
    } finally {
      abort.abort();
      if (ephemeral && archive) await rm(archive, { force: true }).catch(() => {});
    }

    // ACL publication — per-item, NEVER fatal (the SCM-1066 lesson).
    await makeSharedKnowledgeReadable(target, env).catch((err) => {
      log.warn(
        `catalog ${coordinate.catalogId} installed but permission publish failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });

    const inventory = await readInventory();
    const bytes = await treeBytes(target);
    inventory.catalogs = inventory.catalogs.filter(
      (c) => !(c.publisherId === coordinate.publisherId && c.catalogId === coordinate.catalogId),
    );
    inventory.catalogs.push({
      publisherId: coordinate.publisherId,
      catalogId: coordinate.catalogId,
      version: coordinate.version,
      contentDigest: coordinate.expectedDigest,
      publishedAt: new Date().toISOString(),
      bytes,
    });
    await writeInventory(inventory);
    yield { type: 'done', ref, rootDir: target, storageScope: 'machine-shared' };
  }

  const installs = new ChatModelInstallRegistry<BrokerInstallEvent, TrustedKnowledgeCoordinate>({
    engine: 'knowledge-assets',
    run: (_key, coordinate) => ensureEvents(coordinate),
    finishedTtlMs: FINISHED_TTL_MS,
  });

  const startStream = (coordinate: TrustedKnowledgeCoordinate) => {
    const trusted = TrustedKnowledgeCoordinateSchema.parse(coordinate);
    const key = coordinateKey(trusted);
    const { alreadyRunning } = installs.start(key, trusted);
    return { key, alreadyRunning };
  };

  return {
    installs,
    available: () => root !== null,
    startStream,
    cancel: (coordinate) =>
      installs.cancel(coordinateKey(TrustedKnowledgeCoordinateSchema.parse(coordinate))),
    ensure: (coordinate) => {
      const { key } = startStream(coordinate);
      return new Promise<EnsureOutcome>((resolveOutcome) => {
        let settled = false;
        let unsubscribe: (() => void) | null = null;
        const settle = (outcome: EnsureOutcome) => {
          if (settled) return;
          settled = true;
          resolveOutcome(outcome);
          unsubscribe?.();
        };
        unsubscribe = installs.subscribe(key, (event) => {
          if (event.type === 'done') settle({ status: 'ready', path: event.rootDir });
          else if (event.type === 'error') {
            settle({ status: 'error', code: event.code ?? 'cancelled', error: event.error });
          }
        });
        if (!unsubscribe) {
          settle({
            status: 'error',
            code: 'unavailable',
            error: 'install ended before it could be observed',
          });
        } else if (settled) {
          unsubscribe();
        }
      });
    },
    status: async (coordinate) => {
      if (!root) return { installed: false };
      const trusted = TrustedKnowledgeCoordinateSchema.parse(coordinate);
      await mkdir(root, { recursive: true });
      const target = sharedKnowledgeVersionDir(root, trusted);
      await assertKnowledgePathContained(root, target);
      return { installed: Boolean(await stat(join(target, 'manifest.json')).catch(() => null)) };
    },
    inventory: readInventory,
    reclaim: async (coordinate) => {
      if (!root) return { removed: false };
      const trusted = TrustedKnowledgeCoordinateSchema.parse(coordinate);
      await mkdir(root, { recursive: true });
      const target = sharedKnowledgeVersionDir(root, trusted);
      await assertKnowledgePathContained(root, target);
      const existed = Boolean(await stat(target).catch(() => null));
      await rm(target, { recursive: true, force: true }).catch(() => {});
      const inventory = await readInventory();
      inventory.catalogs = inventory.catalogs.filter(
        (c) =>
          !(
            c.publisherId === trusted.publisherId &&
            c.catalogId === trusted.catalogId &&
            c.version === trusted.version
          ),
      );
      await writeInventory(inventory);
      return { removed: existed };
    },
  };
}

/** chmod 0o644/0o755 through the tree + Windows inherited-ACL reset. */
async function makeSharedKnowledgeReadable(target: string, env: NodeJS.ProcessEnv): Promise<void> {
  if (env.GEZEL_SYSTEM_SCOPE !== '1') return;
  const root = sharedKnowledgeRoot(env);
  if (!root) throw new Error('shared asset store not configured');
  await assertKnowledgePathContained(root, target);
  const { chmod, lstat, readdir: readDir } = await import('node:fs/promises');
  const walk = async (dir: string): Promise<void> => {
    await chmod(dir, 0o755);
    for (const entry of await readDir(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      const info = await lstat(abs);
      if (info.isSymbolicLink()) throw new Error(`refusing to publish symlink: ${abs}`);
      if (entry.isDirectory()) await walk(abs);
      else await chmod(abs, 0o644);
    }
  };
  await walk(target);
  if (process.platform === 'win32') {
    const { spawn } = await import('node:child_process');
    await new Promise<void>((resolveSpawn, reject) => {
      const child = spawn('icacls.exe', [target, '/reset', '/T', '/L', '/Q'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      child.on('error', reject);
      child.on('exit', (code) =>
        code === 0 ? resolveSpawn() : reject(new Error(`icacls exited ${code}`)),
      );
    });
  }
}

async function treeBytes(dir: string): Promise<number> {
  let total = 0;
  const { readdir: readDir } = await import('node:fs/promises');
  const walk = async (d: string): Promise<void> => {
    for (const entry of await readDir(d, { withFileTypes: true })) {
      const abs = join(d, entry.name);
      if (entry.isDirectory()) await walk(abs);
      else total += (await stat(abs)).size;
    }
  };
  await walk(dir);
  return total;
}

async function assertKnowledgePathContained(root: string, target: string): Promise<void> {
  if (!(isPathInside(target, root) && (await realpathContained(root, target)))) {
    throw new Error(`refusing a shared knowledge path outside the asset root: ${target}`);
  }
}

async function hashFile(path: string): Promise<string> {
  const hasher = createHash('sha256');
  await new Promise<void>((resolveHash, reject) => {
    const stream = createReadStream(path, { highWaterMark: 16 * 1024 * 1024 });
    stream.on('data', (chunk) => hasher.update(chunk));
    stream.on('end', () => resolveHash());
    stream.on('error', reject);
  });
  return hasher.digest('hex');
}
