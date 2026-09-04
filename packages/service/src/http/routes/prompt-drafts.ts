import {
  CreatePromptDraftRequestSchema,
  type DeletePromptDraftResponse,
  DuplicatePromptDraftRequestSchema,
  type ListPromptDraftsResponse,
  PatchPromptDraftRequestSchema,
  type PromptDraft,
  PromptDraftIdSchema,
  type PromptDraftStatus,
  type PromptDraftSummary,
  WritePromptDraftContentRequestSchema,
  type WritePromptDraftContentResponse,
} from '@bendyline/gezel';
import { Hono } from 'hono';
import {
  PromptDraftInvalidIdError,
  type PromptDraftListFilter,
  PromptDraftNotFoundError,
} from '../../prompt-drafts/manager.js';
import type { ServiceContext } from '../context.js';

/**
 * Prompt drafts — the messages a user is still writing.
 *
 *   GET    /api/projects/:id/prompt-drafts        ?gezelId=&sessionId=<id>|new&status=
 *   POST   /api/projects/:id/prompt-drafts
 *   GET    /api/projects/:id/prompt-drafts/:draftId
 *   PUT    /api/projects/:id/prompt-drafts/:draftId/content   { content }
 *   PATCH  /api/projects/:id/prompt-drafts/:draftId           re-file
 *   POST   /api/projects/:id/prompt-drafts/:draftId/duplicate "Use again"
 *   DELETE /api/projects/:id/prompt-drafts/:draftId
 *
 * The draft's own uploads are NOT served here: they live at
 * `prompts/<id>/message_files/` and go through the ordinary artifact
 * read/raw/list/delete routes, which is what lets the squisq editor treat a
 * draft as the same kind of document folder it already knows how to edit.
 *
 * `?sessionId=new` is the wire spelling of "not addressed to a thread yet".
 * It has to be a distinct value rather than an omitted one, because omitting
 * the filter means "any thread" and those are different questions.
 */
export function promptDraftRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  const parseDraftId = (raw: string): string | null => {
    const parsed = PromptDraftIdSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  };

  app.get('/:id/prompt-drafts', async (c) => {
    const projectId = c.req.param('id');
    const filter: PromptDraftListFilter = {};
    const gezelId = c.req.query('gezelId');
    if (gezelId) filter.gezelId = gezelId;
    const sessionId = c.req.query('sessionId');
    if (sessionId === 'new') filter.sessionId = null;
    else if (sessionId) filter.sessionId = sessionId;
    const status = c.req.query('status');
    if (status === 'draft' || status === 'sent') filter.status = status as PromptDraftStatus;
    const out: ListPromptDraftsResponse = {
      drafts: await ctx.promptDrafts.list(projectId, filter),
    };
    return c.json(out);
  });

  app.post('/:id/prompt-drafts', async (c) => {
    const projectId = c.req.param('id');
    const project = await ctx.store.getProject(projectId).catch(() => null);
    if (!project) return c.json({ error: 'project not found' }, 404);
    const body = CreatePromptDraftRequestSchema.parse(await c.req.json());
    const draft: PromptDraft = await ctx.promptDrafts.create(projectId, body);
    return c.json(draft, 201);
  });

  app.get('/:id/prompt-drafts/:draftId', async (c) => {
    const draftId = parseDraftId(c.req.param('draftId'));
    if (!draftId) return c.json({ error: 'not a prompt draft id' }, 400);
    const draft = await ctx.promptDrafts.get(c.req.param('id'), draftId);
    if (!draft) return c.json({ error: 'prompt draft not found' }, 404);
    return c.json(draft);
  });

  app.put('/:id/prompt-drafts/:draftId/content', async (c) => {
    const draftId = parseDraftId(c.req.param('draftId'));
    if (!draftId) return c.json({ error: 'not a prompt draft id' }, 400);
    const body = WritePromptDraftContentRequestSchema.parse(await c.req.json());
    try {
      const result = await ctx.promptDrafts.writeContent(c.req.param('id'), draftId, body.content);
      const out: WritePromptDraftContentResponse = result;
      return c.json(out);
    } catch (err) {
      if (err instanceof PromptDraftNotFoundError) {
        return c.json({ error: err.message, code: err.code }, 404);
      }
      throw err;
    }
  });

  app.patch('/:id/prompt-drafts/:draftId', async (c) => {
    const draftId = parseDraftId(c.req.param('draftId'));
    if (!draftId) return c.json({ error: 'not a prompt draft id' }, 400);
    const body = PatchPromptDraftRequestSchema.parse(await c.req.json());
    try {
      const out: PromptDraftSummary = await ctx.promptDrafts.patchMeta(
        c.req.param('id'),
        draftId,
        body,
      );
      return c.json(out);
    } catch (err) {
      if (err instanceof PromptDraftNotFoundError) {
        return c.json({ error: err.message, code: err.code }, 404);
      }
      throw err;
    }
  });

  app.post('/:id/prompt-drafts/:draftId/duplicate', async (c) => {
    const draftId = parseDraftId(c.req.param('draftId'));
    if (!draftId) return c.json({ error: 'not a prompt draft id' }, 400);
    // "Use again" on a draft with no body is still a valid request — an
    // empty POST body is the common case from the menu.
    const raw = await c.req.json().catch(() => ({}));
    const body = DuplicatePromptDraftRequestSchema.parse(raw ?? {});
    try {
      const draft = await ctx.promptDrafts.duplicate(c.req.param('id'), draftId, body);
      return c.json(draft, 201);
    } catch (err) {
      if (err instanceof PromptDraftNotFoundError) {
        return c.json({ error: err.message, code: err.code }, 404);
      }
      throw err;
    }
  });

  // Idempotent: deleting a draft that is already gone is a success, because
  // the caller's intent ("this should not exist") is satisfied.
  app.delete('/:id/prompt-drafts/:draftId', async (c) => {
    const draftId = parseDraftId(c.req.param('draftId'));
    if (!draftId) return c.json({ error: 'not a prompt draft id' }, 400);
    try {
      const deleted = await ctx.promptDrafts.delete(c.req.param('id'), draftId);
      const out: DeletePromptDraftResponse = { ok: true, deleted };
      return c.json(out);
    } catch (err) {
      if (err instanceof PromptDraftInvalidIdError) {
        return c.json({ error: err.message, code: err.code }, 400);
      }
      throw err;
    }
  });

  return app;
}
