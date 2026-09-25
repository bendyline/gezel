import { randomBytes, randomUUID } from 'node:crypto';
import { type Dirent, createWriteStream } from 'node:fs';
import { cp, mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  type CraftbookParamInput,
  type CreateInputStagingResponse,
  type InputStagingFileResponse,
  InputStagingIdSchema,
  type InputStagingLimits,
  KeyedLock,
  type TaskInputSkipReason,
  createLogger,
  effectiveInputLimits,
  inputAccepts,
  isInputJunkName,
  normalizeInputPath,
  nowIso,
} from '@bendyline/gezel';
import { writeFileAtomic } from '../../fs/atomic.js';
import { isReservedWindowsName, safeJoin } from '../../fs/safe-paths.js';

const log = createLogger('task-inputs');

/**
 * Upload staging for craftbook inputs the user picks from outside the
 * project. Bytes arrive from the user's own client (the browser reads the
 * picked folder), so the daemon never opens a host path it was handed —
 * which is what keeps this working in a plain browser, over a remote
 * connection, and under a system-service daemon that cannot read the user's
 * home folder.
 *
 * Layout: `projects/<id>/input-staging/<stagingId>/{meta.json,files/}` —
 * beside `artifacts/` on purpose, so adopting a finished upload into
 * `artifacts/tasks/<num>/inputs/<param>/` is one same-volume rename.
 * Owned by this manager (a CLAUDE.md carve-out); unadopted areas are swept.
 */

export const INPUT_STAGING_DIR_NAME = 'input-staging';
const META_FILE = 'meta.json';
const FILES_DIR = 'files';

export interface InputStagingMeta {
  stagingId: string;
  craftbookId: string;
  param: string;
  label: string;
  limits: InputStagingLimits;
  createdAt: string;
  fileCount: number;
  totalBytes: number;
}

export class InputStagingNotFoundError extends Error {
  readonly code = 'input-staging-not-found' as const;
  constructor(stagingId: string) {
    super(`upload ${stagingId} not found — it may have expired; pick the files again`);
    this.name = 'InputStagingNotFoundError';
  }
}

/** The upload broke one of the input's limits; the client should stop sending. */
export class InputStagingLimitError extends Error {
  readonly code = 'input-staging-limit' as const;
  constructor(
    readonly reason: TaskInputSkipReason,
    message: string,
  ) {
    super(message);
    this.name = 'InputStagingLimitError';
  }
}

export class InputStagingPathError extends Error {
  readonly code = 'input-staging-path' as const;
  constructor(path: string) {
    super(`"${path}" is not a usable file path`);
    this.name = 'InputStagingPathError';
  }
}

const SWEEP_INTERVAL_MS = 6 * 60 * 60_000;
const SWEEP_STARTUP_DELAY_MS = 5 * 60_000;
/** An upload nobody launched within a day was abandoned (a closed dialog, a crash). */
export const INPUT_STAGING_MAX_AGE_MS = 24 * 60 * 60_000;

export interface InputStagingStore {
  projectArtifactsDir(projectId: string): string;
}

export class InputStagingManager {
  private readonly locks = new KeyedLock();
  private sweepTimers: Array<ReturnType<typeof setTimeout>> = [];
  private sweeping = false;

  constructor(private readonly store: InputStagingStore) {}

  /** `projects/<id>/input-staging/` — a sibling of the artifacts drawer. */
  stagingRoot(projectId: string): string {
    return join(dirname(this.store.projectArtifactsDir(projectId)), INPUT_STAGING_DIR_NAME);
  }

  /** Absolute staging area for one upload (`meta.json` + `files/`). */
  areaDir(projectId: string, stagingId: string): string {
    if (!InputStagingIdSchema.safeParse(stagingId).success) {
      throw new InputStagingNotFoundError(stagingId);
    }
    return join(this.stagingRoot(projectId), stagingId);
  }

  /** Absolute folder the uploaded files land in. */
  filesDir(projectId: string, stagingId: string): string {
    return join(this.areaDir(projectId, stagingId), FILES_DIR);
  }

