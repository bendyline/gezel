import {
  AppendTaskNoteRequestSchema,
  CompleteStepRequestSchema,
  type Craftbook,
  CreateTaskRequestSchema,
  type NewCraftbookStep,
  NewCraftbookStepSchema,
  SetTaskStatusRequestSchema,
  SpawnTaskInstancesRequestSchema,
  StepPositionSchema,
  type Task,
  type TaskNoteAuthor,
  TaskStatusSchema,
  UpdateTaskCraftbookRequestSchema,
  UpdateTaskNoteRequestSchema,
  UpdateTaskRequestSchema,
  UpdateTaskStepRequestSchema,
  taskRef as buildTaskRef,
  craftbookDocFormatFromEnv,
  craftbookFromDoc,
  createLogger,
  docFromCraftbook,
  formatCraftbookDocErrors,
  nowIso,
  parseCraftbookDoc,
  resolveSteps,
  serializeCraftbookDoc,
  slugifyStepId,
} from '@bendyline/gezel';
import type { CraftbookDocError, CraftbookDocFormat } from '@bendyline/gezel';
import { Hono } from 'hono';
import { z } from 'zod';
import { ConnectorPrepError } from '../../connectors/task-prep.js';
import { craftbookScriptErrors } from '../../scripts/source.js';
import { dispatchTaskEntry } from '../../tasks/entry-dispatch.js';
import { ConnectorSetupRequiredError, CraftbookSetupRequiredError } from '../../tasks/manager.js';
import type { ServiceContext } from '../context.js';

const taskDocLog = createLogger('craftbooks');

function taskDocFormat(raw: string | undefined): CraftbookDocFormat {
  if (raw === 'json') return 'json';
  if (raw === 'md' || raw === 'markdown') return 'markdown';
  return craftbookDocFormatFromEnv(process.env.GEZEL_CRAFTBOOK_DOC_FORMAT);
}

function taskDocRejection(format: CraftbookDocFormat, errors: CraftbookDocError[]) {
  taskDocLog.info(
    `[craftbook-doc] validation rejected format=${format === 'markdown' ? 'md' : 'json'} problems=${errors.length}: ${errors[0]?.message ?? ''}`,
  );
  return { errors, formatted: formatCraftbookDocErrors(errors) };
}

const ListFilterSchema = z.object({
  status: TaskStatusSchema.optional(),
  assignee: z.string().optional(),
});

function parseNum(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0 || String(n) !== raw) return null;
  return n;
}

/**
 * Notes carry provenance: a gezel id from the MCP bridge resolves to that
 * gezel's name, otherwise the action is attributed to the user (UI calls
 * never set the header). The header is a hint, not a credential — the
 * daemon already authenticates the bearer token at a higher layer.
 */
async function resolveActor(
  ctx: ServiceContext,
  gezelIdHeader: string | undefined,
): Promise<TaskNoteAuthor> {
  if (!gezelIdHeader) return { kind: 'user' };
  try {
    const gezel = await ctx.store.getGezel(gezelIdHeader);
    if (gezel) return { kind: 'gezel', gezelId: gezel.id, name: gezel.name };
  } catch {
    // Fall through to user actor below.
  }
  return { kind: 'user' };
}

