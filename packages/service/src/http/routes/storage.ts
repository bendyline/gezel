/**
 * /api/storage — disk accounting plus the cleanup operation built on it.
 *
 *   GET  /api/storage/summary[?refresh=1] → StorageSummary
 *   POST /api/storage/cleanup             → { jobId }
 *   GET  /api/storage/cleanup/:jobId      → StorageJob
 *   POST /api/storage/cleanup/:jobId/cancel
 *
 * This exists because uninstalling Gezel cannot decide what happens to the
 * user's home directory: an npm uninstall gets no hook, and the Windows and
 * Linux installers deliberately preserve it. Someone who removes Gezel
 * without a way to see and reclaim tens of gigabytes of models simply
 * strands them.
 */

import { isAbsolute } from 'node:path';
import {
  BackupRequestSchema,
  CleanupRequestSchema,
  GEZEL_VERSION,
  RestoreConfirmSchema,
  RestoreScanRequestSchema,
} from '@bendyline/gezel';
import { Hono } from 'hono';
import { planBackup, runBackup } from '../../storage/backup.js';
import {
  runCleanup,
  undeletableCategories,
  userContentCategories,
} from '../../storage/cleanup-worker.js';
import { cancelRestore, readReview, runRestore, scanRestore } from '../../storage/restore.js';
import { buildStorageSummary } from '../../storage/summary.js';
import type { ServiceContext } from '../context.js';

function backupDeps(ctx: ServiceContext) {
  return {
    home: ctx.store.homePath,
    store: ctx.store,
    jobs: ctx.storageJobs,
    version: GEZEL_VERSION,
  };
}

function restoreDeps(ctx: ServiceContext) {
  return { home: ctx.store.homePath, store: ctx.store, jobs: ctx.storageJobs };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function storageRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  app.get('/summary', async (c) => {
    const refresh = c.req.query('refresh') === '1';
    const summary = await buildStorageSummary(
      { home: ctx.store.homePath, store: ctx.store },
      refresh,
    );
    return c.json(summary);
  });

  app.post('/cleanup', async (c) => {
    const parsed = CleanupRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: 'invalid-request', detail: parsed.error.message }, 400);
    }
    const request = parsed.data;

    const undeletable = undeletableCategories(request.categories);
    if (undeletable.length > 0) {
      return c.json({ error: 'not-deletable', categories: undeletable }, 400);
    }

    // A UI bug must not be able to delete somebody's gezels by omission, so
    // the destructive half of the surface needs its own explicit flag.
    const userContent = userContentCategories(request.categories);
    if (userContent.length > 0 && request.confirmUserContent !== true) {
      return c.json({ error: 'confirm-required', categories: userContent }, 400);
    }

    // Cleanup and a folder move rewrite the same trees; running both means
    // one deletes what the other is copying.
    if (ctx.storageJobs.hasActive() || ctx.folderJobs?.hasActive()) {
      return c.json({ error: 'job-in-progress' }, 409);
    }

    const job = ctx.storageJobs.create('cleanup');
    void runCleanup(
      {
        home: ctx.store.homePath,
        store: ctx.store,
        jobs: ctx.storageJobs,
        listInflight: () => ctx.chat?.listInflight() ?? [],
        invalidateModelsCache: ctx.invalidateModelsCache,
      },
      request,
      job,
    ).catch(() => {
      // runCleanup records the failure on the job before rethrowing; the
      // client learns about it by polling, not from this call.
    });

    return c.json({ jobId: job.id });
  });

  app.get('/backup/plan', async (c) => {
    const plan = await planBackup(backupDeps(ctx), {
      destPath: c.req.query('dest'),
      excludeWorkspaces: c.req.query('excludeWorkspaces') === '1',
    });
    return c.json(plan);
  });

  app.post('/backup', async (c) => {
    const parsed = BackupRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: 'invalid-request', detail: parsed.error.message }, 400);
    }
    if (!isAbsolute(parsed.data.outPath)) {
      return c.json({ error: 'invalid-request', detail: 'outPath must be absolute' }, 400);
    }
    if (ctx.storageJobs.hasActive() || ctx.folderJobs?.hasActive()) {
      return c.json({ error: 'job-in-progress' }, 409);
    }

    const job = ctx.storageJobs.create('backup');
    void runBackup(backupDeps(ctx), parsed.data, job).catch(() => {
      // Recorded on the job; the client learns by polling.
    });
    return c.json({ jobId: job.id });
  });

  app.post('/restore/scan', async (c) => {
    const parsed = RestoreScanRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: 'invalid-request', detail: parsed.error.message }, 400);
    }
    if (!isAbsolute(parsed.data.path)) {
      return c.json({ error: 'invalid-request', detail: 'path must be absolute' }, 400);
    }
    try {
      return c.json(await scanRestore(restoreDeps(ctx), parsed.data.path));
    } catch (err) {
      // A wrong file or a corrupt archive is a normal thing for a person to
      // do; it deserves the reason, not a 500.
      return c.json({ error: 'unreadable-backup', detail: messageOf(err) }, 400);
    }
  });

  app.post('/restore/:restoreId/confirm', async (c) => {
    const parsed = RestoreConfirmSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: 'invalid-request', detail: parsed.error.message }, 400);
    }
    const review = await readReview(ctx.store.homePath, c.req.param('restoreId'));
    if (!review) return c.json({ error: 'not-found' }, 404);
    if (ctx.storageJobs.hasActive() || ctx.folderJobs?.hasActive()) {
      return c.json({ error: 'job-in-progress' }, 409);
    }

    const job = ctx.storageJobs.create('restore');
    void runRestore(restoreDeps(ctx), review, parsed.data, job).catch(() => {
      // Recorded on the job; the client learns by polling.
    });
    return c.json({ jobId: job.id });
  });

  app.post('/restore/:restoreId/cancel', async (c) => {
    await cancelRestore(ctx.store.homePath, c.req.param('restoreId'));
    return c.json({ cancelled: true });
  });

  // One getter for every kind of storage job — cleanup, backup, and restore
  // all report the same shape, and the client should not have to know which
  // path a job id came from.
  app.get('/jobs/:jobId', (c) => {
    const job = ctx.storageJobs.get(c.req.param('jobId'));
    if (!job) return c.json({ error: 'not-found' }, 404);
    return c.json(job);
  });

  app.get('/cleanup/:jobId', (c) => {
    const job = ctx.storageJobs.get(c.req.param('jobId'));
    if (!job) return c.json({ error: 'not-found' }, 404);
    return c.json(job);
  });

  app.post('/cleanup/:jobId/cancel', (c) => {
    const cancelled = ctx.storageJobs.requestCancel(c.req.param('jobId'));
    if (!cancelled) return c.json({ error: 'not-cancellable' }, 409);
    return c.json({ cancelled: true });
  });

  return app;
}
