import {
  CreateScriptRequestSchema,
  DraftScriptRequestSchema,
  RunScriptRequestSchema,
  SaveScriptSourceRequestSchema,
  type SaveScriptSourceResponse,
  type ScriptMeta,
  ScriptNameSchema,
} from '@bendyline/gezel';
import { projectScriptFile } from '@bendyline/gezel/paths';
import { Hono } from 'hono';
import { listProjectScripts, readProjectScriptRun } from '../../scripts/catalog.js';
import { draftScript } from '../../scripts/draft.js';
import { parseScriptMeta } from '../../scripts/meta.js';
import {
  computeScriptDiagnostics,
  deleteScriptSource,
  readScriptSource,
  scaffoldScript,
  scriptSourceExists,
  writeScriptSource,
} from '../../scripts/source.js';
import type { ServiceContext } from '../context.js';

/**
 * Scripts API.
 *
 *   GET    /api/projects/:id/scripts                — list scripts + meta
 *   POST   /api/projects/:id/scripts                — create from template/source
 *   GET    /api/projects/:id/scripts/source?name=X  — raw source for the editor
 *   PUT    /api/projects/:id/scripts/source         — save source (+ diagnostics)
 *   DELETE /api/projects/:id/scripts/source?name=X  — delete a script
 *   POST   /api/projects/:id/scripts/run            — run a script, return a ScriptRun
 *   GET    /api/projects/:id/script-runs/:id        — fetch a persisted ScriptRun
 *
 * Nested under `/api/projects` to match the existing `project-tasks`
 * pattern. Source endpoints use a fixed `/source` segment + `?name=` so
 * script names can never collide with route segments like `run`.
 */
export function scriptRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  app.get('/:projectId/scripts', async (c) => {
    const projectId = c.req.param('projectId');
    const scripts = await listProjectScripts(ctx.home, projectId);
    return c.json({
      scripts: scripts.map((s) => ({ name: s.name, meta: s.meta, path: s.path })),
    });
  });

  app.get('/:projectId/scripts/source', async (c) => {
    const projectId = c.req.param('projectId');
    const name = ScriptNameSchema.parse(c.req.query('name'));
    const result = await readScriptSource(ctx.home, projectId, name);
    if (!result) return c.json({ error: 'not found' }, 404);
    return c.json(result);
  });

  app.put('/:projectId/scripts/source', async (c) => {
    const projectId = c.req.param('projectId');
    const body = SaveScriptSourceRequestSchema.parse(await c.req.json());
    if (body.baseHash) {
      const current = await readScriptSource(ctx.home, projectId, body.name);
      if (current && current.hash !== body.baseHash) {
        const conflict: SaveScriptSourceResponse = {
          status: 'conflict',
          currentHash: current.hash,
          currentSource: current.source,
        };
        return c.json(conflict);
      }
    }
    const { hash } = await writeScriptSource(ctx.home, projectId, body.name, body.source);
    const file = projectScriptFile(ctx.home, projectId, body.name);
    const diagnostics = computeScriptDiagnostics(body.source, file, body.name);
    let meta: ScriptMeta | undefined;
    try {
      meta = parseScriptMeta(body.source, file);
    } catch {
      /* already surfaced as a meta diagnostic */
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

  app.delete('/:projectId/scripts/source', async (c) => {
    const projectId = c.req.param('projectId');
    const name = ScriptNameSchema.parse(c.req.query('name'));
    const deleted = await deleteScriptSource(ctx.home, projectId, name);
    if (!deleted) return c.json({ error: 'not found' }, 404);
    return c.json({ ok: true });
  });

  app.post('/:projectId/scripts', async (c) => {
    const projectId = c.req.param('projectId');
    const body = CreateScriptRequestSchema.parse(await c.req.json());
    if (await scriptSourceExists(ctx.home, projectId, body.name)) {
      return c.json({ error: 'exists' }, 409);
    }
    const source = body.source ?? scaffoldScript(body.name, body.description, body.template);
    const { hash } = await writeScriptSource(ctx.home, projectId, body.name, source);
    return c.json({ name: body.name, source, hash });
  });

  app.post('/:projectId/scripts/draft', async (c) => {
    const body = DraftScriptRequestSchema.parse(await c.req.json());
    const source = await draftScript(ctx.chat, body);
    return c.json({ source });
  });

  app.post('/:projectId/scripts/run', async (c) => {
    const projectId = c.req.param('projectId');
    const body = RunScriptRequestSchema.parse(await c.req.json());
    let run: Awaited<ReturnType<typeof ctx.scriptRunner.run>>;
    try {
      run = await ctx.scriptRunner.run({
        projectId,
        scriptName: body.name,
        ...(body.scope ? { scope: body.scope } : {}),
        ...(body.input ? { inputs: body.input } : {}),
        trigger: { kind: 'manual', userInitiated: true },
      });
    } catch (err) {
      // Unknown script name → an actionable 404 naming what IS runnable,
      // never a sanitized 500. Models guess plausible names ("the probe
      // script" → run_script({name:"probe-automation"})) and the name
      // list is the self-correction they need on the next attempt.
      // Wild-caught (craftbook-webhook-handler live-mock trial: three
      // 500s on the same wrong guess, zero recovery signal).
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        const scripts = await listProjectScripts(ctx.home, projectId);
        const available = scripts.map((s) => s.name).join(', ') || '(none)';
        return c.json(
          { error: `script "${body.name}" not found. Available scripts: ${available}` },
          404,
        );
      }
      // A script whose meta doesn't parse is a caller-visible authoring
      // error, not a server failure — surface the parse message (it names
      // the offending construct) instead of a sanitized 500. Wild-caught
      // (craftbook-week-plan trial: an unescaped apostrophe in a shim
      // description produced four opaque 500s).
      if (err instanceof Error && err.name === 'ScriptMetaError') {
        return c.json({ error: `script "${body.name}" has invalid meta: ${err.message}` }, 422);
      }
      throw err;
    }
    // Always 200: a completed run whose SCRIPT failed is a run report, not
    // a server failure. Returning 500 here routes the body through the
    // opaque-5xx sanitizer, which destroys the script's error text — the
    // exact detail models need to self-correct ("Illegal move… Legal
    // moves: …") and the editor needs to render a failed run. Genuine
    // infra failures still throw and surface as sanitized 500s.
    return c.json({
      runId: run.id,
      status: run.status,
      output: run.output,
      callsSummary: run.calls.map((call) => ({
        kind: call.kind,
        durationMs: call.durationMs,
        ...(call.error ? { error: call.error } : {}),
      })),
      ...(run.error ? { error: run.error } : {}),
    });
  });

  app.get('/:projectId/script-runs/:runId', async (c) => {
    const projectId = c.req.param('projectId');
    const runId = c.req.param('runId');
    const run = await readProjectScriptRun(ctx.home, projectId, runId);
    if (!run) return c.json({ error: 'not found' }, 404);
    return c.json(run);
  });

  return app;
}
