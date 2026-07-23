/**
 * Direct MCP tool surface for the CLI/TUI "CLI mode". Lets a caller list
 * and invoke a session's MCP tools by name *outside* the model loop — the
 * same merged toolset (built-in gezel-mcp + the gezel's installed toolsets)
 * an actual turn would expose, run through the same wrapped bridge.
 *
 * Mounted under `/api/sessions`, so URLs look like
 * `/api/sessions/:id/tools` and `/api/sessions/:id/tools/:name/invoke`.
 *
 * Session-scoped (not project-scoped) on purpose: the session already
 * pins the project + gezel + toolset context, so tools resolve exactly as
 * they would for that gezel's chat. The TUI already owns a session for its
 * prompt surface, so it has the id to hand.
 */

import { InvokeSessionToolRequestSchema, createLogger } from '@bendyline/gezel';
import { Hono } from 'hono';
import type { ServiceContext } from '../context.js';

const log = createLogger('http');

export function mcpToolRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  // List the tools available in this session's context.
  app.get('/:id/tools', async (c) => {
    const id = c.req.param('id');
    const record = await ctx.chat.getSessionRecord(id);
    if (!record) return c.json({ error: 'session not found' }, 404);
    try {
      const tools = await ctx.chat.listSessionTools(id);
      // Shape down to the wire schema (drop `type: 'function'`/`strict`).
      return c.json({
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`list session tools failed for ${id}: ${message}`);
      return c.json({ error: message }, 500);
    }
  });

  // Invoke one tool by name. 404 when the session is gone, 400 when the
  // tool isn't available in this session (or the bridge rejects the call).
  app.post('/:id/tools/:name/invoke', async (c) => {
    const id = c.req.param('id');
    const name = c.req.param('name');
    const record = await ctx.chat.getSessionRecord(id);
    if (!record) return c.json({ error: 'session not found' }, 404);
    const body = InvokeSessionToolRequestSchema.parse(await c.req.json().catch(() => ({})));
    try {
      const result = await ctx.chat.invokeSessionTool(id, name, body.args ?? {});
      return c.json({ text: result.text, images: result.images });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`invoke session tool ${name} failed for ${id}: ${message}`);
      return c.json({ error: message }, 400);
    }
  });

  return app;
}