export function projectTaskRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();
  const inflightCraftbookInvocations = new Map<string, Promise<Task>>();

  // Nested under /api/projects/:id/tasks — see http/server.ts
  app.get('/:projectId/tasks', async (c) => {
    const projectId = c.req.param('projectId');
    const filter = ListFilterSchema.parse({
      ...(c.req.query('status') ? { status: c.req.query('status') } : {}),
      ...(c.req.query('assignee') ? { assignee: c.req.query('assignee') } : {}),
    });
    const tasks = await ctx.tasks.list({
      projectId,
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.assignee ? { assigneeGezelId: filter.assignee } : {}),
    });
    return c.json({ tasks });
  });

  app.post('/:projectId/tasks', async (c) => {
    const projectId = c.req.param('projectId');
    const { dispatchEntry, craftbookInvocationKey, ...body } = CreateTaskRequestSchema.parse(
      await c.req.json(),
    );
    let task: Task;
    try {
      if (craftbookInvocationKey) {
        const existing = (await ctx.tasks.list({ projectId })).find(
          (candidate) =>
            candidate.origin?.kind === 'craftbook-invocation' &&
            candidate.origin.key === craftbookInvocationKey &&
            (candidate.status === 'draft' ||
              candidate.status === 'active' ||
              candidate.status === 'paused'),
        );
        if (existing) return c.json(existing);

        const inflightKey = `${projectId}:${craftbookInvocationKey}`;
        const pending = inflightCraftbookInvocations.get(inflightKey);
        if (pending) return c.json(await pending);

        const create = ctx.tasks.create(projectId, body, {
          origin: { kind: 'craftbook-invocation', key: craftbookInvocationKey },
        });
        inflightCraftbookInvocations.set(inflightKey, create);
        try {
          task = await create;
        } finally {
          inflightCraftbookInvocations.delete(inflightKey);
        }
      } else {
        task = await ctx.tasks.create(projectId, body);
      }
    } catch (err) {
      // A launch that fails its own preconditions is a 409 the caller
      // renders, never a 500 — the catch-all handler scrubs the body, and
      // these messages ARE the fix instructions.
      if (err instanceof CraftbookSetupRequiredError) {
        return c.json(
          {
            error: err.message,
            code: err.code,
            craftbookId: err.craftbookId,
            missingToolsets: err.missingToolsets,
          },
          409,
        );
      }
      if (err instanceof ConnectorSetupRequiredError) {
        return c.json(
          {
            error: err.message,
            code: err.code,
            craftbookId: err.craftbookId,
            missingConnectors: err.missingConnectors,
          },
          409,
        );
      }
      if (err instanceof ConnectorPrepError) {
        return c.json(
          {
            error: err.message,
            code: err.code,
            craftbookId: err.craftbookId,
            connectorTypeId: err.typeId,
            reason: err.reason,
          },
          409,
        );
      }
      throw err;
    }
    if (dispatchEntry) {
      // Single-channel kickoff: hand the entry step to its gezel as a
      // task-scoped handoff. Best-effort — guard trips are logged +
      // visible as an absent task.entry.dispatched history event.
      await dispatchTaskEntry(
        { store: ctx.store, taskRunner: ctx.taskRunner, history: ctx.history },
        task,
      );
    }
    return c.json(task, 201);
  });

  app.get('/:projectId/tasks/:num', async (c) => {
    const projectId = c.req.param('projectId');
    const num = parseNum(c.req.param('num'));
    if (num == null) return c.json({ error: 'invalid num' }, 400);
    const task = await ctx.tasks.get(projectId, num);
    if (!task) return c.json({ error: 'not found' }, 404);
    return c.json(task);
  });

  app.patch('/:projectId/tasks/:num', async (c) => {
    const projectId = c.req.param('projectId');
    const num = parseNum(c.req.param('num'));
    if (num == null) return c.json({ error: 'invalid num' }, 400);
    const body = UpdateTaskRequestSchema.parse(await c.req.json());
    const task = await ctx.tasks.update(projectId, num, body);
    return c.json(task);
  });

  app.post('/:projectId/tasks/:num/status', async (c) => {
    const projectId = c.req.param('projectId');
    const num = parseNum(c.req.param('num'));
    if (num == null) return c.json({ error: 'invalid num' }, 400);
    const body = SetTaskStatusRequestSchema.parse(await c.req.json());
    const task = await ctx.tasks.setStatus(projectId, num, body.status);
    return c.json(task);
  });

  // Activate a draft task: flip draft → active and kick off its entry step.
  // Optional `{ force: true }` bypasses the plan-readiness guardrails.
  app.post('/:projectId/tasks/:num/activate', async (c) => {
    const projectId = c.req.param('projectId');
    const num = parseNum(c.req.param('num'));
    if (num == null) return c.json({ error: 'invalid num' }, 400);
    const body = (await c.req.json().catch(() => ({}))) as { force?: boolean };
    const task = await ctx.tasks.activate(projectId, num, { force: body.force === true });
    return c.json(task);
  });

  app.post('/:projectId/tasks/:num/steps', async (c) => {
    const projectId = c.req.param('projectId');
    const num = parseNum(c.req.param('num'));
    if (num == null) return c.json({ error: 'invalid num' }, 400);
    const raw = await c.req.json();
    const body = NewCraftbookStepSchema.parse(raw);
    // Optional placement: `after`/`before`/`index` may ride alongside the
    // step blueprint. Absent → append.
    const pos = StepPositionSchema.parse(raw);
    const hasPos = pos.after != null || pos.before != null || pos.index != null;
    const task = await ctx.tasks.addStep(projectId, num, body, hasPos ? pos : undefined);
    return c.json(task);
  });

  app.post('/:projectId/tasks/:num/steps/:stepId/activate', async (c) => {
    const projectId = c.req.param('projectId');
    const num = parseNum(c.req.param('num'));
    if (num == null) return c.json({ error: 'invalid num' }, 400);
    const task = await ctx.tasks.activateStep(projectId, num, c.req.param('stepId'));
    return c.json(task);
  });

  app.post('/:projectId/tasks/:num/steps/:stepId/complete', async (c) => {
    const projectId = c.req.param('projectId');
    const num = parseNum(c.req.param('num'));
    if (num == null) return c.json({ error: 'invalid num' }, 400);
    const body = CompleteStepRequestSchema.parse(await c.req.json().catch(() => ({})));
    const outcome = await ctx.tasks.completeStepChecked(
      projectId,
      num,
      c.req.param('stepId'),
      body.next,
      body.force ? { force: true, cause: 'user' } : { cause: 'model' },
    );
    if (outcome.status === 'held') {
      // 200 + structured gate info — a rejection is a first-class result
      // the caller renders (MCP tool text, UI banner), not a transport
      // error.
      return c.json({
        task: outcome.task,
        gate: {
          decision: 'reject' as const,
          message: outcome.gate.message,
          attempt: outcome.gate.attempt,
          maxAttempts: outcome.gate.maxAttempts,
          paused: outcome.gate.paused,
          ...(outcome.gate.infrastructureError ? { infrastructureError: true } : {}),
          ...(outcome.gate.scriptRuns ? { scriptRuns: outcome.gate.scriptRuns } : {}),
        },
      });
    }
    return c.json({ task: outcome.task });
  });

  app.patch('/:projectId/tasks/:num/steps/:stepId', async (c) => {
    const projectId = c.req.param('projectId');
    const num = parseNum(c.req.param('num'));
    if (num == null) return c.json({ error: 'invalid num' }, 400);
    const body = UpdateTaskStepRequestSchema.parse(await c.req.json());
    const task = await ctx.tasks.updateStep(projectId, num, c.req.param('stepId'), body);
    if (!task) return c.json({ error: 'not found' }, 404);
    return c.json({ task });
  });

  app.delete('/:projectId/tasks/:num/steps/:stepId', async (c) => {
    const projectId = c.req.param('projectId');
    const num = parseNum(c.req.param('num'));
    if (num == null) return c.json({ error: 'invalid num' }, 400);
    const task = await ctx.tasks.removeStep(projectId, num, c.req.param('stepId'));
    if (!task) return c.json({ error: 'not found' }, 404);
    return c.json({ task });
  });

  // Reorder a task's embedded craftbook steps (a permutation of the ids).
  app.patch('/:projectId/tasks/:num/craftbook/steps/order', async (c) => {
    const projectId = c.req.param('projectId');
    const num = parseNum(c.req.param('num'));
    if (num == null) return c.json({ error: 'invalid num' }, 400);
    const body = z.object({ order: z.array(z.string()).min(1) }).parse(await c.req.json());
    const task = await ctx.tasks.reorderSteps(projectId, num, body.order);
    return c.json({ task });
  });

  // Patch the overall metadata of a task's embedded craftbook + entry step.
  app.patch('/:projectId/tasks/:num/craftbook', async (c) => {
    const projectId = c.req.param('projectId');
    const num = parseNum(c.req.param('num'));
    if (num == null) return c.json({ error: 'invalid num' }, 400);
    const body = UpdateTaskCraftbookRequestSchema.parse(await c.req.json());
    const task = await ctx.tasks.updateCraftbookMeta(projectId, num, body);
    return c.json({ task });
  });

  // Whole-document read of a task's embedded craftbook — the round-
  // trippable format `craftbook_read`/`craftbook_write` speak.
  app.get('/:projectId/tasks/:num/craftbook/document', async (c) => {
    const projectId = c.req.param('projectId');
    const num = parseNum(c.req.param('num'));
    if (num == null) return c.json({ error: 'invalid num' }, 400);
    const task = await ctx.tasks.get(projectId, num);
    if (!task) return c.json({ error: 'not found' }, 404);
    const format = taskDocFormat(c.req.query('format'));
    // Strip per-instance lifecycle fields; the doc is the recipe, not the run.
    const steps = task.craftbook.steps.map((s) => {
      const {
        createdAt,
        completedAt,
        attemptCount,
        lastActivatedAt,
        gateAttempts,
        lastGateReject,
        redriveCount,
        lastRedriveAt,
        ...rest
      } = s;
      void createdAt;
      void completedAt;
      void attemptCount;
      void lastActivatedAt;
      void gateAttempts;
      void lastGateReject;
      void redriveCount;
      void lastRedriveAt;
      return rest;
    });
    const content = serializeCraftbookDoc(
      docFromCraftbook({ ...task.craftbook, steps } as Craftbook),
      format,
    );
    return c.json({ format, content });
  });

  // Whole-document replace of a task's embedded craftbook. Lifecycle
  // fields survive for step ids that survive; 422 + repair-grade errors
  // (and no write) when the document doesn't validate.
  app.put('/:projectId/tasks/:num/craftbook/document', async (c) => {
    const projectId = c.req.param('projectId');
    const num = parseNum(c.req.param('num'));
    if (num == null) return c.json({ error: 'invalid num' }, 400);
    const existing = await ctx.tasks.get(projectId, num);
    if (!existing) return c.json({ error: 'not found' }, 404);
    const body = z
      .object({ content: z.string().min(1), format: z.enum(['json', 'md', 'markdown']).optional() })
      .parse(await c.req.json());
    const format = taskDocFormat(body.format);
    const parsed = parseCraftbookDoc(body.content, format);
    if (!parsed.ok) return c.json(taskDocRejection(format, parsed.errors), 422);
    const built = craftbookFromDoc(parsed.doc, {
      now: nowIso(),
      id: existing.craftbook.id,
      createdAt: existing.craftbook.createdAt,
    });
    if (!built.ok) return c.json(taskDocRejection(format, built.errors), 422);
    if (built.craftbook.scripts) {
      const problems = craftbookScriptErrors(built.craftbook.scripts);
      if (problems.length > 0) {
        return c.json(
          taskDocRejection(
            format,
            problems.map((message) => ({ where: 'scripts', message })),
          ),
          422,
        );
      }
    }
    const task = await ctx.tasks.replaceCraftbook(projectId, num, built.craftbook);
    const gated = task.craftbook.steps.filter((s) => s.gate || s.advanceWhen).length;
    return c.json({ task, format, stepCount: task.craftbook.steps.length, gatedSteps: gated });
  });

  // Promote a task's embedded craftbook into a reusable LOCAL template —
  // the inverse of invoke_craftbook (template → task). Strips per-instance
  // lifecycle fields and mints a fresh, collision-free local craftbook id.
  app.post('/:projectId/tasks/:num/export-craftbook', async (c) => {
    const projectId = c.req.param('projectId');
    const num = parseNum(c.req.param('num'));
    if (num == null) return c.json({ error: 'invalid num' }, 400);
    const body = z
      .object({ id: z.string().optional(), name: z.string().min(1).optional() })
      .parse(await c.req.json().catch(() => ({})));
    const task = await ctx.tasks.get(projectId, num);
    if (!task) return c.json({ error: 'not found' }, 404);

    const name = body.name ?? task.craftbook.name;
    // Drop the per-instance lifecycle fields; keep the full step recipe.
    const blueprints: NewCraftbookStep[] = task.craftbook.steps.map((s) => {
      const { createdAt, completedAt, attemptCount, lastActivatedAt, ...rest } = s;
      void createdAt;
      void completedAt;
      void attemptCount;
      void lastActivatedAt;
      return rest;
    });
    const steps = resolveSteps(blueprints);
    const entryStepId = steps.some((s) => s.id === task.craftbook.entryStepId)
      ? task.craftbook.entryStepId
      : steps[0]!.id;

    // Mint a unique local id (slug from name, suffix on collision).
    const existing = new Set((await ctx.store.listLocalCraftbookTemplates()).map((b) => b.id));
    let id = body.id && body.id.length > 0 ? body.id : slugifyStepId(name);
    const baseId = id;
    let suffix = 2;
    while (existing.has(id)) id = `${baseId}-${suffix++}`;

    const now = nowIso();
    const book: Craftbook = {
      id,
      name,
      ...(task.craftbook.description ? { description: task.craftbook.description } : {}),
      version: '1.0.0',
      ...(task.craftbook.basedOn ? { basedOn: task.craftbook.basedOn } : {}),
      ...(task.craftbook.plan ? { plan: task.craftbook.plan } : {}),
      ...(task.craftbook.defaultAssignee
        ? { defaultAssignee: task.craftbook.defaultAssignee }
        : {}),
      steps,
      entryStepId,
      createdAt: now,
      updatedAt: now,
    };
    await ctx.store.writeLocalCraftbookTemplate(book);
    await ctx.history?.log({
      kind: 'craftbook.created',
      projectId,
      summary: `Exported task ${task.ref} as craftbook "${book.name}" (${id})`,
      details: { id, name: book.name, stepCount: steps.length, fromTask: task.ref },
    });
    return c.json({ craftbook: book }, 201);
  });

  app.get('/:projectId/tasks/:num/notes', async (c) => {
    const projectId = c.req.param('projectId');
    const num = parseNum(c.req.param('num'));
    if (num == null) return c.json({ error: 'invalid num' }, 400);
    const step = c.req.query('step') || undefined;
    const notes = await ctx.tasks.listNotes(projectId, num, step);
    return c.json({ notes });
  });

  app.post('/:projectId/tasks/:num/notes', async (c) => {
    const projectId = c.req.param('projectId');
    const num = parseNum(c.req.param('num'));
    if (num == null) return c.json({ error: 'invalid num' }, 400);
    const body = AppendTaskNoteRequestSchema.parse(await c.req.json());
    const author = await resolveActor(ctx, c.req.header('x-gezel-actor'));
    const note = await ctx.tasks.appendNote(projectId, num, {
      text: body.text,
      author,
      ...(body.stepId ? { stepId: body.stepId } : {}),
    });
    return c.json({ note }, 201);
  });

  app.delete('/:projectId/tasks/:num/notes/:noteId', async (c) => {
    const projectId = c.req.param('projectId');
    const num = parseNum(c.req.param('num'));
    if (num == null) return c.json({ error: 'invalid num' }, 400);
    const noteId = c.req.param('noteId');
    const actor = await resolveActor(ctx, c.req.header('x-gezel-actor'));
    const removed = await ctx.tasks.deleteNote(projectId, num, noteId, actor);
    if (!removed) return c.json({ error: 'not found' }, 404);
    return c.json({ ok: true });
  });

  app.patch('/:projectId/tasks/:num/notes/:noteId', async (c) => {
    const projectId = c.req.param('projectId');
    const num = parseNum(c.req.param('num'));
    if (num == null) return c.json({ error: 'invalid num' }, 400);
    const noteId = c.req.param('noteId');
    const body = UpdateTaskNoteRequestSchema.parse(await c.req.json());
    const actor = await resolveActor(ctx, c.req.header('x-gezel-actor'));
    const note = await ctx.tasks.updateNote(projectId, num, noteId, body.text, actor);
    if (!note) return c.json({ error: 'not found' }, 404);
    return c.json({ note });
  });

  app.get('/:projectId/tasks/:num/sessions', async (c) => {
    const projectId = c.req.param('projectId');
    const num = parseNum(c.req.param('num'));
    if (num == null) return c.json({ error: 'invalid num' }, 400);
    const sessions = await ctx.tasks.listSessions(projectId, num);
    return c.json({ sessions });
  });

  // List children spawned from a parent task (cron instances or fanout).
  app.get('/:projectId/tasks/:num/children', async (c) => {
    const projectId = c.req.param('projectId');
    const num = parseNum(c.req.param('num'));
    if (num == null) return c.json({ error: 'invalid num' }, 400);
    const ref = buildTaskRef(projectId, num);
    const statusRaw = c.req.query('status');
    const parsedStatus = statusRaw ? TaskStatusSchema.safeParse(statusRaw) : null;
    const limitRaw = c.req.query('limit');
    const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
    const tasks = await ctx.tasks.listChildren(ref, {
      ...(parsedStatus?.success ? { status: parsedStatus.data } : {}),
      ...(Number.isFinite(limit) && limit && limit > 0 ? { limit } : {}),
    });
    return c.json({ tasks });
  });

  // Imperative fanout: spawn N children now. Also materializes declarative
  // fanout when present and unmaterialized (count omitted means "whatever
  // fanout.count says" — handy for retrying a failed materialization).
  app.post('/:projectId/tasks/:num/spawn', async (c) => {
    const projectId = c.req.param('projectId');
    const num = parseNum(c.req.param('num'));
    if (num == null) return c.json({ error: 'invalid num' }, 400);
    const body = SpawnTaskInstancesRequestSchema.parse(await c.req.json().catch(() => ({})));
    const ref = buildTaskRef(projectId, num);
    if (body.count == null) {
      const result = await ctx.tasks.materializeFanout(projectId, num);
      return c.json({ parent: result.parent, children: result.children }, 201);
    }
    const children = await ctx.tasks.spawnInstances(ref, body.count, body.variations);
    return c.json({ children }, 201);
  });

  return app;
}

/** Global `/api/tasks` — list across every project. */
export function globalTaskRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();
  app.get('/', async (c) => {
    const filter = ListFilterSchema.parse({
      ...(c.req.query('status') ? { status: c.req.query('status') } : {}),
      ...(c.req.query('assignee') ? { assignee: c.req.query('assignee') } : {}),
    });
    const tasks = await ctx.tasks.list({
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.assignee ? { assigneeGezelId: filter.assignee } : {}),
    });
    return c.json({ tasks });
  });
  return app;
}
