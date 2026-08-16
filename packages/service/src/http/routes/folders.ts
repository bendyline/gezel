import { Hono } from 'hono';
import { z } from 'zod';
import {
  FOLDER_SCOPES,
  type FolderScope,
  defaultRootForScope,
  planMove,
  runMove,
  sourceRootForScope,
  summarizeBackups,
} from '../../folders/index.js';
import type { ServiceContext } from '../context.js';

const ScopeSchema = z.enum(['documents', 'gezels', 'projects']);

const PlanRequestSchema = z.object({
  scope: ScopeSchema,
  destPath: z.string().min(1),
});

const MoveRequestSchema = z.object({
  scope: ScopeSchema,
  destPath: z.string().min(1),
  conflictPolicy: z.enum(['overwrite-all', 'skip-all']),
});

const ResetRequestSchema = z.object({
  scope: ScopeSchema,
});

export function folderRoutes(ctx: ServiceContext) {
  const app = new Hono();

  app.get('/', async (c) => {
    const current = ctx.store.externalFolders ?? {};
    const defaults: Record<FolderScope, string> = {
      documents: defaultRootForScope(ctx.home, 'documents'),
      gezels: defaultRootForScope(ctx.home, 'gezels'),
      projects: defaultRootForScope(ctx.home, 'projects'),
    };
    const currentResolved: Record<FolderScope, string> = {
      documents: sourceRootForScope(ctx.home, 'documents', current),
      gezels: sourceRootForScope(ctx.home, 'gezels', current),
      projects: sourceRootForScope(ctx.home, 'projects', current),
    };
    const externalized: Record<FolderScope, string | null> = {
      documents: current.documents ?? null,
      gezels: current.gezels ?? null,
      projects: current.projects ?? null,
    };
    const backupSummary = await summarizeBackups(ctx.home);
    return c.json({
      defaults,
      current: currentResolved,
      externalized,
      activeJob: ctx.folderJobs.hasActive(),
      backups: backupSummary,
    });
  });

  app.post('/plan', async (c) => {
    const body = PlanRequestSchema.parse(await c.req.json());
    const plan = await planMove({
      home: ctx.home,
      scope: body.scope,
      destPath: body.destPath,
      current: ctx.store.externalFolders,
    });
    return c.json(plan);
  });

  app.post('/move', async (c) => {
    if (ctx.folderJobs.hasActive()) {
      return c.json(
        { error: 'job-in-progress', hint: 'Wait for the current move to finish.' },
        409,
      );
    }
    const body = MoveRequestSchema.parse(await c.req.json());
    const plan = await planMove({
      home: ctx.home,
      scope: body.scope,
      destPath: body.destPath,
      current: ctx.store.externalFolders,
    });
    if (!plan.validation.ok) {
      return c.json({ error: 'invalid-destination', reason: plan.validation.reason }, 400);
    }
    const job = ctx.folderJobs.create({
      scope: body.scope,
      sourcePath: plan.sourcePath,
      destPath: body.destPath,
      conflictPolicy: body.conflictPolicy,
    });
    // Fire and forget — the worker updates the job state; the UI polls
    // GET /api/folders/move/:jobId for progress.
    void runMove({
      home: ctx.home,
      store: ctx.store,
      jobs: ctx.folderJobs,
      jobId: job.id,
      onConfigSwapped: () => {
        // Schedule the restart via the supervisor callback. The actual
        // restart waits for the user to click "Restart now" — the
        // supervisor surfaces a request, doesn't tear down mid-cleanup.
        ctx.requestRestart?.('folders-changed');
      },
    });
    return c.json({ jobId: job.id });
  });

  app.get('/move/:jobId', (c) => {
    const job = ctx.folderJobs.get(c.req.param('jobId'));
    if (!job) return c.json({ error: 'unknown-job' }, 404);
    return c.json({
      id: job.id,
      scope: job.scope,
      sourcePath: job.sourcePath,
      destPath: job.destPath,
      status: job.status,
      phase: job.phase,
      filesDone: job.filesDone,
      totalFiles: job.totalFiles,
      bytesDone: job.bytesDone,
      totalBytes: job.totalBytes,
      error: job.error,
      restartRequired: job.restartRequired,
      startedAt: job.startedAt,
      endedAt: job.endedAt,
    });
  });

  app.post('/move/:jobId/cancel', (c) => {
    const ok = ctx.folderJobs.requestCancel(c.req.param('jobId'));
    if (!ok) return c.json({ error: 'cannot-cancel' }, 409);
    return c.json({ ok: true });
  });

  app.post('/reset', async (c) => {
    if (ctx.folderJobs.hasActive()) {
      return c.json(
        { error: 'job-in-progress', hint: 'Wait for the current move to finish.' },
        409,
      );
    }
    const body = ResetRequestSchema.parse(await c.req.json());
    const current = ctx.store.externalFolders;
    if (!current?.[body.scope]) {
      return c.json({ error: 'not-externalized' }, 400);
    }
    const destPath = defaultRootForScope(ctx.home, body.scope);
    const plan = await planMove({
      home: ctx.home,
      scope: body.scope,
      destPath,
      current,
    });
    // The default destination (e.g. `~/.gezel/documents/`) is "inside
    // ~/.gezel" by definition, which our normal validation rejects.
    // For a reset move the validation result is informational only —
    // we always accept the default location.
    const job = ctx.folderJobs.create({
      scope: body.scope,
      sourcePath: plan.sourcePath,
      destPath,
      conflictPolicy: 'overwrite-all',
    });
    void runMove({
      home: ctx.home,
      store: ctx.store,
      jobs: ctx.folderJobs,
      jobId: job.id,
      onConfigSwapped: () => {
        // For reset, clear the field instead of writing the default path.
        // We do that as a follow-up writeConfig that turns the scope
        // into null (the worker already wrote the default path; this
        // collapses it back to "unset" so the on-disk shape stays
        // narrow). Fire-and-forget — restart will happen anyway.
        const patch: Record<string, string | null> = {};
        patch[body.scope] = null;
        void ctx.store.writeConfig({
          externalFolders: patch as Record<string, string | null>,
        });
        ctx.requestRestart?.('folders-changed');
      },
    });
    return c.json({ jobId: job.id });
  });

  return app;
}

// Re-export FOLDER_SCOPES so the routes file is self-contained.
export { FOLDER_SCOPES };
