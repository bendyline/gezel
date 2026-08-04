import { createHash, randomUUID } from 'node:crypto';
import { type Dirent, createReadStream } from 'node:fs';
import {
  cp,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
export const MACHINE_SHARED_MARKER = '.gezel-machine-shared-v1.json';
const IN_PROGRESS_MARKER = '.gezel-migration-in-progress.json';
const LOCK_FILE = '.gezel-machine-shared-migration.lock';
const LEGACY_KINDS = ['projects', 'gezels'] as const;

export interface SharedMigrationResult {
  sourceHome: string;
  sharedHome: string;
  moved: { projects: number; gezels: number };
  recovered: { projects: number; gezels: number };
  marker: string;
}

/**
 * Move pre-split machine product entities into the explicit shared root.
 * The machine service must be stopped by the caller. Publication is per
 * entity: rename on one filesystem, verified copy/delete on EXDEV. The root
 * marker is written only after both scopes have converged.
 */
export async function migrateLegacyMachineDataToShared(opts: {
  sourceHome: string;
  sharedHome: string;
}): Promise<SharedMigrationResult> {
  const sourceHome = resolveAbsolute(opts.sourceHome, 'source home');
  const sharedHome = resolveAbsolute(opts.sharedHome, 'shared home');
  if (sourceHome === sharedHome) throw new Error('source and shared homes must be different');
  await assertPlainDirectoryIfPresent(sourceHome, 'source home');
  await assertPlainDirectoryIfPresent(sharedHome, 'shared home');
  await mkdir(sourceHome, { recursive: true });
  await mkdir(sharedHome, { recursive: true });

  const lockPath = join(sourceHome, LOCK_FILE);
  const lock = await acquireMigrationLock(lockPath);
  const moved = { projects: 0, gezels: 0 };
  const recovered = { projects: 0, gezels: 0 };
  try {
    for (const kind of LEGACY_KINDS) {
      const sourceRoot = join(sourceHome, kind);
      const destinationRoot = join(sharedHome, kind);
      await assertPlainDirectoryIfPresent(sourceRoot, `legacy ${kind} root`);
      await assertPlainDirectoryIfPresent(destinationRoot, `shared ${kind} root`);
      await mkdir(destinationRoot, { recursive: true });

      let entries: Dirent<string>[];
      try {
        entries = await readdir(sourceRoot, { withFileTypes: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw err;
      }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) {
          throw new Error(`refusing symlinked legacy ${kind} entry: ${entry.name}`);
        }
        if (!entry.isDirectory()) continue;
        const outcome = await migrateEntity({
          source: join(sourceRoot, entry.name),
          destination: join(destinationRoot, entry.name),
          kind,
          id: entry.name,
        });
        if (outcome === 'moved') moved[kind]++;
        else recovered[kind]++;
      }
      // Files such as .DS_Store are harmless and deliberately retained. The
      // service's legacy-state detector keys only on entity directories.
      await rmdir(sourceRoot).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== 'ENOENT' && err.code !== 'ENOTEMPTY' && err.code !== 'EEXIST') throw err;
      });
    }

    const marker = join(sharedHome, MACHINE_SHARED_MARKER);
    await writeJsonAtomic(marker, {
      version: 1,
      migratedAt: new Date().toISOString(),
      sourceHome,
      scopes: ['projects', 'gezels'],
      privateStatePolicy: 'copy-legacy-gezel-runtime-per-user-on-first-mount',
      moved,
      recovered,
    });
    return { sourceHome, sharedHome, moved, recovered, marker };
  } finally {
    await lock.close();
    await rm(lockPath, { force: true });
  }
}

