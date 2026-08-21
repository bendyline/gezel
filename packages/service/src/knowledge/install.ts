/**
 * Private-tier catalog install (docs/knowledge-catalogs.md install sequence):
 * resolve source → disk preflight → resumable download (`.partial` stays on
 * kill, next attempt resumes) → archive sha256 = the ref's contentDigest →
 * verified staged extract (every file hashed against the manifest) → open +
 * count validation in staging → atomic sibling-rename publish → registry
 * pointer → prune older versions. Yields install events; the job registry
 * in manager.ts consumes them.
 */

import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { KnowledgeCatalogRef } from '@bendyline/gezel';
import { createLogger } from '@bendyline/gezel';
import {
  type CatalogValidationReport,
  GEZK_ARCHIVE_LIMITS,
  extractGezkVerified,
  inspectGezkArchive,
  validateExtractedCatalog,
} from '@bendyline/gezel-knowledge';
import {
  knowledgeCatalogVersionDir,
  knowledgeCatalogsDir,
  knowledgeDownloadsDir,
} from '@bendyline/gezel/paths';
import { isPathInside, realpathContained } from '../fs/safe-paths.js';
import { checkDiskSpace, describeDiskShortfall } from '../utils/disk-space.js';
import { downloadWithRetry } from '../utils/download-with-retry.js';
import type { KnowledgeRegistry } from './registry.js';

const log = createLogger('knowledge');

export type KnowledgeInstallEvent =
  | {
      type: 'progress';
      phase: 'download' | 'extract';
      bytesDone: number;
      bytesTotal: number;
    }
  | { type: 'verifying' }
  | { type: 'retrying'; attempt: number; reason: string }
  | { type: 'done'; ref: KnowledgeCatalogRef; rootDir: string }
  | { type: 'error'; error: string };

export type KnowledgeInstallSource =
  | { kind: 'file'; path: string }
  | { kind: 'url'; url: string; expectedSha256: string };

export interface KnowledgeInstallOptions {
  home: string;
  source: KnowledgeInstallSource;
  registry: KnowledgeRegistry;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  /** Production supplies the worker-backed validator so untrusted SQLite is
   * never opened on the daemon event-loop thread. */
  validateCatalog?: (rootDir: string, deep: boolean) => Promise<CatalogValidationReport>;
}

const MAX_GEZK_ARCHIVE_BYTES = GEZK_ARCHIVE_LIMITS.maxTotalBytes + 512 * 1024 * 1024;

