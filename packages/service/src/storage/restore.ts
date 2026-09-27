import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import {
  BACKUP_RESTORABLE_CONFIG_KEYS,
  BACKUP_ROLE_CONFIG_KEYS,
  type BackupManifest,
  BackupManifestSchema,
  type GezelConfig,
  GezelConfigSchema,
  type RestoreConfirm,
  type RestoreReview,
  type RestoreReviewItem,
  type StorageJob,
  backupEntryPrefix,
  createLogger,
  isSafeEntityId,
} from '@bendyline/gezel';
import {
  daemonTransactionsRoot,
  gezelDir,
  gezelPaths,
  projectStorageDir,
} from '@bendyline/gezel/paths';
import * as yauzl from 'yauzl';
import { safeJoin } from '../fs/safe-paths.js';
import type { Store } from '../fs/store.js';
import type { StorageJobManager } from './job-manager.js';
import { invalidateStorageSummary } from './summary.js';

const log = createLogger('storage');

/**
 * Puts a backup's contents back, one reviewed item at a time.
 *
 * Restore never wipes and replaces a home directory. Someone restoring a
 * year-old backup onto a working install would lose everything they have
 * done since, so the archive is inspected first, conflicts are reported by
 * name, and an existing gezel or project is only overwritten when the person
 * says so for that specific item.
 */

/** Reviews live here between scan and confirm; swept on boot like imports. */
function restoresRoot(home: string): string {
  return join(daemonTransactionsRoot(home), 'backup-restores');
}

const REVIEW_TTL_MS = 24 * 60 * 60 * 1000;

export interface RestoreDeps {
  home: string;
  store: Store;
  jobs: StorageJobManager;
}

/**
 * Read the archive's manifest and work out what each item would do to the
 * install as it stands. Nothing is written outside the staging directory.
 */
export async function scanRestore(deps: RestoreDeps, archivePath: string): Promise<RestoreReview> {
  await assertSafeArchive(archivePath);

  const manifest = await readManifest(archivePath);
  if (manifest.kind !== 'gezel-backup') {
    throw new Error('That file is not a Gezel backup.');
  }
  if (manifest.schemaVersion > 1) {
    throw new Error(
      'This backup was made by a newer version of Gezel. Update Gezel, then restore it.',
    );
  }

  const existingGezels = new Set((await deps.store.listGezels().catch(() => [])).map((g) => g.id));
  const existingProjects = new Set(
    (await deps.store.listProjects().catch(() => [])).map((p) => p.id),
  );

  const items: RestoreReviewItem[] = manifest.items.map((item) => ({
    kind: item.kind,
    id: item.id,
    label: item.label,
    bytes: item.bytes,
    fileCount: item.fileCount,
    conflict:
      (item.kind === 'gezel' && existingGezels.has(item.id)) ||
      (item.kind === 'project' && existingProjects.has(item.id))
        ? 'exists'
        : 'none',
  }));

  const warnings: string[] = [];
  if (manifest.externalFolders) {
    warnings.push(
      'This backup came from an install that kept its folders elsewhere. Content is restored into this install’s current locations.',
    );
  }
  warnings.push(
    'Saved credentials are never included in a backup. Reconnect your services after restoring.',
  );
  if (items.some((i) => i.conflict === 'exists')) {
    warnings.push('Some items already exist here. Choose which ones to replace.');
  }

  const review: RestoreReview = {
    restoreId: randomUUID(),
    createdAt: new Date().toISOString(),
    gezelVersion: manifest.gezelVersion,
    archivePath: resolve(archivePath),
    items,
    secretsExcluded: true,
    warnings,
  };

  const stage = join(restoresRoot(deps.home), review.restoreId);
  await mkdir(stage, { recursive: true });
  await writeFile(join(stage, 'review.json'), JSON.stringify(review, null, 2));
  await sweepExpiredReviews(deps.home);
  return review;
}

