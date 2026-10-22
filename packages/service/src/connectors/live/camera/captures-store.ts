/**
 * A camera's saved pictures, in the project's private sidecar
 * (`projectCapturesDir`), never in artifacts: frames stay on this computer
 * even when the project's artifacts live in a synced folder. Written straight
 * to disk rather than through Store, which would mark the project "active"
 * on every frame. Kept bounded by days and by size, and paused when the disk
 * runs low.
 */

import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { CameraCapture } from '@bendyline/gezel';
import { localDayHour } from '@bendyline/gezel';
import { writeFileAtomic } from '@bendyline/gezel-inference/internal/fs/atomic';
import { resolveInside } from '@bendyline/gezel-inference/internal/fs/safe-paths';
import { checkDiskSpace } from '@bendyline/gezel-inference/internal/utils/disk-space';

const DAY_DIR = /^\d{4}-\d{2}-\d{2}$/;
const HOUR_DIR = /^\d{2}$/;
const FRAME_FILE = /^\d{6}-\d{3}\.jpg$/;
/** Free space the disk keeps before saving pauses (on top of the helper's 2 GB floor). */
const DISK_RESERVE_BYTES = 3 * 1024 ** 3;
const DISK_CHECK_EVERY_MS = 5 * 60_000;

export interface CapturesStoreOptions {
  /** This camera's folder: `<projectCapturesDir>/<corpus>`. */
  root: string;
  keepDays: number;
  maxBytes: number;
  now?: () => number;
  diskOk?: (dir: string) => Promise<boolean>;
}

export class CapturesStore {
  private totalBytes = 0;
  private scanned = false;
  private lastDiskCheck = 0;
  private diskOk = true;
  private keepDays: number;
  private maxBytes: number;

  constructor(private readonly opts: CapturesStoreOptions) {
    this.keepDays = opts.keepDays;
    this.maxBytes = opts.maxBytes;
  }

  get root(): string {
    return this.opts.root;
  }

  get bytes(): number {
    return this.totalBytes;
  }

  /** False while saving is paused for a nearly full disk. */
  get saving(): boolean {
    return this.diskOk;
  }

  configure(keepDays: number, maxBytes: number): void {
    this.keepDays = keepDays;
    this.maxBytes = maxBytes;
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  private async ensureScanned(): Promise<void> {
    if (this.scanned) return;
    this.scanned = true;
    this.totalBytes = (await this.walk()).reduce((sum, f) => sum + f.bytes, 0);
  }

  private async checkDisk(): Promise<boolean> {
    const now = this.now();
    if (now - this.lastDiskCheck < DISK_CHECK_EVERY_MS) return this.diskOk;
    this.lastDiskCheck = now;
    const check =
      this.opts.diskOk ??
      (async (dir: string) => (await checkDiskSpace(dir, DISK_RESERVE_BYTES)).ok);
    this.diskOk = await check(this.opts.root).catch(() => true);
    return this.diskOk;
  }

  /** Save one frame. Returns null when the disk guard is holding saves. */
  async save(jpeg: Buffer, at: number): Promise<CameraCapture | null> {
    await this.ensureScanned();
    if (!(await this.checkDisk())) return null;
    const { day, hour, stamp } = localDayHour(at);
    const rel = `${day}/${hour}/${stamp}.jpg`;
    await mkdir(join(this.opts.root, day, hour), { recursive: true });
    await writeFileAtomic(await resolveInside(this.opts.root, rel), jpeg);
    this.totalBytes += jpeg.length;
    if (this.totalBytes > this.maxBytes) await this.sweep();
    return { path: rel, at: new Date(at).toISOString(), bytes: jpeg.length };
  }

  /**
   * Drop days past `keepDays`, then the oldest pictures until the folder is
   * back under 90% of its size cap (so a full folder is not swept on every
   * frame).
   */
  async sweep(): Promise<{ removed: number }> {
    const files = await this.walk();
    const cutoff = localDayHour(this.now() - this.keepDays * 24 * 60 * 60_000).day;
    let removed = 0;
    let total = files.reduce((sum, f) => sum + f.bytes, 0);
    const keep: typeof files = [];
    for (const f of files) {
      if (f.day < cutoff) {
        await rm(join(this.opts.root, f.path), { force: true });
        total -= f.bytes;
        removed++;
      } else {
        keep.push(f);
      }
    }
    if (total > this.maxBytes) {
      const target = this.maxBytes * 0.9;
      for (const f of keep) {
        if (total <= target) break;
        await rm(join(this.opts.root, f.path), { force: true });
        total -= f.bytes;
        removed++;
      }
    }
    await this.pruneEmptyDirs();
    this.totalBytes = Math.max(0, total);
    this.scanned = true;
    return { removed };
  }

  /** Saved pictures, oldest first; one day's when `day` is given. */
  async list(day?: string): Promise<CameraCapture[]> {
    return (await this.walk(day)).map((f) => ({ path: f.path, at: f.at, bytes: f.bytes }));
  }

  async read(relPath: string): Promise<Buffer> {
    if (!FRAME_FILE.test(relPath.split('/').pop() ?? '')) throw new Error('not a saved picture');
    return readFile(await resolveInside(this.opts.root, relPath));
  }

  /** Delete every saved picture for this camera. */
  async clear(): Promise<void> {
    await rm(this.opts.root, { recursive: true, force: true });
    this.totalBytes = 0;
  }

  private async walk(
    onlyDay?: string,
  ): Promise<Array<{ path: string; day: string; at: string; bytes: number }>> {
    const out: Array<{ path: string; day: string; at: string; bytes: number }> = [];
    const days = (await readdir(this.opts.root).catch(() => [] as string[]))
      .filter((d) => DAY_DIR.test(d) && (!onlyDay || d === onlyDay))
      .sort();
    for (const day of days) {
      const hours = (await readdir(join(this.opts.root, day)).catch(() => [] as string[]))
        .filter((h) => HOUR_DIR.test(h))
        .sort();
      for (const hour of hours) {
        const names = (await readdir(join(this.opts.root, day, hour)).catch(() => [] as string[]))
          .filter((n) => FRAME_FILE.test(n))
          .sort();
        for (const name of names) {
          const path = `${day}/${hour}/${name}`;
          const info = await stat(join(this.opts.root, path)).catch(() => null);
          if (!info?.isFile()) continue;
          const [hh, mm, ss] = [name.slice(0, 2), name.slice(2, 4), name.slice(4, 6)];
          const at = new Date(`${day}T${hh}:${mm}:${ss}.${name.slice(7, 10)}`).toISOString();
          out.push({ path, day, at, bytes: info.size });
        }
      }
    }
    return out;
  }

  private async pruneEmptyDirs(): Promise<void> {
    const days = await readdir(this.opts.root).catch(() => [] as string[]);
    for (const day of days.filter((d) => DAY_DIR.test(d))) {
      const dayDir = join(this.opts.root, day);
      const hours = await readdir(dayDir).catch(() => [] as string[]);
      for (const hour of hours) {
        const hourDir = join(dayDir, hour);
        if ((await readdir(hourDir).catch(() => ['x'])).length === 0)
          await rm(hourDir, { recursive: true, force: true });
      }
      if ((await readdir(dayDir).catch(() => ['x'])).length === 0)
        await rm(dayDir, { recursive: true, force: true });
    }
  }
}
