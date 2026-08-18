import type { Dirent, Stats } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/**
 * Disk accounting for the storage summary. A heavy install is tens of
 * gigabytes concentrated in a few dozen model payload files, so the walk is
 * bound by file count rather than bytes and finishes fast on the trees that
 * matter. The expensive-to-walk trees (uv virtualenvs, browser bundles,
 * npm extracts) are small in bytes but deep in entries, which is what the
 * concurrency limit below is for.
 *
 * Symlinks are counted as their own (tiny) size and never followed: a
 * followed link can leave the home directory, double-count a shared payload,
 * or loop forever.
 */

/** Enough parallelism to hide directory-read latency without thrashing. */
const WALK_CONCURRENCY = 8;

/**
 * A Dirent does not carry a file's byte size, so every regular file still
 * needs an lstat. Keep those calls bounded but concurrent: doing them one at
 * a time made a 100k-file runtime take tens of seconds to measure, while an
 * unbounded Promise.all can overwhelm the filesystem on package trees.
 * `readLevel` itself runs at WALK_CONCURRENCY, so the process-wide upper
 * bound is WALK_CONCURRENCY * FILE_STAT_CONCURRENCY.
 */
const FILE_STAT_CONCURRENCY = 8;

export interface TreeSize {
  bytes: number;
  fileCount: number;
}

const EMPTY: TreeSize = { bytes: 0, fileCount: 0 };

/**
 * Sum a directory tree. Missing paths return zero rather than throwing —
 * every category resolves optimistically and most installs have never
 * created most of them.
 *
 * `exclude` drops nested subtrees that another category already owns. A
 * project's generated search index physically lives inside the project
 * directory, and counting it in both places would tell someone their work
 * takes more room than it does.
 */
export async function measureTree(path: string, exclude?: Iterable<string>): Promise<TreeSize> {
  let root: Stats;
  try {
    root = await lstat(path);
  } catch {
    return EMPTY;
  }
  if (root.isSymbolicLink()) return EMPTY;
  if (!root.isDirectory()) return { bytes: root.size, fileCount: 1 };

  const skip = new Set<string>();
  for (const p of exclude ?? []) skip.add(resolve(p));
  if (skip.has(resolve(path))) return EMPTY;

  let bytes = 0;
  let fileCount = 0;
  const pending: string[] = [path];

  while (pending.length > 0) {
    const batch = pending.splice(0, WALK_CONCURRENCY);
    const results = await Promise.all(batch.map((dir) => readLevel(dir)));
    for (const level of results) {
      bytes += level.bytes;
      fileCount += level.fileCount;
      for (const dir of level.dirs) {
        if (!skip.has(resolve(dir))) pending.push(dir);
      }
    }
  }
  return { bytes, fileCount };
}

async function readLevel(dir: string): Promise<TreeSize & { dirs: string[] }> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return { bytes: 0, fileCount: 0, dirs: [] };
  }
  let bytes = 0;
  let fileCount = 0;
  const dirs: string[] = [];
  const files: string[] = [];
  for (const entry of entries) {
    const absolute = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      dirs.push(absolute);
      continue;
    }
    if (entry.isFile()) files.push(absolute);
  }

  for (let offset = 0; offset < files.length; offset += FILE_STAT_CONCURRENCY) {
    const batch = files.slice(offset, offset + FILE_STAT_CONCURRENCY);
    const sizes = await Promise.all(
      batch.map(async (file) => {
        try {
          return (await lstat(file)).size;
        } catch {
          // Raced with a delete, or unreadable. Accounting is advisory.
          return undefined;
        }
      }),
    );
    for (const size of sizes) {
      if (size === undefined) continue;
      bytes += size;
      fileCount += 1;
    }
  }
  return { bytes, fileCount, dirs };
}

/**
 * Short-lived memo so the About panel, the cleanup dialog, and the uninstall
 * lead-in do not each re-walk 70 GB seconds apart. Deliberately not
 * invalidated on writes — the numbers are advisory, and a cleanup run
 * clears the cache explicitly when it finishes.
 */
export class SizeCache {
  private entry?: { value: unknown; at: number };
  private inFlight?: { promise: Promise<unknown> };
  private generation = 0;

  constructor(private readonly ttlMs = 60_000) {}

  async get<T>(compute: () => Promise<T>, refresh = false): Promise<T> {
    const now = Date.now();
    if (!refresh && this.entry && now - this.entry.at < this.ttlMs) {
      return this.entry.value as T;
    }

    // Settings begins measuring as soon as it mounts. If someone opens the
    // cleanup dialog before that walk finishes, both callers need the same
    // result — a second 100k-file traversal only makes each one slower.
    if (this.inFlight) return this.inFlight.promise as Promise<T>;

    const generation = this.generation;
    const promise = compute().then((value) => {
      // `clear` may have invalidated this measurement while it was running
      // (for example after a cleanup changed the filesystem). Never publish
      // a result from the old generation as fresh.
      if (this.generation === generation) {
        this.entry = { value, at: Date.now() };
      }
      return value;
    });
    const pending = { promise: promise as Promise<unknown> };
    this.inFlight = pending;
    try {
      return await promise;
    } finally {
      if (this.inFlight === pending) this.inFlight = undefined;
    }
  }

  clear(): void {
    this.generation += 1;
    this.entry = undefined;
    this.inFlight = undefined;
  }
}