export async function* installKnowledgeCatalog(
  opts: KnowledgeInstallOptions,
): AsyncGenerator<KnowledgeInstallEvent, void> {
  let archivePath: string;
  let archiveSha: string | null = null;
  let downloadedTemp = false;

  if (opts.source.kind === 'file') {
    archivePath = resolve(opts.source.path);
    try {
      await stat(archivePath);
    } catch {
      yield { type: 'error', error: `no such file: ${archivePath}` };
      return;
    }
  } else {
    const downloads = knowledgeDownloadsDir(opts.home);
    await mkdir(downloads, { recursive: true });
    const nameHash = createHash('sha256')
      .update(opts.source.url, 'utf8')
      .digest('hex')
      .slice(0, 16);
    archivePath = join(downloads, `${nameHash}.gezk`);
    downloadedTemp = true;

    const disk = await checkDiskSpace(downloads, 0);
    if (!disk.ok) {
      yield { type: 'error', error: describeDiskShortfall(disk, 'the catalog download') };
      return;
    }

    const download = downloadWithRetry({
      url: opts.source.url,
      destPath: archivePath,
      approxSizeBytes: 0,
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
      maxBytes: MAX_GEZK_ARCHIVE_BYTES,
    });
    let final: { bytesWritten: number; sha256?: string } | null = null;
    while (true) {
      const step = await download.next();
      if (step.done) {
        const value = step.value;
        if (value.kind === 'aborted') return; // .partial stays for resume
        if (value.kind !== 'ok') {
          yield { type: 'error', error: value.error };
          return;
        }
        final = value;
        break;
      }
      if (step.value.type === 'progress') {
        yield {
          type: 'progress',
          phase: 'download',
          bytesDone: step.value.bytesWritten,
          bytesTotal: step.value.totalBytes,
        };
      } else {
        yield { type: 'retrying', attempt: step.value.attempt, reason: step.value.reason };
      }
    }
    // Rename .partial into place; sha comes inline only on a fresh full
    // transfer — resumed downloads are re-hashed below like local files.
    await rm(archivePath, { force: true });
    await rename(`${archivePath}.partial`, archivePath);
    archiveSha = final?.sha256 ?? null;
  }

  try {
    yield { type: 'verifying' };
    if (!archiveSha) archiveSha = await hashFile(archivePath);
    if (opts.source.kind === 'url') {
      const expected = opts.source.expectedSha256.toLowerCase();
      if (archiveSha !== expected) {
        yield {
          type: 'error',
          error: `archive sha256 mismatch: expected ${expected}, got ${archiveSha}`,
        };
        return;
      }
    }

    const inspection = await inspectGezkArchive(archivePath);
    const manifest = inspection.manifest;
    const ref: KnowledgeCatalogRef = {
      publisherId: manifest.publisher.id,
      catalogId: manifest.id,
      version: manifest.version,
      contentDigest: archiveSha,
      storageScope: 'user',
    };

    const targetDir = knowledgeCatalogVersionDir(
      opts.home,
      ref.publisherId,
      ref.catalogId,
      ref.version,
      ref.contentDigest,
    );
    const catalogsRoot = knowledgeCatalogsDir(opts.home);
    await mkdir(catalogsRoot, { recursive: true });
    await assertKnowledgePathContained(catalogsRoot, targetDir);
    const existing = await stat(join(targetDir, 'manifest.json')).catch(() => null);
    if (existing) {
      // Bytes already on disk — just (re)point the registry.
      opts.registry.upsert(ref, { enabled: true });
      yield { type: 'done', ref, rootDir: targetDir };
      return;
    }

    const archiveBytes = (await stat(archivePath)).size;
    const disk = await checkDiskSpace(dirname(targetDir), inspection.totalUncompressedBytes);
    if (!disk.ok) {
      yield { type: 'error', error: describeDiskShortfall(disk, 'the catalog install') };
      return;
    }

    // Staged extract as a SIBLING of the final dir: same volume, so the
    // publish rename is atomic; the suffix keeps concurrent installs apart.
    const staging = `${targetDir}.staging-${process.pid}-${randomUUID()}`;
    try {
      await mkdir(dirname(targetDir), { recursive: true });
      await assertKnowledgePathContained(catalogsRoot, targetDir);
      yield {
        type: 'progress',
        phase: 'extract',
        bytesDone: 0,
        bytesTotal: inspection.totalUncompressedBytes,
      };
      await extractGezkVerified(archivePath, staging);

      // Full integrity validation happens before publish. Production injects
      // the worker-backed host; direct callers use the library validator.
      const report = opts.validateCatalog
        ? await opts.validateCatalog(staging, true)
        : await validateExtractedCatalog(staging, { deep: true });
      if (!report.ok) {
        const failed = report.checks.filter((c) => !c.ok);
        yield {
          type: 'error',
          error: `catalog failed validation: ${failed.map((c) => `${c.name}${c.detail ? ` (${c.detail})` : ''}`).join('; ')}`,
        };
        return;
      }

      await assertKnowledgePathContained(catalogsRoot, targetDir);
      await rm(targetDir, { recursive: true, force: true });
      await rename(staging, targetDir);
    } catch (err) {
      await rm(staging, { recursive: true, force: true }).catch(() => {});
      throw err;
    }

    opts.registry.upsert(ref, { enabled: true });
    await pruneOtherVersions(opts.home, ref);
    yield { type: 'done', ref, rootDir: targetDir };
  } catch (err) {
    yield { type: 'error', error: err instanceof Error ? err.message : String(err) };
  } finally {
    if (downloadedTemp) await rm(archivePath, { force: true }).catch(() => {});
  }
}

/** Remove every installed version of this catalog except the active ref. */
async function pruneOtherVersions(home: string, ref: KnowledgeCatalogRef): Promise<void> {
  const catalogsRoot = knowledgeCatalogsDir(home);
  const catalogDir = join(catalogsRoot, ref.publisherId, ref.catalogId);
  await assertKnowledgePathContained(catalogsRoot, catalogDir);
  const keepVersion = ref.version;
  const keepDigest = ref.contentDigest.slice(0, 16);
  let versions: string[];
  try {
    versions = await readdir(catalogDir);
  } catch {
    return;
  }
  for (const version of versions) {
    if (version === keepVersion) {
      const digests = await readdir(join(catalogDir, version)).catch(() => []);
      for (const digest of digests) {
        if (digest !== keepDigest) {
          const target = join(catalogDir, version, digest);
          if (await isKnowledgePathContained(catalogsRoot, target)) {
            await rm(target, { recursive: true, force: true }).catch(() => {});
          }
        }
      }
      continue;
    }
    const target = join(catalogDir, version);
    if (!(await isKnowledgePathContained(catalogsRoot, target))) {
      log.warn(`refusing to prune catalog path outside the knowledge root: ${target}`);
      continue;
    }
    await rm(target, { recursive: true, force: true }).catch((err) => {
      log.warn(`prune of ${ref.catalogId}@${version} failed: ${err}`);
    });
  }
}

async function isKnowledgePathContained(root: string, target: string): Promise<boolean> {
  return isPathInside(target, root) && (await realpathContained(root, target));
}

async function assertKnowledgePathContained(root: string, target: string): Promise<void> {
  if (!(await isKnowledgePathContained(root, target))) {
    throw new Error(`refusing a catalog path outside the knowledge root: ${target}`);
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