export async function readReview(home: string, restoreId: string): Promise<RestoreReview | null> {
  const path = safeJoin(restoresRoot(home), join(restoreId, 'review.json'));
  if (!path) return null;
  try {
    return JSON.parse(await readFile(path, 'utf8')) as RestoreReview;
  } catch {
    return null;
  }
}

export async function cancelRestore(home: string, restoreId: string): Promise<void> {
  const stage = safeJoin(restoresRoot(home), restoreId);
  if (!stage) return;
  await rm(stage, { recursive: true, force: true });
}

/**
 * Extract the chosen items into staging, then publish each one by renaming
 * it into place. An existing item is parked alongside first and only deleted
 * once its replacement has landed, so a failure mid-restore leaves the
 * original where it was rather than nothing at all.
 */
export async function runRestore(
  deps: RestoreDeps,
  review: RestoreReview,
  confirm: RestoreConfirm,
  job: StorageJob,
): Promise<{ restored: number; skipped: number }> {
  const { jobs } = deps;
  jobs.update(job.id, { status: 'running' });

  const chosen = new Map(confirm.items.map((item) => [`${item.kind}:${item.id}`, item.action]));
  const planned = review.items.filter((item) => chosen.has(`${item.kind}:${item.id}`));

  // Refusing here rather than at the file layer keeps the rule in one place:
  // an existing item is replaced only when this request said so by name.
  for (const item of planned) {
    if (item.conflict === 'exists' && chosen.get(`${item.kind}:${item.id}`) !== 'replace') {
      jobs.finish(job.id, {
        error: `"${item.label}" already exists. Choose to replace it, or leave it out.`,
      });
      throw new Error(`refusing to overwrite ${item.kind} ${item.id}`);
    }
  }

  jobs.update(job.id, { totalItems: planned.length });
  const stage = join(restoresRoot(deps.home), review.restoreId, 'stage');

  try {
    jobs.setPhase(job.id, 'extract');
    await extractSelected(review.archivePath, stage, planned, confirm.settings === true);
    // Read before anything is published, so unusable settings stop the
    // restore instead of reporting success over a half-applied one.
    const settings = confirm.settings
      ? await readRestorableSettings(join(stage, 'settings'))
      : null;

    jobs.setPhase(job.id, 'publish');
    let restored = 0;
    for (const item of planned) {
      jobs.setPhase(job.id, 'publish', item.label);
      const target = targetPathFor(deps, item.kind, item.id);
      if (!target) continue;
      const staged = join(stage, ...backupEntryPrefix(item).split('/'));
      await publish(staged, target);
      restored += 1;
      jobs.update(job.id, { itemsDone: restored, bytesDone: item.bytes });
    }

    if (settings) await applySettings(deps, settings);

    await deps.store.ensureLayout();
    invalidateStorageSummary();
    // The Store caches records in memory, and a restored gezel arriving
    // underneath it will not appear until that cache is rebuilt.
    jobs.update(job.id, { restartRequired: true });
    jobs.finish(job.id, {});
    await cancelRestore(deps.home, review.restoreId);
    log.info(`[restore] restored ${restored} item(s) from ${review.archivePath}`);
    return { restored, skipped: review.items.length - restored };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    jobs.finish(job.id, { error: reason });
    throw err;
  }
}

/**
 * Where an item lands *now* — computed from this install's configuration,
 * never from the paths the backup was made under.
 */
function targetPathFor(
  deps: RestoreDeps,
  kind: RestoreReviewItem['kind'],
  id: string,
): string | null {
  const external = deps.store.externalFolders;
  if (kind === 'gezel') return gezelDir(deps.home, id, external);
  if (kind === 'project') return projectStorageDir(deps.home, id);
  if (kind === 'document-root') return gezelPaths(deps.home, external).documents;
  return null; // settings files are merged, not swapped wholesale
}

