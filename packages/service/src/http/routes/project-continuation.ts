import { Hono } from 'hono';
import type { ServiceContext } from '../context.js';

/**
 * Explicitly reconcile the active project's autonomous work.
 *
 * The pass is deliberately project-scoped: due schedule hosts elsewhere are
 * left for their ordinary timer, and only this project's active handoffs are
 * rehydrated. TaskScheduler serializes cron passes with its background tick;
 * TaskRunner does the same for dispatch, so this endpoint is safe to repeat.
 */
export function projectContinuationRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  app.post('/:projectId/continue', async (c) => {
    const projectId = c.req.param('projectId');
    const project = await ctx.store.getProject(projectId).catch(() => null);
    if (!project) return c.json({ error: 'not found' }, 404);

    // Reconcile existing work before ticking schedule hosts so the response
    // keeps "active work" distinct from fresh scheduled instances. A spawned
    // child is enqueued by TaskManager's normal step-activation hook.
    const active = await ctx.taskRunner.rehydrateFromStore({ projectId });
    const scheduled = await ctx.taskScheduler.tickCrons({ projectId });
    await ctx.taskRunner.wake();

    const runner = ctx.taskRunner.snapshot();
    const projectPending = runner.pendingByProject[projectId] ?? 0;
    const holdReason = scheduled.holdReason ?? (projectPending > 0 ? runner.holdReason : undefined);
    const deferredNightShiftTaskRefs = ctx.nightShift.isActive() ? [] : active.nightShiftTaskRefs;

    return c.json({
      projectId,
      projectStatus: project.status ?? 'active',
      scheduledTaskRefs: scheduled.processedTaskRefs,
      heldScheduledTaskRefs: scheduled.heldTaskRefs,
      spawnedTaskRefs: scheduled.spawnedTaskRefs,
      activeTaskRefs: active.taskRefs,
      deferredNightShiftTaskRefs,
      ...(holdReason ? { holdReason } : {}),
    });
  });

  return app;
}