async function migrateEntity(opts: {
  source: string;
  destination: string;
  kind: (typeof LEGACY_KINDS)[number];
  id: string;
}): Promise<'moved' | 'recovered'> {
  await assertPlainDirectoryIfPresent(opts.source, `legacy ${opts.kind}/${opts.id}`);
  const destinationExists = await pathExists(opts.destination);
  if (destinationExists) {
    await assertPlainDirectoryIfPresent(opts.destination, `shared ${opts.kind}/${opts.id}`);
    const progress = await readProgressMarker(opts.destination);
    if (progress && progress.source !== opts.source) {
      throw new Error(`shared ${opts.kind}/${opts.id} has a foreign migration marker`);
    }
    if (progress) {
      await cp(opts.source, opts.destination, {
        recursive: true,
        force: true,
        dereference: false,
        preserveTimestamps: true,
      });
      await rm(join(opts.destination, IN_PROGRESS_MARKER), { force: true });
    }
    await assertTreesEqual(opts.source, opts.destination);
    await rm(opts.source, { recursive: true });
    return 'recovered';
  }

  try {
    await rename(opts.source, opts.destination);
    return 'moved';
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
  }

  // Cross-volume fallback. The in-progress marker makes an interrupted copy
  // distinguishable from a pre-existing real entity on the next installer run.
  await mkdir(opts.destination);
  await writeJsonAtomic(join(opts.destination, IN_PROGRESS_MARKER), {
    version: 1,
    source: opts.source,
    startedAt: new Date().toISOString(),
  });
  await cp(opts.source, opts.destination, {
    recursive: true,
    force: true,
    dereference: false,
    preserveTimestamps: true,
  });
  await rm(join(opts.destination, IN_PROGRESS_MARKER), { force: true });
  await assertTreesEqual(opts.source, opts.destination);
  await rm(opts.source, { recursive: true });
  return 'moved';
}

async function assertTreesEqual(source: string, destination: string): Promise<void> {
  const [sourceDigest, destinationDigest] = await Promise.all([
    treeDigest(source),
    treeDigest(destination),
  ]);
  if (sourceDigest !== destinationDigest) {
    throw new Error(
      `verified migration failed for ${basename(source)}: source and destination differ`,
    );
  }
}

async function treeDigest(root: string): Promise<string> {
  const hash = createHash('sha256');
  async function visit(path: string): Promise<void> {
    const rel = relative(root, path).split(sep).join('/');
    if (rel === IN_PROGRESS_MARKER) return;
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      hash.update(`L\0${rel}\0${await readlink(path)}\0`);
      return;
    }
    if (info.isDirectory()) {
      hash.update(`D\0${rel}\0`);
      const entries = await readdir(path);
      entries.sort((a, b) => a.localeCompare(b));
      for (const name of entries) await visit(join(path, name));
      return;
    }
    if (info.isFile()) {
      hash.update(`F\0${rel}\0${info.size}\0`);
      // A migrated workspace may contain multi-gigabyte model/media files.
      // Hash incrementally so the EXDEV integrity check cannot exhaust the
      // installer's memory by reading one such file into a single Buffer.
      for await (const chunk of createReadStream(path)) hash.update(chunk);
      return;
    }
    throw new Error(`unsupported filesystem entry during migration: ${path}`);
  }
  await visit(root);
  return hash.digest('hex');
}

async function readProgressMarker(destination: string): Promise<{ source: string } | null> {
  try {
    const raw = JSON.parse(await readFile(join(destination, IN_PROGRESS_MARKER), 'utf8')) as {
      source?: unknown;
    };
    return typeof raw.source === 'string' ? { source: raw.source } : null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`invalid migration marker in ${destination}`);
  }
}

async function acquireMigrationLock(path: string) {
  try {
    const handle = await open(path, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: Date.now() })}\n`);
    await handle.sync();
    return handle;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    const [age, lockOwner] = await Promise.all([
      stat(path).then((info) => Date.now() - info.mtimeMs),
      readFile(path, 'utf8')
        .then((raw) => JSON.parse(raw) as { pid?: unknown })
        .catch((): { pid?: unknown } => ({})),
    ]);
    const ownerPid = typeof lockOwner.pid === 'number' ? lockOwner.pid : null;
    if (ownerPid && processExists(ownerPid)) {
      throw new Error(`another shared-data migration holds ${path} (pid ${ownerPid})`);
    }
    // Do not steal a fresh-but-unreadable lock: it may have been created by
    // another installer between its open() and durable metadata write.
    if (age <= 10 * 60_000) throw new Error(`another shared-data migration holds ${path}`);
    await rm(path, { force: true });
    const handle = await open(path, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, recoveredAt: Date.now() })}\n`);
    await handle.sync();
    return handle;
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, path);
}

async function assertPlainDirectoryIfPresent(path: string, label: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`refusing symlinked ${label}: ${path}`);
    if (!info.isDirectory()) throw new Error(`${label} is not a directory: ${path}`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

function resolveAbsolute(path: string, label: string): string {
  if (!path || !isAbsolute(path)) throw new Error(`${label} must be an absolute path`);
  return resolve(path);
}
