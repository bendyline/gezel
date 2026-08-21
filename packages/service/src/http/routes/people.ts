/**
 * People (face lane, biometric opt-in) — the minimal person-cluster surface:
 *
 *   GET    /api/projects/:id/people              clusters + counts + samples
 *   POST   /api/projects/:id/people/:entityId/rename   "Who is this?"
 *   DELETE /api/projects/:id/people/:entityId    forget (tombstone, not erase)
 *   POST   /api/people/wipe                      disable & erase everywhere
 *
 * Wipe is the data-erasure path: it clears face vectors, clusters, gates,
 * and person entities across every project index, then flips the
 * `faceRecognition.enabled` opt-in back off.
 */

import { RenamePersonRequestSchema } from '@bendyline/gezel';
import { Hono } from 'hono';
import type { ServiceContext } from '../context.js';

export function projectPeopleRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  app.get('/:id/people', async (c) => {
    const id = c.req.param('id');
    if (!(await ctx.store.getProject(id))) return c.json({ error: 'project not found' }, 404);
    return c.json(await ctx.contentIndex.listPeople(id));
  });

  app.post('/:id/people/:entityId/rename', async (c) => {
    const id = c.req.param('id');
    if (!(await ctx.store.getProject(id))) return c.json({ error: 'project not found' }, 404);
    const entityId = Number.parseInt(c.req.param('entityId'), 10);
    if (!Number.isFinite(entityId)) return c.json({ error: 'invalid entity id' }, 400);
    const body = RenamePersonRequestSchema.parse(await c.req.json());
    const ok = await ctx.contentIndex.renamePerson(id, entityId, body.label);
    if (!ok) return c.json({ error: 'person not found' }, 404);
    return c.json({ ok: true });
  });

  app.delete('/:id/people/:entityId', async (c) => {
    const id = c.req.param('id');
    if (!(await ctx.store.getProject(id))) return c.json({ error: 'project not found' }, 404);
    const entityId = Number.parseInt(c.req.param('entityId'), 10);
    if (!Number.isFinite(entityId)) return c.json({ error: 'invalid entity id' }, 400);
    const ok = await ctx.contentIndex.forgetPerson(id, entityId);
    if (!ok) return c.json({ error: 'person not found' }, 404);
    return c.json({ ok: true });
  });

  return app;
}

export function peopleWipeRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  app.post('/wipe', async (c) => {
    const projects = await ctx.store.listProjects().catch(() => []);
    const wiped = await ctx.contentIndex.wipeAllFaceData(projects.map((p) => p.id));
    const config = await ctx.store.readConfig().catch(() => null);
    let disabled = false;
    if (config?.faceRecognition?.enabled) {
      // writeConfig merges patches into the stored config.
      await ctx.store.writeConfig({ faceRecognition: { enabled: false } });
      disabled = true;
    }
    return c.json({ projects: wiped, disabled });
  });

  return app;
}
