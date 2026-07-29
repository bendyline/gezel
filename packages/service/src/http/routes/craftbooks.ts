import {
  type Craftbook,
  type CraftbookDocError,
  type CraftbookDocFormat,
  type CraftbookSummary,
  CreateCraftbookRequestSchema,
  CreateScriptRequestSchema,
  SaveScriptSourceRequestSchema,
  type SaveScriptSourceResponse,
  type ScriptMeta,
  ScriptNameSchema,
  UpdateCraftbookRequestSchema,
  craftbookDocFormatFromEnv,
  craftbookFromDoc,
  createLogger,
  docFromCraftbook,
  expandStepDeliverables,
  formatCraftbookDocErrors,
  nowIso,
  parseCraftbookDoc,
  serializeCraftbookDoc,
  slugifyStepId,
  validateCraftbookScriptRefs,
} from '@bendyline/gezel';
import { Hono } from 'hono';
import { z } from 'zod';
import { suggestCraftbooks } from '../../craftbook/suggest.js';
import {
  deleteCraftbookScriptSource,
  listCraftbookScripts,
  readCraftbookScriptSource,
  writeCraftbookScriptSource,
} from '../../scripts/craftbook-source.js';
import { readBundledCraftbookScripts } from '../../scripts/install.js';
import { parseScriptMeta } from '../../scripts/meta.js';
import {
  computeScriptDiagnostics,
  craftbookScriptErrors,
  scaffoldScript,
} from '../../scripts/source.js';
import type { ServiceContext } from '../context.js';

/**
 * HTTP surface for craftbook templates.
 *
 *   GET    /api/craftbooks                  list bundled + local catalog summaries
 *   GET    /api/craftbooks/:id              resolve a single craftbook (?version=, ?source=)
 *   POST   /api/craftbooks                  create a local-source craftbook
 *   PATCH  /api/craftbooks/:id              update a local-source craftbook (refuses bundled)
 *   DELETE /api/craftbooks/:id              delete a local-source craftbook (refuses if referenced by a task)
 *
 * Local-source craftbooks live under `~/.gezel/craftbook-templates/` and
 * are served alongside the bundled catalog seeds via CatalogService.
 */

const SourceFilterSchema = z.enum(['bundled', 'local', 'project', 'all']);

const log = createLogger('craftbooks');

const DocFormatSchema = z.enum(['json', 'md', 'markdown']).optional();

function requestedDocFormat(raw: string | undefined): CraftbookDocFormat {
  const parsed = DocFormatSchema.safeParse(raw || undefined);
  if (parsed.success && parsed.data) {
    return parsed.data === 'json' ? 'json' : 'markdown';
  }
  return craftbookDocFormatFromEnv(process.env.GEZEL_CRAFTBOOK_DOC_FORMAT);
}

/**
 * One stable, greppable marker line per refused document write — the
 * format A/B eval's malformed-retry counter scans daemon logs for it.
 */
function logDocRejection(format: CraftbookDocFormat, errors: CraftbookDocError[]): void {
  log.info(
    `[craftbook-doc] validation rejected format=${format === 'markdown' ? 'md' : 'json'} problems=${errors.length}: ${errors[0]?.message ?? ''}`,
  );
}

