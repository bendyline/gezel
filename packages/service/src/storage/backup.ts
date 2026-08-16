import { createWriteStream } from 'node:fs';
import { lstat, mkdir, readdir, rename, rm } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import {
  BACKUP_MANIFEST_KIND,
  BACKUP_SCHEMA_VERSION,
  type BackupManifest,
  type BackupPlan,
  type BackupPlanItem,
  type BackupRequest,
  type StorageJob,
} from '@bendyline/gezel';
import { createLogger, isSharedLibraryProject } from '@bendyline/gezel';
import {
  gezelDir,
  gezelMemoriesDir,
  gezelPaths,
  gezelToolsetsInstallDir,
  projectIndexDir,
  projectPrivateDir,
  projectShadowDir,
  projectStorageDir,
  projectToolsetsInstallDir,
} from '@bendyline/gezel/paths';
import * as yazl from 'yazl';
import { isPathInside } from '../fs/safe-paths.js';
import type { Store } from '../fs/store.js';
import { checkDiskSpace } from '../utils/disk-space.js';
import type { StorageJobManager } from './job-manager.js';
import { measureTree } from './sizes.js';

const log = createLogger('storage');

/**
 * Writes a portable archive of the things only the user has.
 *
 * The whole point is a person can clear their disk — or replace their
 * machine — without losing work. So the contents are chosen by that test:
 * everything you would miss, nothing a fresh install rebuilds on its own,
 * and never the device-bound credentials, which mean nothing on another
 * machine and would be a liability travelling in a file.
 */

/** Warn above this: a multi-GB repo inside a project surprises people. */
const LARGE_WORKSPACE_BYTES = 2 * 1024 ** 3;

/** Derived state a fresh install rebuilds; carrying it wastes GBs. */
function gezelExclusions(home: string, id: string): string[] {
  return [join(gezelMemoriesDir(home, id, undefined), 'index'), gezelToolsetsInstallDir(home, id)];
}

function projectExclusions(home: string, id: string): string[] {
  return [
    projectIndexDir(home, id),
    projectShadowDir(home, id, undefined),
    projectToolsetsInstallDir(home, id),
    join(projectPrivateDir(home, id), 'index'),
    join(projectPrivateDir(home, id), 'terminals'),
    join(projectPrivateDir(home, id), 'scripts', 'runs'),
  ];
}

/** Settings files worth carrying to a new machine. */
function settingsFiles(home: string): string[] {
  const paths = gezelPaths(home);
  return [paths.config, join(home, 'history.jsonl')];
}

export interface BackupDeps {
  home: string;
  store: Store;
  jobs: StorageJobManager;
  version: string;
}

interface SourceItem extends BackupPlanItem {
  /** Absolute directory (or file) this item archives. */
  sourcePath: string;
  /** Path prefix inside the archive. */
  entryPrefix: string;
  exclude: string[];
}

/**
 * Enumerate what a backup would contain, with sizes, before writing anything.
 */
export async function planBackup(
  deps: BackupDeps,
  opts: { destPath?: string; excludeWorkspaces?: boolean } = {},
): Promise<BackupPlan> {
  const items = await collectItems(deps, opts.excludeWorkspaces === true);
  const totalBytes = items.reduce((sum, item) => sum + item.bytes, 0);
  const warnings: string[] = [];

  for (const item of items) {
    if (item.kind === 'project' && item.bytes > LARGE_WORKSPACE_BYTES) {
      warnings.push(
        `"${item.label}" is ${(item.bytes / 1024 ** 3).toFixed(1)} GB — its working files are included. Use the option to leave workspaces out if you keep them in version control.`,
      );
    }
    if (item.external) {
      warnings.push(
        `"${item.label}" is stored outside Gezel's folder; it is copied into the backup.`,
      );
    }
  }

  let destFreeBytes: number | undefined;
  if (opts.destPath) {
    const space = await checkDiskSpace(dirname(resolve(opts.destPath)), totalBytes);
    if (space.known) {
      destFreeBytes = space.freeBytes;
      if (!space.ok) {
        warnings.push('There may not be enough room at the destination for everything selected.');
      }
    }
  }

  return {
    items: items.map(({ sourcePath: _s, entryPrefix: _e, exclude: _x, ...item }) => item),
    totalBytes,
    secretsExcluded: true,
    warnings,
    ...(destFreeBytes === undefined ? {} : { destFreeBytes }),
  };
}

