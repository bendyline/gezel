import { MemorySearchRequestSchema, parseHarnessAppId } from '@bendyline/gezel';
import { type Context, Hono } from 'hono';
import {
  type MemoryScope,
  type MemorySource,
  USER_MEMORY_ID,
  isMemoryKind,
  isMemoryScope,
  parseMemoryDay,
  withoutKeptMemories,
} from '../../memory/daily-markdown.js';
import type { ServiceContext } from '../context.js';
import { callerKeptTag, callerRunsHere, markKeptLocalTags } from '../kept-local-gate.js';

const MEMORY_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MEMORY_ID_PATTERN = /^(?!\.{1,2}$)[^/\\]+$/;

/** The scope a request names, defaulting to the gezel's own as it always has. */
function requestScope(value: string | undefined): MemoryScope {
  return isMemoryScope(value) ? value : 'gezel';
}

/** The person's memories have one owner; any other scope is named by its id. */
function scopeId(scope: MemoryScope, id: string): string {
  return scope === 'user' ? USER_MEMORY_ID : id;
}

function requestSource(value: unknown): MemorySource | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { project, gezel } = value as Record<string, unknown>;
  const source: MemorySource = {
    ...(typeof project === 'string' && project ? { project } : {}),
    ...(typeof gezel === 'string' && gezel ? { gezel } : {}),
  };
  return source.project || source.gezel ? source : undefined;
}

export function memoryRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  /** A day file as this caller may read it: no kept-local entries for a model elsewhere. */
  const forCaller = async (c: Context, content: string): Promise<string> => {
    if (!(await callerRunsHere(ctx, c))) return withoutKeptMemories(content);
    await markKeptLocalTags(
      ctx,
      c,
      parseMemoryDay(content).flatMap((b) => (b.source?.kept ? [b.source.kept] : [])),
    );
    return content;
  };

  app.post('/search', async (c) => {
    const body = MemorySearchRequestSchema.parse(await c.req.json());
    const outcome = await ctx.memory.searchAllDetailed(
      body.gezelId,
      body.projectId,
      body.query,
      body.topK ?? 10,
    );
    if (!(await callerRunsHere(ctx, c))) {
      return c.json({ ...outcome, results: outcome.results.filter((r) => !r.source?.kept) });
    }
    await markKeptLocalTags(
      ctx,
      c,
      outcome.results.flatMap((r) => (r.source?.kept ? [r.source.kept] : [])),
    );
    return c.json(outcome);
  });

  app.post('/save', async (c) => {
    const body = (await c.req.json()) as {
      scope?: string;
      id: string;
      text: string;
      kind?: string;
      source?: unknown;
    };
    if (!isMemoryScope(body.scope)) return c.json({ error: 'invalid scope' }, 400);
    const kind = isMemoryKind(body.kind) ? body.kind : 'fact';
    // An outside AI app's save is stamped with the app by the daemon, never by
    // the request: project memory reaches every gezel's prompt in that project,
    // so where it came from has to be legible.
    const harnessApp = parseHarnessAppId(c.get('auth')?.appId ?? '');
    const requested = harnessApp ? { app: harnessApp.client } : requestSource(body.source);
    // A conversation that read kept-local data says so on what it remembers.
    const kept = await callerKeptTag(ctx, c);
    const source = kept ? { ...requested, kept } : requested;
    const outcome = await ctx.memory.save(
      body.scope,
      scopeId(body.scope, body.id),
      body.text,
      kind,
      source,
    );
    return c.json({ ok: true, ...outcome });
  });

  app.get('/recent', async (c) => {
    const scope = requestScope(c.req.query('scope'));
    const id = scopeId(scope, c.req.query('id') ?? '');
    const days = Number.parseInt(c.req.query('days') ?? '7', 10);
    return c.json({ content: await forCaller(c, await ctx.memory.getRecent(scope, id, days)) });
  });

  app.get('/days', async (c) => {
    const scope = requestScope(c.req.query('scope'));
    const id = scopeId(scope, c.req.query('id') ?? '');
    const days = await ctx.memory.listDays(scope, id);
    return c.json({ days });
  });

  app.get('/day', async (c) => {
    const scope = requestScope(c.req.query('scope'));
    const id = scopeId(scope, c.req.query('id') ?? '');
    const day = c.req.query('day') ?? '';
    if (!day) return c.json({ error: 'missing ?day=YYYY-MM-DD' }, 400);
    return c.json({ content: await forCaller(c, await ctx.memory.readDay(scope, id, day)) });
  });

  app.patch('/day', async (c) => {
    const scope = c.req.query('scope');
    const day = c.req.query('day') ?? '';
    if (!isMemoryScope(scope)) {
      return c.json({ error: 'missing or invalid ?scope=' }, 400);
    }
    const id = scopeId(scope, c.req.query('id') ?? '');
    if (!MEMORY_ID_PATTERN.test(id)) return c.json({ error: 'missing or invalid ?id=' }, 400);
    if (!MEMORY_DAY_PATTERN.test(day)) {
      return c.json({ error: 'missing or invalid ?day=YYYY-MM-DD' }, 400);
    }
    const target =
      scope === 'user'
        ? true
        : scope === 'project'
          ? await ctx.store.getProject(id)
          : await ctx.store.getGezel(id);
    if (!target) return c.json({ error: `${scope} not found` }, 404);
    const body = (await c.req.json().catch(() => null)) as { content?: unknown } | null;
    if (typeof body?.content !== 'string') {
      return c.json({ error: 'content must be a string' }, 400);
    }
    const { indexed } = await ctx.memory.replaceDay(scope, id, day, body.content);
    return c.json({ ok: true, indexed });
  });

  app.get('/summary', async (c) => {
    const scope = requestScope(c.req.query('scope'));
    const id = scopeId(scope, c.req.query('id') ?? '');
    const content = await ctx.memory.readSummary(scope, id);
    return c.json({ content });
  });

  app.get('/lessons', async (c) => {
    const gezelId = c.req.query('gezelId') ?? '';
    if (!gezelId) return c.json({ error: 'missing ?gezelId=' }, 400);
    const content = await ctx.store.readMemoryLessons(gezelId);
    return c.json({ content });
  });

  // The person's own edit. Lines under a `## Pinned` heading survive every
  // later distillation word for word; the rest is refreshed from new notes.
  app.put('/lessons', async (c) => {
    const gezelId = c.req.query('gezelId') ?? '';
    if (!MEMORY_ID_PATTERN.test(gezelId)) return c.json({ error: 'missing ?gezelId=' }, 400);
    if (!(await ctx.store.getGezel(gezelId))) return c.json({ error: 'gezel not found' }, 404);
    const body = (await c.req.json().catch(() => null)) as { content?: unknown } | null;
    if (typeof body?.content !== 'string') {
      return c.json({ error: 'content must be a string' }, 400);
    }
    await ctx.store.writeMemoryLessons(gezelId, body.content);
    return c.json({ ok: true });
  });

  return app;
}
