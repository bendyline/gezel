/**
 * Machine-side knowledge asset broker (docs/service-boundaries.md,
 * `machine-knowledge-assets`): a narrow installer of SIGNED COORDINATES into
 * the machine-shared asset store. It never receives queries, prompts, chunk
 * requests, project/session/gezel ids, or user paths — the request shape is
 * `TrustedKnowledgeCoordinate`, nothing else, and archive bytes are resolved
 * broker-side (today: the operator-provisioned local registry directory,
 * `GEZEL_KNOWLEDGE_REGISTRY_DIR`; the Phase-6 signed CDN registry plugs into
 * the same seam). ACL publication follows the shared-model pattern and its
 * SCM-1066 failure posture: a permission repair failure degrades the one
 * catalog, never the service.
 */

import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { KnowledgeMachineInventory, TrustedKnowledgeCoordinate } from '@bendyline/gezel';
import { KnowledgeMachineInventorySchema, createLogger } from '@bendyline/gezel';
import { extractGezkVerified, validateExtractedCatalog } from '@bendyline/gezel-knowledge';
import { SHARED_ASSETS_ENV } from '../models/storage-roots.js';

const log = createLogger('knowledge-assets');

export const KNOWLEDGE_REGISTRY_DIR_ENV = 'GEZEL_KNOWLEDGE_REGISTRY_DIR';

export type EnsureOutcome =
  | { status: 'ready'; path: string }
  | {
      status: 'error';
      code: 'unavailable' | 'not-found' | 'digest-mismatch' | 'invalid';
      error: string;
    };

export interface KnowledgeAssetsBroker {
  available(): boolean;
  ensure(coordinate: TrustedKnowledgeCoordinate): Promise<EnsureOutcome>;
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
  return join(
    root,
    coordinate.publisherId,
    coordinate.catalogId,
    coordinate.version,
    coordinate.expectedDigest.slice(0, 16),
  );
}

export function createKnowledgeAssetsBroker(
  env: NodeJS.ProcessEnv = process.env,
): KnowledgeAssetsBroker {
  const root = sharedKnowledgeRoot(env);
  const inventoryFile = root ? join(root, 'inventory.json') : null;
  /** Serialize ensure calls per coordinate so concurrent daemons coalesce. */
  const inFlight = new Map<string, Promise<EnsureOutcome>>();

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

  /**
   * Broker-side archive resolution — the registry seam. The operator drop
   * directory is scanned for a file whose sha256 equals the coordinate's
   * expected digest; nothing about the requesting daemon reaches it.
   */
  const resolveArchive = async (coordinate: TrustedKnowledgeCoordinate): Promise<string | null> => {
    const registryDir = env[KNOWLEDGE_REGISTRY_DIR_ENV]?.trim();
    if (!registryDir || !isAbsolute(registryDir)) return null;
    const preferred = join(registryDir, `${coordinate.catalogId}-${coordinate.version}.gezk`);
    const candidates: string[] = [];
    if (await stat(preferred).catch(() => null)) candidates.push(preferred);
    for (const name of await readdir(registryDir).catch(() => [])) {
      const abs = join(registryDir, name);
      if (name.endsWith('.gezk') && abs !== preferred) candidates.push(abs);
    }
    for (const candidate of candidates) {
      if ((await hashFile(candidate)) === coordinate.expectedDigest) return candidate;
    }
    return null;
  };

  const ensureImpl = async (coordinate: TrustedKnowledgeCoordinate): Promise<EnsureOutcome> => {
    if (!root)
      return { status: 'error', code: 'unavailable', error: 'shared asset store not configured' };
    const target = sharedKnowledgeVersionDir(root, coordinate);
    if (await stat(join(target, 'manifest.json')).catch(() => null)) {
      return { status: 'ready', path: target };
    }
    const archive = await resolveArchive(coordinate);
    if (!archive) {
      return {
        status: 'error',
        code: 'not-found',
        error: `no archive for ${coordinate.catalogId}@${coordinate.version} with digest ${coordinate.expectedDigest.slice(0, 16)}… in the machine knowledge registry`,
      };
    }

    const staging = `${target}.staging-${process.pid}-${randomUUID()}`;
    try {
      await mkdir(dirname(target), { recursive: true });
      await extractGezkVerified(archive, staging);
      const report = await validateExtractedCatalog(staging, { deep: false });
      if (!report.ok) {
        const failed = report.checks.find((c) => !c.ok);
        return {
          status: 'error',
          code: 'invalid',
          error: `catalog failed validation: ${failed?.name}${failed?.detail ? ` (${failed.detail})` : ''}`,
        };
      }
      await rm(target, { recursive: true, force: true });
      await rename(staging, target);
    } catch (err) {
      await rm(staging, { recursive: true, force: true }).catch(() => {});
      return {
        status: 'error',
        code: 'invalid',
        error: err instanceof Error ? err.message : String(err),
      };
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
    return { status: 'ready', path: target };
  };

  return {
    available: () => root !== null,
    ensure: (coordinate) => {
      const key = `${coordinate.publisherId}/${coordinate.catalogId}/${coordinate.version}/${coordinate.expectedDigest}`;
      let promise = inFlight.get(key);
      if (!promise) {
        promise = ensureImpl(coordinate).finally(() => inFlight.delete(key));
        inFlight.set(key, promise);
      }
      return promise;
    },
    status: async (coordinate) => {
      if (!root) return { installed: false };
      const target = sharedKnowledgeVersionDir(root, coordinate);
      return { installed: Boolean(await stat(join(target, 'manifest.json')).catch(() => null)) };
    },
    inventory: readInventory,
    reclaim: async (coordinate) => {
      if (!root) return { removed: false };
      const target = sharedKnowledgeVersionDir(root, coordinate);
      const existed = Boolean(await stat(target).catch(() => null));
      await rm(target, { recursive: true, force: true }).catch(() => {});
      const inventory = await readInventory();
      inventory.catalogs = inventory.catalogs.filter(
        (c) =>
          !(
            c.publisherId === coordinate.publisherId &&
            c.catalogId === coordinate.catalogId &&
            c.version === coordinate.version
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
