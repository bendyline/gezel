import { cp, mkdir, readdir, rm, rmdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { createLogger } from '@bendyline/gezel';
import { type ExternalFolders, backupsDir } from '@bendyline/gezel/paths';
import type { Store } from '../fs/store.js';
import type { JobManager, MoveJob } from './job-manager.js';
import { planMove } from './plan.js';
import { clearSentinel, writeSentinel } from './recovery.js';
import {
  type FolderScope,
  backupRootForScope,
  makeScopeFilter,
  sourceRootForScope,
} from './scope.js';

const log = createLogger('folders');

const BACKUP_RETENTION = 10;

export interface RunMoveOpts {
  home: string;
  store: Store;
  jobs: JobManager;
  jobId: string;
  /** Triggered AFTER the config swap succeeds, BEFORE cleanup. The
   *  supervisor uses this to schedule a service restart. The worker
   *  doesn't await it — it's fire-and-forget so cleanup proceeds. */
  onConfigSwapped?: (scope: FolderScope) => void;
}

/**
 * Run a folder move end-to-end. Phases (each updates the job status):
 *  scan → backup → copy → verify → swap → cleanup → prune.
 *
 * The sentinel file `~/.gezel/folders/active-move.json` is written
 * before backup and removed after a successful prune. On crash mid-
 * move, the next service boot logs a warning (see `recovery.ts`) and
 * the user is directed to the backup folder.
 */
export async function runMove(opts: RunMoveOpts): Promise<void> {
  const { home, store, jobs, jobId, onConfigSwapped } = opts;
  const job = jobs.get(jobId);
  if (!job) throw new Error(`unknown job ${jobId}`);

  try {
    jobs.update(jobId, { status: 'running', phase: 'scan' });
    const current = store.externalFolders;
    const plan = await planMove({
      home,
      scope: job.scope,
      destPath: job.destPath,
      current,
    });
    if (!plan.validation.ok) {
      throw new Error(plan.validation.reason ?? 'destination validation failed');
    }
    jobs.update(jobId, {
      totalFiles: plan.files,
      totalBytes: plan.bytes,
      sourcePath: plan.sourcePath,
    });
    if (job.cancelRequested) return finalizeCancelled(jobs, jobId);

    const isoTs = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = backupRootForScope(home, job.scope, isoTs);

    await writeSentinel(home, {
      jobId,
      scope: job.scope,
      sourcePath: plan.sourcePath,
      destPath: job.destPath,
      backupPath,
      startedAt: job.startedAt,
    });

    // 1. BACKUP: copy filtered source contents into ~/.gezel/backup/<ts>/<scope>/
    jobs.update(jobId, { phase: 'backup' });
    if (plan.sourceExists) {
      await mkdir(backupPath, { recursive: true });
      await copyFiltered({
        scope: job.scope,
        home,
        from: plan.sourcePath,
        to: backupPath,
        force: true,
        onFile: (bytes) => {
          // backup progress doesn't move the visible counters — that's
          // the user-facing "copy" phase. Log only.
          void bytes;
        },
      });
    }
    if (job.cancelRequested) return finalizeCancelled(jobs, jobId);

    // 2. COPY: source → dest with the chosen conflict policy.
    jobs.update(jobId, { phase: 'copy', filesDone: 0, bytesDone: 0 });
    if (plan.sourceExists) {
      await mkdir(job.destPath, { recursive: true });
      await copyFiltered({
        scope: job.scope,
        home,
        from: plan.sourcePath,
        to: job.destPath,
        force: job.conflictPolicy === 'overwrite-all',
        onFile: (bytes) => {
          jobs.update(jobId, {
            filesDone: (jobs.get(jobId)?.filesDone ?? 0) + 1,
            bytesDone: (jobs.get(jobId)?.bytesDone ?? 0) + bytes,
          });
        },
      });
    }
    if (job.cancelRequested) return finalizeCancelled(jobs, jobId);

    // 3. VERIFY: every file we intended to copy exists at the destination
    // (size+presence check; we trust the FS here).
    jobs.update(jobId, { phase: 'verify' });
    const missing = await verifyParity({
      scope: job.scope,
      home,
      from: plan.sourcePath,
      to: job.destPath,
      conflictPolicy: job.conflictPolicy,
    });
    if (missing.length > 0) {
      throw new Error(
        `verification failed — ${missing.length} file(s) missing at destination (first: ${missing[0]})`,
      );
    }

    // 4. SWAP: persist the new external path to config.json.
    jobs.update(jobId, { phase: 'swap' });
    const next: Record<string, string | null> = {};
    next[job.scope] = job.destPath;
    await store.writeConfig({ externalFolders: next as Record<string, string | null> });
    onConfigSwapped?.(job.scope);

    // 5. CLEANUP: delete the source-side files we just copied (leaving
    // the local-only siblings — toolsets/, workspace/, etc. — in place).
    jobs.update(jobId, { phase: 'cleanup' });
    if (plan.sourceExists) {
      await deleteFiltered({
        scope: job.scope,
        home,
        from: plan.sourcePath,
      });
    }

    // 6. PRUNE: keep last 10 backup timestamps.
    jobs.update(jobId, { phase: 'prune' });
    await pruneBackups(home);

    await clearSentinel(home);
    jobs.update(jobId, {
      status: 'done',
      restartRequired: true,
      endedAt: new Date().toISOString(),
    });
    log.info(
      `move complete: ${job.scope} → ${job.destPath} (${plan.files} files, ${plan.bytes} bytes)`,
    );
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    log.error(`move failed (${job.scope}): ${message}`);
    jobs.update(jobId, {
      status: 'error',
      error: message,
      endedAt: new Date().toISOString(),
    });
    // Leave the sentinel in place so the next boot surfaces the
    // interrupted-move warning. The user can then reset via the UI.
  }
}

function finalizeCancelled(jobs: JobManager, jobId: string): void {
  jobs.update(jobId, {
    status: 'cancelled',
    endedAt: new Date().toISOString(),
  });
  log.info(`move cancelled: ${jobId}`);
}

/**
 * Copy `from` → `to` recursively, applying the per-scope filter. Uses
 * `node:fs.cp` with a filter callback so we don't reinvent the recursion
 * loop. The callback is invoked once per source path with the absolute
 * source path — `cp` then handles the destination side.
 */
async function copyFiltered(opts: {
  scope: FolderScope;
  home: string;
  from: string;
  to: string;
  force: boolean;
  onFile: (bytes: number) => void;
}): Promise<void> {
  const filter = makeScopeFilter(opts.scope, opts.from, opts.home);
  await cp(opts.from, opts.to, {
    recursive: true,
    force: opts.force,
    errorOnExist: false,
    dereference: false,
    preserveTimestamps: true,
    filter: (src) => filter(src),
  });
  // Walk the source again to bump per-file counters. Accurate count >
  // the cleaner alternative of plumbing a per-file callback into `cp`,
  // which Node's stdlib doesn't expose.
  await walk(opts.from, async (abs) => {
    if (!filter(abs)) return false;
    const st = await stat(abs);
    if (st.isFile()) opts.onFile(st.size);
    return true;
  });
}

async function deleteFiltered(opts: {
  scope: FolderScope;
  home: string;
  from: string;
}): Promise<void> {
  const filter = makeScopeFilter(opts.scope, opts.from, opts.home);
  // Two-pass: collect the directories first (so we don't try to rm a
  // dir while still iterating), then files+dirs in reverse-depth order.
  const files: string[] = [];
  const dirs: string[] = [];
  await walk(opts.from, async (abs) => {
    if (!filter(abs)) return false;
    const st = await stat(abs);
    if (st.isDirectory()) {
      dirs.push(abs);
      return true;
    }
    files.push(abs);
    return true;
  });
  for (const f of files) {
    try {
      await rm(f);
    } catch (err) {
      log.warn(`cleanup: failed to remove ${f}: ${(err as Error).message}`);
    }
  }
  // Remove dirs deepest-first; only if empty (the local-only siblings
  // may still hold content).
  dirs.sort((a, b) => b.length - a.length);
  for (const d of dirs) {
    try {
      const remaining = await readdir(d);
      if (remaining.length === 0) await rmdir(d);
    } catch {
      /* fine — leave non-empty dirs in place */
    }
  }
}

async function verifyParity(opts: {
  scope: FolderScope;
  home: string;
  from: string;
  to: string;
  conflictPolicy: 'overwrite-all' | 'skip-all';
}): Promise<string[]> {
  const filter = makeScopeFilter(opts.scope, opts.from, opts.home);
  const missing: string[] = [];
  await walk(opts.from, async (abs) => {
    if (!filter(abs)) return false;
    const st = await stat(abs);
    if (st.isDirectory()) return true;
    const rel = relative(opts.from, abs);
    const destFile = join(opts.to, rel);
    try {
      const ds = await stat(destFile);
      // For overwrite-all the dest must match source size. For skip-all
      // a pre-existing dest file with a different size is fine — we
      // skipped it on purpose.
      if (opts.conflictPolicy === 'overwrite-all' && ds.size !== st.size) {
        missing.push(rel);
      }
    } catch {
      // dest missing entirely
      if (opts.conflictPolicy === 'overwrite-all') missing.push(rel);
      // skip-all: missing-at-dest is only ok if we *would* have skipped,
      // which by definition we wouldn't (no conflict). Treat as missing.
      else missing.push(rel);
    }
    return true;
  });
  return missing;
}

async function pruneBackups(home: string): Promise<void> {
  const root = backupsDir(home);
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return;
  }
  // Backup dirs are timestamp-named; lexicographic sort matches
  // chronological order.
  entries.sort();
  const overflow = entries.length - BACKUP_RETENTION;
  if (overflow <= 0) return;
  for (const name of entries.slice(0, overflow)) {
    try {
      await rm(join(root, name), { recursive: true, force: true });
    } catch (err) {
      log.warn(`backup prune: failed to remove ${name}: ${(err as Error).message}`);
    }
  }
}

async function walk(root: string, visit: (abs: string) => Promise<boolean>): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return;
  }
  for (const name of entries) {
    const abs = join(root, name);
    let st: import('node:fs').Stats;
    try {
      st = await stat(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      const descend = await visit(abs);
      if (descend) await walk(abs, visit);
    } else {
      await visit(abs);
    }
  }
}

export type { ExternalFolders };
