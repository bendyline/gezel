import type { HistoryEventKind } from '@bendyline/gezel';
import { Hono } from 'hono';
import { z } from 'zod';
import type { ServiceContext } from '../context.js';

const KNOWN_KINDS: HistoryEventKind[] = [
  'gezel.created',
  'gezel.deleted',
  'gezel.renamed',
  'gezel.settings.updated',
  'gezel.about.generated',
  'icon.generated',
  'icon.reverted',
  'project.created',
  'project.updated',
  'project.about.updated',
  'project.mission.updated',
  'project.voorman.changed',
  'project.digest.generated',
  'meester.status.generated',
  'document.created',
  'document.deleted',
  'tool.called',
  'meester.changed',
  'task.created',
  'task.updated',
  'task.status.changed',
  'task.assignee.changed',
  'task.step.added',
  'task.step.activated',
  'task.step.completed',
  'task.step.gated',
  'task.step.routed',
  'task.entry.dispatched',
  'task.tick',
  'task.canceled',
  'gezel.level.up',
  'gezel.trait.adopted',
  'gezel.trait.removed',
  'gezel.tuning.adjusted',
];

export function historyRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  app.get('/export', async (c) => {
    const projectId = c.req.query('project') || undefined;
    const redact = new Set((c.req.query('redact') ?? '').split(',').filter(Boolean));
    const events = (await ctx.history.listEvents({ projectId })).map((event) => ({
      ...event,
      ...(redact.has('details') ? { details: undefined } : {}),
      ...(redact.has('summary') ? { summary: '[redacted]' } : {}),
      ...(redact.has('identifiers') ? { projectId: undefined, gezelId: undefined } : {}),
    }));
    c.header('Content-Disposition', 'attachment; filename="gezel-history-export.json"');
    return c.json({
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      scope: 'explicit-audit-events-only',
      note: 'Chat sessions are separate user-owned records and are not included or deleted by history privacy operations.',
      events,
    });
  });

  const RewriteSchema = z.object({
    confirm: z.literal(true),
    before: z.string().datetime().optional(),
    projectId: z.string().min(1).optional(),
  });
  app.delete('/events', async (c) => {
    const body = RewriteSchema.parse(await c.req.json());
    const deleted = await ctx.history.deleteEvents({
      ...(body.before ? { before: body.before } : {}),
      ...(body.projectId ? { projectId: body.projectId } : {}),
    });
    return c.json({ ok: true, deleted, sessionsAffected: 0 });
  });

  app.post('/events/redact', async (c) => {
    const body = RewriteSchema.extend({
      fields: z.array(z.enum(['details', 'summary', 'identifiers'])).min(1),
    }).parse(await c.req.json());
    const redacted = await ctx.history.redactEvents({
      fields: body.fields,
      ...(body.before ? { before: body.before } : {}),
      ...(body.projectId ? { projectId: body.projectId } : {}),
    });
    return c.json({ ok: true, redacted, sessionsAffected: 0 });
  });

  app.get('/', async (c) => {
    const filter = {
      projectId: c.req.query('project') || undefined,
      gezelId: c.req.query('gezel') || undefined,
      kinds: parseKinds(c.req.query('kind')),
      from: c.req.query('from') || undefined,
      to: c.req.query('to') || undefined,
      q: c.req.query('q') || undefined,
      limit: parseIntOr(c.req.query('limit'), 200),
    };
    const include = c.req.query('include');
    if (include === 'events') {
      const events = await ctx.history.listEvents(filter);
      return c.json({ events });
    }
    const entries = await ctx.history.listEntries(filter);
    return c.json({ entries });
  });

  return app;
}

function parseKinds(raw: string | undefined): HistoryEventKind[] | undefined {
  if (!raw) return undefined;
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const valid = parts.filter((k): k is HistoryEventKind => (KNOWN_KINDS as string[]).includes(k));
  return valid.length > 0 ? valid : undefined;
}

function parseIntOr(raw: string | undefined, fallback: number | undefined): number | undefined {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 1000) : fallback;
}