  async create(
    projectId: string,
    args: { craftbookId: string; param: string; label?: string; spec: CraftbookParamInput },
  ): Promise<CreateInputStagingResponse> {
    const stagingId = `stg-${randomBytes(12).toString('hex')}`;
    const limits: InputStagingLimits = {
      kind: args.spec.kind,
      ...(args.spec.accept ? { accept: args.spec.accept } : {}),
      ...effectiveInputLimits(args.spec),
    };
    const meta: InputStagingMeta = {
      stagingId,
      craftbookId: args.craftbookId,
      param: args.param,
      label: args.label?.trim() || args.param,
      limits,
      createdAt: nowIso(),
      fileCount: 0,
      totalBytes: 0,
    };
    const dir = this.areaDir(projectId, stagingId);
    await mkdir(join(dir, FILES_DIR), { recursive: true });
    await writeFileAtomic(join(dir, META_FILE), `${JSON.stringify(meta, null, 2)}\n`);
    return { stagingId, limits };
  }

  async readMeta(projectId: string, stagingId: string): Promise<InputStagingMeta | null> {
    try {
      const raw = await readFile(join(this.areaDir(projectId, stagingId), META_FILE), 'utf8');
      return JSON.parse(raw) as InputStagingMeta;
    } catch {
      return null;
    }
  }

  /**
   * Store one uploaded file, streaming the body to disk and enforcing the
   * per-file, running-total, and count caps as bytes arrive — the body is
   * never buffered whole. Serialized per staging area so two concurrent
   * uploads cannot both squeeze under the same limit.
   */
  async putFile(
    projectId: string,
    stagingId: string,
    relPath: string,
    body: ReadableStream<Uint8Array> | null,
  ): Promise<InputStagingFileResponse> {
    return this.locks.run(`${projectId}/${stagingId}`, async () => {
      const dir = this.areaDir(projectId, stagingId);
      const meta = await this.readMeta(projectId, stagingId);
      if (!meta) throw new InputStagingNotFoundError(stagingId);
      const rel = normalizeInputPath(relPath);
      const segments = rel.split('/');
      if (!rel || segments.some((s) => !s || s === '.' || s === '..' || isReservedWindowsName(s))) {
        throw new InputStagingPathError(relPath);
      }
      const summary = (stored: boolean, reason?: TaskInputSkipReason) => ({
        stored,
        path: rel,
        ...(reason ? { reason } : {}),
        fileCount: meta.fileCount,
        totalBytes: meta.totalBytes,
      });
      if (segments.some((s) => isInputJunkName(s))) return summary(false, 'sync-junk');
      if (
        meta.limits.accept &&
        !inputAccepts({ kind: meta.limits.kind, accept: meta.limits.accept }, rel)
      ) {
        return summary(false, 'not-accepted');
      }
      const target = safeJoin(join(dir, FILES_DIR), rel);
      if (!target) throw new InputStagingPathError(relPath);

      const previous = await stat(target).catch(() => null);
      const replacing = previous?.isFile() ? previous.size : null;
      if (replacing === null && meta.fileCount >= meta.limits.maxFiles) {
        throw new InputStagingLimitError(
          'over-file-limit',
          meta.limits.kind === 'file'
            ? 'This input takes a single file.'
            : `This input takes at most ${meta.limits.maxFiles} files.`,
        );
      }
      const budget = meta.limits.maxBytes - (meta.totalBytes - (replacing ?? 0));

      await mkdir(dirname(target), { recursive: true });
      const part = `${target}.part-${randomUUID()}`;
      let written = 0;
      let violation: InputStagingLimitError | null = null;
      try {
        const source = body
          ? Readable.fromWeb(body as import('node:stream/web').ReadableStream)
          : Readable.from([]);
        const counter = async function* (chunks: AsyncIterable<Buffer>) {
          for await (const chunk of chunks) {
            written += chunk.length;
            if (written > meta.limits.maxFileBytes) {
              violation = new InputStagingLimitError(
                'too-large',
                `"${rel}" is larger than this input accepts.`,
              );
              throw violation;
            }
            if (written > budget) {
              violation = new InputStagingLimitError(
                'over-byte-limit',
                'These files together are larger than this input accepts.',
              );
              throw violation;
            }
            yield chunk;
          }
        };
        await pipeline(source, counter, createWriteStream(part));
        await rename(part, target);
      } catch (err) {
        await rm(part, { force: true }).catch(() => undefined);
        if (violation) throw violation;
        throw err;
      }

      meta.fileCount += replacing === null ? 1 : 0;
      meta.totalBytes += written - (replacing ?? 0);
      await writeFileAtomic(join(dir, META_FILE), `${JSON.stringify(meta, null, 2)}\n`);
      return summary(true);
    });
  }

