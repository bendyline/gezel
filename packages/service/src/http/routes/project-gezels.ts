import { type GezelSummary, PROJECT_GEZEL_LOCAL_ID, encodeProjectGezelId } from '@bendyline/gezel';
import { Hono } from 'hono';
import { z } from 'zod';
import { WorkspaceWriteDeniedError } from '../../workspace/errors.js';
import {
  approvePendingImport,
  importDiscoveredSkill,
  rejectPendingImport,
} from '../../workspace/import-sync.js';
import { findDiscoveredSkill, invokeWorkspaceSkill } from '../../workspace/skill-invocation.js';
import type { ServiceContext } from '../context.js';

/**
 * HTTP surface for project-local gezels + the import review queue.
 *
 *   GET    /api/projects/:id/local-gezels                 list project-local gezels (incl. @project)
 *   GET    /api/projects/:id/local-gezels/:localId        resolve one (use `project` for @project)
 *   POST   /api/projects/:id/local-gezels                 create a project-local gezel
 *   PATCH  /api/projects/:id/local-gezels/:localId/about  edit a (non-canonical) gezel's about.md
 *   DELETE /api/projects/:id/local-gezels/:localId        delete a project-local gezel
 *   POST   /api/projects/:id/local-gezels/copy            copy a global gezel in (local | agents-md)
 *
 * NB: `local-gezels` (not `gezels`) so it doesn't collide with the
 * project-roster routes in projects.ts (`/:id/gezels` = the gezelIds
 * roster of global gezels pulled into the project).
 *
 *   GET    /api/projects/:id/imports/pending        list pending skill-import proposals
 *   POST   /api/projects/:id/imports/approve        approve one (writes craftbook + scripts + persona)
 *   POST   /api/projects/:id/imports/reject         reject one (prose-only craftbook)
 *   POST   /api/projects/:id/imports/convert        convert one discovered skill on demand
 *   POST   /api/projects/:id/skills/invoke          run one discovered skill (triage → run → verify)
 *
 * Mounted under `/api/projects` alongside the other project sub-routers.
 */

const CreateProjectGezelSchema = z.object({
  name: z.string().min(1),
  localId: z.string().optional(),
  description: z.string().optional(),
  role: z.string().optional(),
  model: z.string().optional(),
});

const CopyGezelSchema = z.object({
  gezelId: z.string().min(1),
  mode: z.enum(['local', 'agents-md']),
});

const ImportActionSchema = z.object({ skillSource: z.string().min(1) });
const ConvertImportSchema = z.object({
  skillSource: z.string().min(1),
  /** The manual lane may use the LLM translator (default true); script results still queue. */
  allowLlm: z.boolean().optional(),
});