async function publish(staged: string, target: string): Promise<void> {
  const parked = `${target}.restore-parked-${randomUUID().slice(0, 8)}`;
  let didPark = false;
  await mkdir(dirname(target), { recursive: true });
  try {
    await rename(target, parked);
    didPark = true;
  } catch {
    // Nothing there to park — a plain add.
  }
  try {
    await rename(staged, target);
  } catch (err) {
    if (didPark) await rename(parked, target).catch(() => {});
    throw err;
  }
  if (didPark) await rm(parked, { recursive: true, force: true }).catch(() => {});
}

/**
 * The archive's settings, cut down to what a restore may apply: which gezel
 * holds each house role, and the name-display preference. A config also names
 * providers, engine paths and arguments, listeners, folders and the security
 * level, and none of those may come from a file — the same restore on another
 * machine points at things that are not there, and a crafted one could turn
 * Lockdown off. The portable restore keeps the same list.
 */
async function readRestorableSettings(settingsDir: string): Promise<Partial<GezelConfig>> {
  let incoming: unknown;
  try {
    incoming = JSON.parse(await readFile(join(settingsDir, 'config.json'), 'utf8'));
  } catch {
    throw new Error('This backup holds no settings that can be read. Restore it without them.');
  }
  const record =
    incoming && typeof incoming === 'object' ? (incoming as Record<string, unknown>) : {};
  const picked = Object.fromEntries(
    BACKUP_RESTORABLE_CONFIG_KEYS.flatMap((key) =>
      record[key] === undefined ? [] : [[key, record[key]]],
    ),
  );
  const parsed = GezelConfigSchema.safeParse(picked);
  if (!parsed.success) {
    throw new Error('The settings in this backup are not valid. Restore it without them.');
  }
  return parsed.data;
}

async function applySettings(deps: RestoreDeps, settings: Partial<GezelConfig>): Promise<void> {
  const next: Record<string, unknown> = { ...settings };
  const external = deps.store.externalFolders;
  for (const key of BACKUP_ROLE_CONFIG_KEYS) {
    const id = next[key];
    if (id === undefined) continue;
    // A role pointing at a gezel this install does not have would leave it
    // with no Meester; boot then picks one, which is the better outcome.
    const present =
      isSafeEntityId(id) &&
      (await access(join(gezelDir(deps.home, id, external), 'gezel.md')).then(
        () => true,
        () => false,
      ));
    if (!present) delete next[key];
  }
  if (Object.keys(next).length > 0) await deps.store.writeConfig(next);
}

/** A backup of a heavy install is legitimately large; these bound the absurd. */
const MAX_ENTRIES = 500_000;
const MAX_TOTAL_UNCOMPRESSED_BYTES = 2 * 1024 ** 4;

/**
 * Walk the archive's directory before touching any of it.
 *
 * The in-memory `guardZipArchive` helper cannot be used here: a backup is
 * routinely gigabytes, and reading one into a buffer to check whether it is
 * too big defeats the purpose. This streams the central directory instead,
 * applying the same rules the model-bundle importer does.
 */
async function assertSafeArchive(archivePath: string): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    yauzl.open(
      archivePath,
      { lazyEntries: true, decodeStrings: true, validateEntrySizes: true },
      (err, zip) => {
        if (err || !zip) {
          reject(new Error('That file is not a readable ZIP archive.'));
          return;
        }
        let count = 0;
        let totalUncompressed = 0;
        let settled = false;
        const fail = (error: Error) => {
          if (settled) return;
          settled = true;
          zip.close();
          reject(error);
        };
        zip.on('error', fail);
        zip.on('entry', (entry) => {
          try {
            count += 1;
            if (count > MAX_ENTRIES) throw new Error('That backup has implausibly many files.');
            if ((entry.generalPurposeBitFlag & 0x1) !== 0) {
              throw new Error('Encrypted backups cannot be restored.');
            }
            const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
            if ((unixMode & 0o170000) === 0o120000) {
              throw new Error('That backup contains links, which cannot be restored safely.');
            }
            totalUncompressed += entry.uncompressedSize;
            if (totalUncompressed > MAX_TOTAL_UNCOMPRESSED_BYTES) {
              throw new Error('That backup expands to an implausible size.');
            }
            zip.readEntry();
          } catch (error) {
            fail(error instanceof Error ? error : new Error(String(error)));
          }
        });
        zip.on('end', () => {
          if (settled) return;
          settled = true;
          resolvePromise();
        });
        zip.readEntry();
      },
    );
  });
}

