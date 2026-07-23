import {
  CreateScriptRequestSchema,
  SaveScriptSourceRequestSchema,
  type SaveScriptSourceResponse,
  type ScriptMeta,
  ScriptNameSchema,
} from '@bendyline/gezel';
import { userScriptFile } from '@bendyline/gezel/paths';
import { Hono } from 'hono';
import { parseScriptMeta } from '../../scripts/meta.js';
import {
  computeScriptDiagnostics,
  deleteUserScriptSource,
  listUserScripts,
  readUserScriptSource,
  scaffoldScript,
  writeUserScriptSource,
} from '../../scripts/source.js';
import { listStdlibScripts, readStdlibScriptSource } from '../../scripts/stdlib-source.js';
import type { ServiceContext } from '../context.js';

/**
 * Project-independent script scopes.
 *
 *   GET    /api/scripts/standard               — list the packed-in stdlib
 *   GET    /api/scripts/standard/source?name=X — stdlib source (READ-ONLY)
 *   GET    /api/scripts/user                   — list ~/.gezel/scripts
 *   GET    /api/scripts/user/source?name=X     — user-library source
 *   PUT    /api/scripts/user/source            — save user-library source
 *   DELETE /api/scripts/user/source?name=X     — delete from the user library
 *   POST   /api/scripts/user                   — create in the user library
 *
 * The standard scope has no write surface BY DESIGN: stdlib scripts are
 * trusted to run under restrictive security policy precisely because
 * nothing outside the app bundle can alter them.
 */
export function globalScriptRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  app.get('/standard', async (c) => {
    const scripts = await listStdlibScripts().catch(() => []);
    return c.json({
      scripts: scripts.map((s) => ({ name: s.name, meta: s.meta, path: s.path })),
    });
  });

  app.get('/standard/source', async (c) => {
    const name = ScriptNameSchema.parse(c.req.query('name'));
    const result = await readStdlibScriptSource(name);
    if (!result) return c.json({ error: 'not found' }, 404);
    return c.json(result);
  });

  app.get('/user', async (c) => {
    const scripts = await listUserScripts(ctx.home);
    return c.json({
      scripts: scripts.map((s) => ({ name: s.name, meta: s.meta, path: s.path })),
    });
  });

  app.get('/user/source', async (c) => {
    const name = ScriptNameSchema.parse(c.req.query('name'));
    const result = await readUserScriptSource(ctx.home, name);
    if (!result) return c.json({ error: 'not found' }, 404);
    return c.json(result);
  });

  app.put('/user/source', async (c) => {
    const body = SaveScriptSourceRequestSchema.parse(await c.req.json());
    if (body.baseHash) {
      const current = await readUserScriptSource(ctx.home, body.name);
      if (current && current.hash !== body.baseHash) {
        const conflict: SaveScriptSourceResponse = {
          status: 'conflict',
          currentHash: current.hash,
          currentSource: current.source,
        };
        return c.json(conflict);
      }
    }
    const { hash } = await writeUserScriptSource(ctx.home, body.name, body.source);
    const file = userScriptFile(ctx.home, body.name);
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

  app.delete('/user/source', async (c) => {
    const name = ScriptNameSchema.parse(c.req.query('name'));
    const deleted = await deleteUserScriptSource(ctx.home, name);
    if (!deleted) return c.json({ error: 'not found' }, 404);
    return c.json({ ok: true });
  });

  app.post('/user', async (c) => {
    const body = CreateScriptRequestSchema.parse(await c.req.json());
    if ((await readUserScriptSource(ctx.home, body.name)) !== null) {
      return c.json({ error: 'exists' }, 409);
    }
    const source = body.source ?? scaffoldScript(body.name, body.description, body.template);
    const { hash } = await writeUserScriptSource(ctx.home, body.name, source);
    return c.json({ name: body.name, source, hash });
  });

  return app;
}