  async discard(projectId: string, stagingId: string): Promise<void> {
    const dir = this.areaDir(projectId, stagingId);
    await this.locks.run(`${projectId}/${stagingId}`, () =>
      rm(dir, { recursive: true, force: true }),
    );
  }

  /**
   * Move the uploaded files to `destAbs` and drop the staging area. A rename
   * when possible; a copy across volumes (a relocated projects folder).
   */
  async adopt(projectId: string, stagingId: string, destAbs: string): Promise<void> {
    const dir = this.areaDir(projectId, stagingId);
    await this.locks.run(`${projectId}/${stagingId}`, async () => {
      await mkdir(dirname(destAbs), { recursive: true });
      await moveDir(join(dir, FILES_DIR), destAbs);
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    });
  }

  /** Undo {@link adopt} when the task write that followed it failed. */
  async restore(projectId: string, meta: InputStagingMeta, adoptedAbs: string): Promise<void> {
    const dir = this.areaDir(projectId, meta.stagingId);
    await mkdir(dir, { recursive: true });
    await moveDir(adoptedAbs, join(dir, FILES_DIR));
    await writeFileAtomic(join(dir, META_FILE), `${JSON.stringify(meta, null, 2)}\n`);
  }

  /** Remove staging areas older than `maxAgeMs` in one project. */
  async sweepProject(projectId: string, maxAgeMs: number, now = Date.now()): Promise<number> {
    const root = this.stagingRoot(projectId);
    let entries: Dirent[];
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      return 0;
    }
    let removed = 0;
    for (const entry of entries) {
      if (!entry.isDirectory() || !InputStagingIdSchema.safeParse(entry.name).success) continue;
      const meta = await this.readMeta(projectId, entry.name);
      const created = meta ? Date.parse(meta.createdAt) : Number.NaN;
      const age = Number.isFinite(created)
        ? now - created
        : now - ((await stat(join(root, entry.name)).catch(() => null))?.mtimeMs ?? now);
      if (age < maxAgeMs) continue;
      await this.discard(projectId, entry.name).catch((err) =>
        log.warn(`could not sweep upload ${projectId}/${entry.name}: ${String(err)}`),
      );
      removed += 1;
    }
    return removed;
  }

  /**
   * Remove abandoned staging areas across every project: shortly after boot,
   * then every few hours. Disk hygiene only — no model calls, no engagement
   * gate. Timers are unref'd so they never hold the process open.
   */
  startSweeping(store: { listProjects(): Promise<Array<{ id: string }>> }): void {
    const run = () => void this.sweep(store);
    const startup = setTimeout(run, SWEEP_STARTUP_DELAY_MS);
    const interval = setInterval(run, SWEEP_INTERVAL_MS);
    startup.unref?.();
    interval.unref?.();
    this.sweepTimers = [startup, interval];
  }

  stopSweeping(): void {
    for (const timer of this.sweepTimers) clearTimeout(timer);
    this.sweepTimers = [];
  }

  async sweep(
    store: { listProjects(): Promise<Array<{ id: string }>> },
    now = Date.now(),
    maxAgeMs = INPUT_STAGING_MAX_AGE_MS,
  ): Promise<number> {
    if (this.sweeping) return 0;
    this.sweeping = true;
    try {
      let removed = 0;
      for (const project of await store.listProjects().catch(() => [])) {
        removed += await this.sweepProject(project.id, maxAgeMs, now).catch(() => 0);
      }
      if (removed > 0) log.info(`swept ${removed} abandoned input upload(s)`);
      return removed;
    } finally {
      this.sweeping = false;
    }
  }
}

async function moveDir(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    await cp(from, to, { recursive: true, errorOnExist: true, force: false });
    await rm(from, { recursive: true, force: true });
  }
}