export function projectGezelRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  app.get('/:projectId/local-gezels', async (c) => {
    const projectId = c.req.param('projectId');
    const gezels: GezelSummary[] = await ctx.store.listProjectGezels(projectId);
    return c.json({ gezels });
  });

  app.get('/:projectId/local-gezels/:localId', async (c) => {
    const projectId = c.req.param('projectId');
    const localId = c.req.param('localId');
    const detail = await ctx.store.getGezel(encodeProjectGezelId(projectId, localId));
    if (!detail) return c.json({ error: 'not found' }, 404);
    return c.json(detail);
  });

  app.post('/:projectId/local-gezels', async (c) => {
    const projectId = c.req.param('projectId');
    const body = CreateProjectGezelSchema.parse(await c.req.json());
    try {
      const created = await ctx.store.createProjectGezel(projectId, body);
      return c.json(created, 201);
    } catch (err) {
      return writeError(c, err);
    }
  });

  app.patch('/:projectId/local-gezels/:localId/about', async (c) => {
    const projectId = c.req.param('projectId');
    const localId = c.req.param('localId');
    const { about } = z.object({ about: z.string() }).parse(await c.req.json());
    try {
      const detail = await ctx.store.updateProjectGezelAbout(projectId, localId, about);
      return c.json(detail);
    } catch (err) {
      return writeError(c, err);
    }
  });

  app.delete('/:projectId/local-gezels/:localId', async (c) => {
    const projectId = c.req.param('projectId');
    const localId = c.req.param('localId');
    if (localId === PROJECT_GEZEL_LOCAL_ID) {
      return c.json(
        {
          error:
            'the @project gezel is derived from the workspace instruction file; delete that file instead',
        },
        409,
      );
    }
    try {
      await ctx.store.deleteProjectGezel(projectId, localId);
      return c.json({ ok: true });
    } catch (err) {
      return writeError(c, err);
    }
  });

  app.post('/:projectId/local-gezels/copy', async (c) => {
    const projectId = c.req.param('projectId');
    const body = CopyGezelSchema.parse(await c.req.json());
    const source = await ctx.store.getGezel(body.gezelId);
    if (!source) return c.json({ error: 'source gezel not found' }, 404);
    try {
      if (body.mode === 'agents-md') {
        // The global gezel's prompt becomes the @project prompt: write its
        // about into the workspace AGENTS.md (the canonical source of truth).
        await ctx.store.writeProjectWorkspaceFile(projectId, 'AGENTS.md', source.about);
        await ctx.store.writeProjectLocalConfig(projectId, {
          schemaVersion: 1,
          sourceFile: 'AGENTS.md',
        });
        return c.json({ ok: true, mode: 'agents-md' });
      }
      const created = await ctx.store.createProjectGezel(projectId, {
        name: source.name,
        ...(source.role ? { role: source.role } : {}),
        ...(source.model ? { model: source.model } : {}),
        about: source.about,
      });
      return c.json(created, 201);
    } catch (err) {
      return writeError(c, err);
    }
  });

  app.get('/:projectId/imports/pending', async (c) => {
    const projectId = c.req.param('projectId');
    const pending = await ctx.store.readPendingImports(projectId);
    return c.json(pending);
  });

  app.post('/:projectId/imports/approve', async (c) => {
    const projectId = c.req.param('projectId');
    const { skillSource } = ImportActionSchema.parse(await c.req.json());
    const deps = { store: ctx.store, chat: ctx.chat, home: ctx.home, catalog: ctx.catalog };
    const craftbookId = await approvePendingImport(deps, projectId, skillSource);
    if (!craftbookId) return c.json({ error: 'no pending import for that source' }, 404);
    return c.json({ ok: true, craftbookId });
  });

  app.post('/:projectId/imports/reject', async (c) => {
    const projectId = c.req.param('projectId');
    const { skillSource } = ImportActionSchema.parse(await c.req.json());
    const deps = { store: ctx.store, chat: ctx.chat, home: ctx.home, catalog: ctx.catalog };
    const craftbookId = await rejectPendingImport(deps, projectId, skillSource);
    if (!craftbookId) return c.json({ error: 'no pending import for that source' }, 404);
    return c.json({ ok: true, craftbookId });
  });

  app.post('/:projectId/imports/convert', async (c) => {
    const projectId = c.req.param('projectId');
    const body = ConvertImportSchema.parse(await c.req.json());
    const deps = { store: ctx.store, chat: ctx.chat, home: ctx.home, catalog: ctx.catalog };
    try {
      const result = await importDiscoveredSkill(deps, projectId, body.skillSource, {
        allowLlm: body.allowLlm ?? true,
      });
      if (result.status === 'not-found') {
        return c.json({ error: 'no discovered skill at that source' }, 404);
      }
      return c.json(result);
    } catch (err) {
      return writeError(c, err);
    }
  });

  // Running a skill is a crew decision, not a file read: the voorman
  // triages it, names the craftsman, and verifies the result. The task is
  // dispatched here (not left "active" for someone to notice) — see
  // workspace/skill-invocation.ts for why that kickoff is the whole point.
  app.post('/:projectId/skills/invoke', async (c) => {
    const projectId = c.req.param('projectId');
    const { skillSource } = ImportActionSchema.parse(await c.req.json());
    const { skills } = await ctx.workspaceIndex.readSkills(projectId);
    const skill = findDiscoveredSkill(skills, skillSource);
    if (!skill) return c.json({ error: 'no discovered skill at that source' }, 404);
    const { task, dispatch } = await invokeWorkspaceSkill(
      {
        store: ctx.store,
        tasks: ctx.tasks,
        taskRunner: ctx.taskRunner,
        history: ctx.history,
      },
      projectId,
      skill,
    );
    return c.json(
      {
        task,
        started: dispatch.enqueued,
        ...(dispatch.assigneeName ? { assigneeName: dispatch.assigneeName } : {}),
        ...(dispatch.reason ? { reason: dispatch.reason } : {}),
      },
      201,
    );
  });

  return app;
}

// biome-ignore lint/suspicious/noExplicitAny: hono context type isn't exported cleanly here
function writeError(c: any, err: unknown) {
  // External workingDir writes need managed-write consent — surface as 403.
  if (err instanceof WorkspaceWriteDeniedError) {
    return c.json({ error: err.message, workingDir: err.workingDir }, 403);
  }
  return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
}