async function collectItems(deps: BackupDeps, excludeWorkspaces: boolean): Promise<SourceItem[]> {
  const { home, store } = deps;
  const external = store.externalFolders;
  const items: SourceItem[] = [];

  for (const gezel of await store.listGezels().catch(() => [])) {
    const dir = gezelDir(home, gezel.id, external);
    const exclude = gezelExclusions(home, gezel.id);
    const size = await measureTree(dir, exclude);
    if (size.fileCount === 0) continue;
    items.push({
      kind: 'gezel',
      id: gezel.id,
      label: gezel.name ?? gezel.id,
      bytes: size.bytes,
      fileCount: size.fileCount,
      external: !isPathInside(dir, home),
      sourcePath: dir,
      entryPrefix: `gezels/${gezel.id}`,
      exclude,
    });
  }

  for (const project of await store.listProjects().catch(() => [])) {
    // The library travels as its own item so a restore lands the documents
    // in whatever shared project the target install already booted with.
    if (isSharedLibraryProject(project)) continue;
    const dir = projectStorageDir(home, project.id);
    const exclude = projectExclusions(home, project.id);
    if (excludeWorkspaces) exclude.push(join(dir, 'workspace'));
    const size = await measureTree(dir, exclude);
    if (size.fileCount === 0) continue;
    items.push({
      kind: 'project',
      id: project.id,
      label: project.name ?? project.id,
      bytes: size.bytes,
      fileCount: size.fileCount,
      external: !isPathInside(dir, home),
      sourcePath: dir,
      entryPrefix: `projects/${project.id}`,
      exclude,
    });
  }

  const documentsRoot = gezelPaths(home, external).documents;
  const documentsSize = await measureTree(documentsRoot);
  if (documentsSize.fileCount > 0) {
    items.push({
      kind: 'document-root',
      id: 'documents',
      label: 'Shared documents',
      bytes: documentsSize.bytes,
      fileCount: documentsSize.fileCount,
      external: !isPathInside(documentsRoot, home),
      sourcePath: documentsRoot,
      entryPrefix: 'documents',
      exclude: [],
    });
  }

  for (const file of settingsFiles(home)) {
    const size = await measureTree(file);
    if (size.fileCount === 0) continue;
    items.push({
      kind: 'settings-file',
      id: relative(home, file).split(sep).join('/'),
      label: relative(home, file),
      bytes: size.bytes,
      fileCount: size.fileCount,
      external: false,
      sourcePath: file,
      entryPrefix: `settings/${relative(home, file).split(sep).join('/')}`,
      exclude: [],
    });
  }

  return items;
}

/**
 * Write the archive. Streams to `<outPath>.partial` and renames on success,
 * so an interrupted run never leaves a truncated file wearing the name of a
 * finished backup — the one file someone reaches for when things go wrong.
 */
