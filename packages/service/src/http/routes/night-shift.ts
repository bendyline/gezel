import { type NightShiftTaskBrief, createLogger } from '@bendyline/gezel';
import { Hono } from 'hono';
import type { ServiceContext } from '../context.js';

const log = createLogger('http');

/**
 * Night Shift control surface.
 *
 *   POST /api/night-shift/manual { action: 'start' | 'stop' }
 *     Manually begin / end a shift (e.g. the user stepping out to lunch).
 *     The window hours + power flags live in the regular config (PUT
 *     /api/config); only the manual override lives here.
 *
 *   GET  /api/night-shift/power-intent
 *     Read by the Electron shell on its existing idle-poll timer to drive
 *     OS power: hold a power-save blocker while `keepAwake`, and pre-arm a
 *     wake at `wakeAtIso`. Keeps the service free of any Electron dependency.
 */
export function nightShiftRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  app.post('/manual', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { action?: string };
    if (body.action === 'start') {
      await ctx.nightShift.startManual();
    } else if (body.action === 'stop') {
      await ctx.nightShift.stopManual();
    } else {
      return c.json({ error: "action must be 'start' or 'stop'" }, 400);
    }
    log.info(`[night-shift] manual ${body.action} → active=${ctx.nightShift.isActive()}`);
    return c.json({ active: ctx.nightShift.isActive(), source: ctx.nightShift.source() });
  });

  app.get('/status', (c) =>
    c.json({ active: ctx.nightShift.isActive(), source: ctx.nightShift.source() }),
  );

  // What the shift is working on: pending night-shift tasks split into
  // those with a turn in flight (`active`) and the rest (`upcoming`).
  // Empty when no shift is running.
  app.get('/tasks', async (c) => {
    if (!ctx.nightShift.isActive()) return c.json({ active: [], upcoming: [] });
    const running = ctx.chat.activeTaskRefs();
    const tasks = await ctx.nightShift.listPendingTasks();
    const projectNames = new Map<string, string>();
    const active: NightShiftTaskBrief[] = [];
    const upcoming: NightShiftTaskBrief[] = [];
    for (const t of tasks) {
      let projectName = projectNames.get(t.projectId);
      if (projectName === undefined) {
        const project = await ctx.store.getProject(t.projectId).catch(() => null);
        projectName = project?.name ?? t.projectId;
        projectNames.set(t.projectId, projectName);
      }
      const stepName = t.craftbook.steps.find((s) => s.id === t.activeStepId)?.name;
      const brief: NightShiftTaskBrief = {
        ref: t.ref,
        title: t.title,
        projectName,
        ...(stepName ? { stepName } : {}),
      };
      (running.has(t.ref) ? active : upcoming).push(brief);
    }
    return c.json({ active, upcoming });
  });

  app.get('/power-intent', (c) => c.json(ctx.nightShift.getPowerIntent()));

  return app;
}
