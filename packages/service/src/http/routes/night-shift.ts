import {
  type NightShiftTallyResponse,
  type NightShiftTaskBrief,
  createLogger,
} from '@bendyline/gezel';
import { Hono } from 'hono';
import { buildNightShiftReview } from '../../tasks/night-review.js';
import { buildNightShiftTally, nightShiftTallyPeriod } from '../../tasks/night-tally.js';
import type { ServiceContext } from '../context.js';

const log = createLogger('http');

/**
 * Each tally build rescans the audit log and opens every project's content
 * index, and the moon menu polls on a 5s cadence. A short memo keeps an
 * open menu from sweeping the disk twelve times a minute — over a window
 * this brief the counts barely move.
 */
const TALLY_TTL_MS = 15_000;

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

  // One shape for /status and the /manual response: on/off, when the period
  // started and when the scheduled one ends, plus the quota-reserve hold
  // summary while pending night work is parked by it.
  const statusJson = () => {
    const quotaHold = ctx.nightShift.quotaHoldStatus();
    return {
      active: ctx.nightShift.isActive(),
      source: ctx.nightShift.source(),
      window: ctx.nightShift.windowBounds(),
      startedAt: ctx.nightShift.startedAtIso(),
      ...(quotaHold ? { quotaHold } : {}),
    };
  };

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
    return c.json(statusJson());
  });

  app.get('/status', (c) => c.json(statusJson()));

  // What the shift is working on: pending night-shift tasks split into
  // those with a turn in flight (`active`) and the rest (`upcoming`).
  //
  // Answered whether or not a shift is running. While it's off, everything
  // eligible lands in `upcoming` — that's the daytime question ("what will
  // my crew do tonight?"), and it's the only place it gets answered, since
  // handoffs parked for the night window are deliberately kept out of the
  // header's task queue rather than sitting there looking stuck.
  app.get('/tasks', async (c) => {
    const running = ctx.chat.activeTaskRefs();
    const runner = ctx.taskRunner.workSnapshot();
    const queued = new Set([...runner.queuedTaskRefs, ...runner.dispatchedTaskRefs]);
    const quotaHeld = ctx.nightShift.quotaHeldTaskRefs();
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
        ...(quotaHeld.has(t.ref) ? { quotaHeld: true } : {}),
      };
      if (running.has(t.ref)) active.push(brief);
      else if (queued.has(t.ref)) upcoming.push(brief);
    }
    // Background chores are only the shift's business while it's running —
    // daytime indexing belongs to the day, not to tonight's plan.
    const indexActivity = ctx.nightShift.isActive() ? ctx.indexEnrichment.getActivity() : null;
    const background = indexActivity
      ? [
          {
            id: indexActivity.id,
            title: indexActivity.title,
            detail: indexActivity.detail,
            ...(indexActivity.projectName ? { projectName: indexActivity.projectName } : {}),
          },
        ]
      : [];
    return c.json({ background, active, upcoming });
  });

  app.get('/power-intent', (c) => c.json(ctx.nightShift.getPowerIntent()));

  // How much the shift has got through: the running period's counts, or the
  // last window's once it's over. Deliberately the same period the review
  // below reports on, so the numbers and the list can't describe two
  // different nights.
  let cached: { since: string; live: boolean; at: number; tally: NightShiftTallyResponse } | null =
    null;
  app.get('/tally', async (c) => {
    const period = nightShiftTallyPeriod(new Date(), ctx.nightShift.currentWindow(), {
      active: ctx.nightShift.isActive(),
      startedAt: ctx.nightShift.startedAtIso(),
    });
    const since = period.since.toISOString();
    const now = Date.now();
    if (cached && cached.since === since && cached.live === period.live) {
      if (now - cached.at < TALLY_TTL_MS) return c.json(cached.tally);
    }
    const tally = await buildNightShiftTally(
      { history: ctx.history, store: ctx.store, contentIndex: ctx.contentIndex },
      period,
    );
    cached = { since, live: period.live, at: now, tally };
    return c.json(tally);
  });

  // The morning review: what the most recent night window accomplished —
  // completed tasks + the reports they left, with embedded-action tallies.
  // Powers the moon menu's "Done last night" and the Home "Last night" tab.
  app.get('/review', async (c) => {
    const review = await buildNightShiftReview(
      { store: ctx.store, tasks: ctx.tasks, reportActions: ctx.reportActions },
      ctx.nightShift.currentWindow(),
      new Date(),
    );
    return c.json(review);
  });

  return app;
}