export async function runBackup(
  deps: BackupDeps,
  request: BackupRequest,
  job: StorageJob,
): Promise<{ path: string; manifest: BackupManifest }> {
  const { jobs } = deps;
  jobs.update(job.id, { status: 'running' });
  const partialPath = `${request.outPath}.partial`;

  try {
    jobs.setPhase(job.id, 'scan');
    const all = await collectItems(deps, request.excludeWorkspaces === true);
    const selected = filterRequested(all, request);
    if (selected.length === 0) throw new Error('Nothing selected to back up.');

    jobs.update(job.id, {
      totalItems: selected.length,
      totalBytes: selected.reduce((sum, item) => sum + item.bytes, 0),
    });

    const manifest: BackupManifest = {
      schemaVersion: BACKUP_SCHEMA_VERSION,
      kind: BACKUP_MANIFEST_KIND,
      createdAt: new Date().toISOString(),
      gezelVersion: deps.version,
      platform: process.platform,
      // Recorded for diagnosis only. Restore never applies another machine's
      // paths — they mean nothing here.
      externalFolders: deps.store.externalFolders ? { ...deps.store.externalFolders } : null,
      items: selected.map((item) => ({
        kind: item.kind,
        id: item.id,
        label: item.label,
        entryPrefix: item.entryPrefix,
        bytes: item.bytes,
        fileCount: item.fileCount,
      })),
      secretsExcluded: true,
    };

    await mkdir(dirname(resolve(request.outPath)), { recursive: true });
    await rm(partialPath, { force: true });

    jobs.setPhase(job.id, 'write');
    const zip = new yazl.ZipFile();
    zip.addBuffer(Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`), 'manifest.json');

    let bytesQueued = 0;
    let itemsDone = 0;
    for (const item of selected) {
      jobs.setPhase(job.id, 'write', item.label);
      for (const file of await walkFiles(item.sourcePath, item.exclude)) {
        // A single-file item (config.json) already names the entry with its
        // prefix; only directory items append a path within them.
        const entryName =
          file.relative === '' ? item.entryPrefix : `${item.entryPrefix}/${file.relative}`;
        zip.addFile(file.absolute, entryName, {
          // Model-free content compresses; the office documents and images in
          // a workspace mostly do not, and trying costs time either way.
          compress: !isPrecompressed(entryName),
        });
        bytesQueued += file.size;
      }
      itemsDone += 1;
      jobs.update(job.id, { itemsDone, bytesDone: bytesQueued });
    }

    zip.end({ forceZip64Format: bytesQueued >= 0xffff_ffff, comment: '' });
    await pipeline(zip.outputStream, createWriteStream(partialPath, { flags: 'wx' }));
    await rename(partialPath, request.outPath);

    jobs.finish(job.id, {});
    log.info(`[backup] wrote ${request.outPath} (${selected.length} items)`);
    return { path: request.outPath, manifest };
  } catch (err) {
    await rm(partialPath, { force: true }).catch(() => {});
    const reason = err instanceof Error ? err.message : String(err);
    jobs.finish(job.id, { error: reason });
    throw err;
  }
}

function filterRequested(items: SourceItem[], request: BackupRequest): SourceItem[] {
  const include = request.include;
  if (!include) return items;
  return items.filter((item) => {
    if (item.kind === 'gezel') return include.gezels?.includes(item.id) ?? true;
    if (item.kind === 'project') return include.projects?.includes(item.id) ?? true;
    if (item.kind === 'document-root') return include.documents !== false;
    return include.settings !== false;
  });
}

const PRECOMPRESSED =
  /\.(zip|gz|tgz|bz2|xz|7z|png|jpe?g|gif|webp|mp4|mov|mp3|wav|pdf|gguf|safetensors)$/i;
function isPrecompressed(path: string): boolean {
  return PRECOMPRESSED.test(path);
}

interface WalkedFile {
  absolute: string;
  /** '/'-joined path relative to the item root; '' when the item is a file. */
  relative: string;
  size: number;
}

/**
 * Collect regular files under `root`, skipping excluded subtrees, symlinks,
 * and the atomic-write debris that is meaningless outside this machine.
 */
async function walkFiles(root: string, exclude: string[]): Promise<WalkedFile[]> {
  const skip = new Set(exclude.map((p) => resolve(p)));
  const out: WalkedFile[] = [];

  const info = await lstat(root).catch(() => null);
  if (!info) return out;
  if (info.isSymbolicLink()) return out;
  if (!info.isDirectory()) {
    return [{ absolute: root, relative: '', size: info.size }];
  }

  const visit = async (dir: string): Promise<void> => {
    if (skip.has(resolve(dir))) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const absolute = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await visit(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      // A half-written atomic-write temp file is not content.
      if (entry.name.includes('.tmp-')) continue;
      const stat = await lstat(absolute).catch(() => null);
      if (!stat) continue;
      out.push({
        absolute,
        relative: relative(root, absolute).split(sep).join('/'),
        size: stat.size,
      });
    }
  };
  await visit(root);
  return out;
}