export function craftbookRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  /** GET /:id resolution shared with the document route: project → local → bundled. */
  async function resolveOne(
    id: string,
    opts: { version?: string; sourceParam?: string; projectId?: string },
  ): Promise<Craftbook | { error: string; status: 400 | 404 } | null> {
    const { version, sourceParam, projectId } = opts;
    if (sourceParam === 'project') {
      if (!projectId) return { error: 'projectId required for project source', status: 400 };
      return ctx.store.getProjectCraftbook(projectId, id, version);
    }
    if (sourceParam === 'local') {
      return ctx.store.getLocalCraftbookTemplate(id, version);
    }
    if (projectId) {
      const project = await ctx.store.getProjectCraftbook(projectId, id, version).catch(() => null);
      if (project) return project;
    }
    const local = await ctx.store.getLocalCraftbookTemplate(id, version).catch(() => null);
    if (local) return local;
    const detail = await ctx.catalog.get('craftbook-template', id, version).catch(() => null);
    if (!detail || detail.manifest.kind !== 'craftbook-template') return null;
    const m = detail.manifest;
    const scripts = await readBundledCraftbookScripts(ctx.catalog, m).catch(() => undefined);
    return {
      id: m.id,
      name: m.name,
      ...(detail.about
        ? { description: detail.about }
        : m.description
          ? { description: m.description }
          : {}),
      version: m.version,
      ...(m.basedOn ? { basedOn: m.basedOn } : {}),
      ...(m.plan ? { plan: m.plan } : {}),
      ...(m.defaultAssignee ? { defaultAssignee: m.defaultAssignee } : {}),
      steps: m.steps,
      entryStepId: m.entryStepId,
      ...(m.triggers ? { triggers: m.triggers } : {}),
      ...(m.hooks ? { hooks: m.hooks } : {}),
      ...(m.toolsets ? { toolsets: m.toolsets } : {}),
      ...(m.runModes ? { runModes: m.runModes } : {}),
      ...(scripts ? { scripts } : {}),
      createdAt: m.releasedAt,
      updatedAt: m.releasedAt,
    };
  }

  app.get('/', async (c) => {
    const source = SourceFilterSchema.safeParse(c.req.query('source')).success
      ? (c.req.query('source') as z.infer<typeof SourceFilterSchema>)
      : 'all';
    const projectId = c.req.query('projectId') || undefined;

    const out: CraftbookSummary[] = [];

    // Project-local craftbooks only surface when a project is named.
    if (projectId && (source === 'all' || source === 'project')) {
      const project = await ctx.store.listProjectCraftbooks(projectId);
      out.push(...project);
    }

    if (source === 'all' || source === 'local') {
      const local = await ctx.store.listLocalCraftbookTemplates();
      out.push(...local);
    }

    if (source === 'all' || source === 'bundled') {
      const bundled = await ctx.catalog.list('craftbook-template');
      for (const item of bundled) {
        if (item.manifest.kind !== 'craftbook-template') continue;
        const m = item.manifest;
        out.push({
          id: m.id,
          name: m.name,
          ...(m.description ? { description: m.description } : {}),
          version: m.version,
          ...(m.basedOn ? { basedOn: m.basedOn } : {}),
          source: 'bundled',
          stepCount: m.steps.length,
        });
      }
    }

    return c.json({ craftbooks: out });
  });

  // Ranked selection — the top-K shortlist behind `suggest_craftbook` and
  // the meester's shortlist-and-pin. POST (not GET) so the free-text query
  // rides in the body. Registered before `/:id` is irrelevant (distinct
  // method), but keep it above the param route for readability.
  app.post('/suggest', async (c) => {
    const SuggestRequestSchema = z.object({
      query: z.string().min(1),
      projectId: z.string().optional(),
      topK: z.number().int().positive().max(20).optional(),
    });
    const body = SuggestRequestSchema.parse(await c.req.json());
    const suggestions = await suggestCraftbooks(
      { catalog: ctx.catalog, store: ctx.store },
      {
        query: body.query,
        ...(body.projectId ? { projectId: body.projectId } : {}),
        ...(body.topK !== undefined ? { topK: body.topK } : {}),
      },
    );
    return c.json({ suggestions });
  });

  app.get('/:id', async (c) => {
    const id = c.req.param('id');
    const resolved = await resolveOne(id, {
      version: c.req.query('version') || undefined,
      sourceParam: c.req.query('source'),
      projectId: c.req.query('projectId') || undefined,
    });
    if (!resolved) return c.json({ error: 'not found' }, 404);
    if ('error' in resolved) return c.json({ error: resolved.error }, resolved.status);
    return c.json({ craftbook: resolved });
  });

  /* ── Whole-document read/write (the model-facing authoring surface) ── */

  app.get('/:id/document', async (c) => {
    const id = c.req.param('id');
    const format = requestedDocFormat(c.req.query('format'));
    const resolved = await resolveOne(id, {
      version: c.req.query('version') || undefined,
      sourceParam: c.req.query('source'),
      projectId: c.req.query('projectId') || undefined,
    });
    if (!resolved) return c.json({ error: 'not found' }, 404);
    if ('error' in resolved) return c.json({ error: resolved.error }, resolved.status);
    const content = serializeCraftbookDoc(docFromCraftbook(resolved), format);
    return c.json({ format, content });
  });

  const DocumentWriteSchema = z.object({
    content: z.string().min(1),
    format: DocFormatSchema,
    projectId: z.string().optional(),
  });

  /**
   * The one write pipeline both document routes share: parse (either
   * encoding) → expand deliverables → graph + script-ref validation →
   * TS diagnostics on inline scripts. Any problem → 422 with the
   * repair-grade error list and NO partial write.
   */
  function buildBookFromDocument(
    content: string,
    rawFormat: string | undefined,
    opts: { id?: string; createdAt?: string },
  ):
    | { ok: true; craftbook: Craftbook; format: CraftbookDocFormat }
    | { ok: false; format: CraftbookDocFormat; errors: CraftbookDocError[] } {
    const format = requestedDocFormat(rawFormat);
    const parsed = parseCraftbookDoc(content, format);
    if (!parsed.ok) return { ok: false, format, errors: parsed.errors };
    const built = craftbookFromDoc(parsed.doc, {
      now: nowIso(),
      ...(opts.id ? { id: opts.id } : {}),
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    });
    if (!built.ok) return { ok: false, format, errors: built.errors };
    if (built.craftbook.scripts) {
      const problems = craftbookScriptErrors(built.craftbook.scripts);
      if (problems.length > 0) {
        return {
          ok: false,
          format,
          errors: problems.map((message) => ({ where: 'scripts', message })),
        };
      }
    }
    return { ok: true, craftbook: built.craftbook, format };
  }

  function docRejectionPayload(format: CraftbookDocFormat, errors: CraftbookDocError[]) {
    logDocRejection(format, errors);
    return { errors, formatted: formatCraftbookDocErrors(errors) };
  }

  app.post('/document', async (c) => {
    const body = DocumentWriteSchema.parse(await c.req.json());
    const built = buildBookFromDocument(body.content, body.format, {});
    if (!built.ok) return c.json(docRejectionPayload(built.format, built.errors), 422);
    const book = { ...built.craftbook, version: built.craftbook.version ?? '1.0.0' };
    if (body.projectId) await ctx.store.writeProjectCraftbook(body.projectId, book);
    else await ctx.store.writeLocalCraftbookTemplate(book);
    await ctx.history?.log({
      kind: 'craftbook.created',
      summary: `Created craftbook "${book.name}" (${book.id}) from a document`,
      details: { id: book.id, name: book.name, stepCount: book.steps.length },
    });
    const gated = book.steps.filter((s) => s.gate || s.advanceWhen).length;
    return c.json(
      { craftbook: book, format: built.format, stepCount: book.steps.length, gatedSteps: gated },
      201,
    );
  });

  app.put('/:id/document', async (c) => {
    const id = c.req.param('id');
    const body = DocumentWriteSchema.parse(await c.req.json());
    const existing = body.projectId
      ? await ctx.store.getProjectCraftbook(body.projectId, id).catch(() => null)
      : await ctx.store.getLocalCraftbookTemplate(id).catch(() => null);
    if (!existing) {
      const bundled = await ctx.catalog.get('craftbook-template', id).catch(() => null);
      if (bundled) {
        return c.json(
          { error: 'cannot update bundled craftbook; write it as a new local craftbook first' },
          409,
        );
      }
    }
    const built = buildBookFromDocument(body.content, body.format, {
      id,
      ...(existing ? { createdAt: existing.createdAt } : {}),
    });
    if (!built.ok) return c.json(docRejectionPayload(built.format, built.errors), 422);
    const book = {
      ...built.craftbook,
      version: built.craftbook.version ?? existing?.version ?? '1.0.0',
    };
    if (body.projectId) await ctx.store.writeProjectCraftbook(body.projectId, book);
    else await ctx.store.writeLocalCraftbookTemplate(book);
    await ctx.history?.log({
      kind: existing ? 'craftbook.updated' : 'craftbook.created',
      summary: `${existing ? 'Updated' : 'Created'} craftbook "${book.name}" (${id}) from a document`,
      details: { id, name: book.name, stepCount: book.steps.length },
    });
    const gated = book.steps.filter((s) => s.gate || s.advanceWhen).length;
    return c.json({
      craftbook: book,
      format: built.format,
      stepCount: book.steps.length,
      gatedSteps: gated,
    });
  });

  app.post('/', async (c) => {
    const body = CreateCraftbookRequestSchema.parse(await c.req.json());
    const now = nowIso();
    const id = body.id ?? slugifyStepId(body.name);
    const steps = expandStepDeliverables(body.steps);
    const entryStepId =
      body.entryStepId && steps.some((s) => s.id === body.entryStepId)
        ? body.entryStepId
        : steps[0]!.id;

    if (body.scripts) {
      const problems = craftbookScriptErrors(body.scripts);
      if (problems.length > 0) {
        return c.json({ error: 'invalid craftbook scripts', problems }, 422);
      }
    }

    const book: Craftbook = {
      id,
      name: body.name,
      ...(body.description ? { description: body.description } : {}),
      version: '1.0.0',
      ...(body.basedOn ? { basedOn: body.basedOn } : {}),
      ...(body.plan ? { plan: body.plan } : {}),
      ...(body.defaultAssignee ? { defaultAssignee: body.defaultAssignee } : {}),
      ...(body.runModes ? { runModes: body.runModes } : {}),
      steps,
      entryStepId,
      ...(body.scripts ? { scripts: body.scripts } : {}),
      createdAt: now,
      updatedAt: now,
    };
    const refProblems = validateCraftbookScriptRefs(book);
    if (refProblems.length > 0) {
      return c.json({ error: 'invalid craftbook script refs', problems: refProblems }, 422);
    }

    await ctx.store.writeLocalCraftbookTemplate(book);

    await ctx.history?.log({
      kind: 'craftbook.created',
      summary: `Created craftbook "${book.name}" (${id})`,
      details: { id, name: book.name, stepCount: steps.length },
    });

    return c.json({ craftbook: book }, 201);
  });

  app.patch('/:id', async (c) => {
    const id = c.req.param('id');
    const body = UpdateCraftbookRequestSchema.parse(await c.req.json());

    const existing = await ctx.store.getLocalCraftbookTemplate(id);
    if (!existing) {
      // Refuse to update a bundled craftbook — direct user to fork.
      const bundled = await ctx.catalog.get('craftbook-template', id).catch(() => null);
      if (bundled) {
        return c.json(
          { error: 'cannot update bundled craftbook; copy it to a local craftbook first' },
          409,
        );
      }
      return c.json({ error: 'not found' }, 404);
    }

    const next: Craftbook = {
      ...existing,
      ...(body.name !== undefined ? { name: body.name } : {}),
      updatedAt: nowIso(),
    };
    if (body.description !== undefined) {
      if (body.description === null || body.description === '') {
        delete (next as { description?: string }).description;
      } else next.description = body.description;
    }
    if (body.basedOn !== undefined) {
      if (body.basedOn === null) {
        delete (next as { basedOn?: Craftbook['basedOn'] }).basedOn;
      } else next.basedOn = body.basedOn;
    }
    if (body.plan !== undefined) {
      if (body.plan === null || body.plan === '') {
        delete (next as { plan?: string }).plan;
      } else next.plan = body.plan;
    }
    if (body.defaultAssignee !== undefined) {
      if (body.defaultAssignee === null) {
        delete (next as { defaultAssignee?: Craftbook['defaultAssignee'] }).defaultAssignee;
      } else next.defaultAssignee = body.defaultAssignee;
    }
    if (body.runModes !== undefined) {
      if (body.runModes === null) {
        delete next.runModes;
      } else next.runModes = body.runModes;
    }
    if (body.steps !== undefined) {
      next.steps = expandStepDeliverables(body.steps);
    }
    if (body.entryStepId !== undefined) {
      if (next.steps.some((s) => s.id === body.entryStepId)) {
        next.entryStepId = body.entryStepId;
      }
    }
    if (body.scripts !== undefined) {
      if (body.scripts === null) {
        next.scripts = {}; // full-replace semantics: empty map clears the dir
      } else {
        const problems = craftbookScriptErrors(body.scripts);
        if (problems.length > 0) {
          return c.json({ error: 'invalid craftbook scripts', problems }, 422);
        }
        next.scripts = body.scripts;
      }
    }
    const refProblems = validateCraftbookScriptRefs(next);
    if (refProblems.length > 0) {
      return c.json({ error: 'invalid craftbook script refs', problems: refProblems }, 422);
    }

    await ctx.store.writeLocalCraftbookTemplate(next);

    await ctx.history?.log({
      kind: 'craftbook.updated',
      summary: `Updated craftbook "${next.name}" (${id})`,
      details: { id, name: next.name, stepCount: next.steps.length },
    });

    return c.json({ craftbook: next });
  });

  app.delete('/:id', async (c) => {
    const id = c.req.param('id');
    const existing = await ctx.store.getLocalCraftbookTemplate(id);
    if (!existing) return c.json({ error: 'not found' }, 404);

    // Block delete when any task references this craftbook id as its
    // main or spawn source. Prevents orphaning provenance after a delete.
    const allTasks = await ctx.tasks.list();
    const referencing = allTasks
      .filter((t) => t.sourceCraftbookIds?.some((s) => s.catalogId === id))
      .map((t) => t.ref);
    if (referencing.length > 0) {
      return c.json(
        {
          error: 'craftbook is referenced by existing tasks',
          referencingTasks: referencing,
        },
        409,
      );
    }

    await ctx.store.deleteLocalCraftbookTemplate(id);

    await ctx.history?.log({
      kind: 'craftbook.deleted',
      summary: `Deleted craftbook "${existing.name}" (${id})`,
      details: { id, name: existing.name },
    });

    return c.json({ ok: true });
  });

  /* ── Scripts bundled inside a (local) craftbook ───────────────────── */

  app.get('/:id/scripts', async (c) => {
    const id = c.req.param('id');
    const scripts = await listCraftbookScripts(ctx.home, id);
    return c.json({ scripts });
  });

  app.get('/:id/scripts/source', async (c) => {
    const id = c.req.param('id');
    const name = ScriptNameSchema.parse(c.req.query('name'));
    const result = await readCraftbookScriptSource(ctx.home, id, name);
    if (!result) return c.json({ error: 'not found' }, 404);
    return c.json(result);
  });

  app.put('/:id/scripts/source', async (c) => {
    const id = c.req.param('id');
    const body = SaveScriptSourceRequestSchema.parse(await c.req.json());
    if (body.baseHash) {
      const current = await readCraftbookScriptSource(ctx.home, id, body.name);
      if (current && current.hash !== body.baseHash) {
        const conflict: SaveScriptSourceResponse = {
          status: 'conflict',
          currentHash: current.hash,
          currentSource: current.source,
        };
        return c.json(conflict);
      }
    }
    const { hash } = await writeCraftbookScriptSource(ctx.home, id, body.name, body.source);
    const file = `${body.name}.ts`;
    const diagnostics = computeScriptDiagnostics(body.source, file, body.name);
    let meta: ScriptMeta | undefined;
    try {
      meta = parseScriptMeta(body.source, file);
    } catch {
      /* surfaced as a meta diagnostic */
    }
    const saved: SaveScriptSourceResponse = {
      status: 'saved',
      hash,
      metaOk: meta !== undefined,
      ...(meta ? { meta } : {}),
      diagnostics,
    };
    return c.json(saved);
  });

  app.delete('/:id/scripts/source', async (c) => {
    const id = c.req.param('id');
    const name = ScriptNameSchema.parse(c.req.query('name'));
    const deleted = await deleteCraftbookScriptSource(ctx.home, id, name);
    if (!deleted) return c.json({ error: 'not found' }, 404);
    return c.json({ ok: true });
  });

  app.post('/:id/scripts', async (c) => {
    const id = c.req.param('id');
    const body = CreateScriptRequestSchema.parse(await c.req.json());
    const existing = await readCraftbookScriptSource(ctx.home, id, body.name);
    if (existing) return c.json({ error: 'exists' }, 409);
    const source = body.source ?? scaffoldScript(body.name, body.description, body.template);
    const { hash } = await writeCraftbookScriptSource(ctx.home, id, body.name, source);
    return c.json({ name: body.name, source, hash });
  });

  return app;
}