async function readManifest(archivePath: string): Promise<BackupManifest> {
  const raw = await readZipEntry(archivePath, 'manifest.json', 4 * 1024 * 1024);
  if (!raw) throw new Error('That file is not a Gezel backup (no manifest).');
  return BackupManifestSchema.parse(JSON.parse(raw.toString('utf8')));
}

function readZipEntry(
  archivePath: string,
  wanted: string,
  maxBytes: number,
): Promise<Buffer | null> {
  return new Promise((resolvePromise, reject) => {
    yauzl.open(archivePath, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error('cannot open archive'));
      zip.on('entry', (entry: yauzl.Entry) => {
        if (entry.fileName !== wanted) {
          zip.readEntry();
          return;
        }
        zip.openReadStream(entry, (streamErr, stream) => {
          if (streamErr || !stream) return reject(streamErr ?? new Error('cannot read entry'));
          const chunks: Buffer[] = [];
          let total = 0;
          stream.on('data', (chunk: Buffer) => {
            total += chunk.byteLength;
            if (total > maxBytes) {
              stream.destroy();
              reject(new Error('backup manifest is implausibly large'));
              return;
            }
            chunks.push(chunk);
          });
          stream.on('end', () => resolvePromise(Buffer.concat(chunks)));
          stream.on('error', reject);
        });
      });
      zip.on('end', () => resolvePromise(null));
      zip.on('error', reject);
      zip.readEntry();
    });
  });
}

/**
 * Extract only the entries belonging to selected items. Every destination
 * goes through `safeJoin`, so an archive carrying `../../` in an entry name
 * cannot write outside the staging directory.
 */
async function extractSelected(
  archivePath: string,
  stage: string,
  items: RestoreReviewItem[],
  includeSettings: boolean,
): Promise<void> {
  const prefixes = items.map((item) => `${backupEntryPrefix(item)}/`);
  if (includeSettings) prefixes.push('settings/');
  await mkdir(stage, { recursive: true });

  await new Promise<void>((resolvePromise, reject) => {
    yauzl.open(archivePath, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error('cannot open archive'));
      zip.on('entry', (entry: yauzl.Entry) => {
        const wanted = prefixes.some((prefix) => entry.fileName.startsWith(prefix));
        if (!wanted || entry.fileName.endsWith('/')) {
          zip.readEntry();
          return;
        }
        const destination = safeJoin(stage, entry.fileName);
        if (!destination) {
          // A traversal attempt, a device name, or an absolute path. Skip it
          // rather than fail the restore — the rest of the archive is fine.
          log.warn(`[restore] skipped unsafe archive entry: ${entry.fileName}`);
          zip.readEntry();
          return;
        }
        zip.openReadStream(entry, (streamErr, stream) => {
          if (streamErr || !stream) return reject(streamErr ?? new Error('cannot read entry'));
          mkdir(dirname(destination), { recursive: true })
            .then(() => pipeline(stream, createWriteStream(destination)))
            .then(() => zip.readEntry())
            .catch(reject);
        });
      });
      zip.on('end', () => resolvePromise());
      zip.on('error', reject);
      zip.readEntry();
    });
  });
}

/** Drop review staging left by a scan the user never confirmed. */
export async function sweepExpiredReviews(home: string): Promise<void> {
  const root = restoresRoot(home);
  const { readdir, stat } = await import('node:fs/promises');
  const entries = await readdir(root).catch(() => [] as string[]);
  const now = Date.now();
  for (const id of entries) {
    const dir = join(root, id);
    try {
      const info = await stat(dir);
      if (now - info.mtimeMs > REVIEW_TTL_MS) await rm(dir, { recursive: true, force: true });
    } catch {
      // Raced with another sweep.
    }
  }
}
