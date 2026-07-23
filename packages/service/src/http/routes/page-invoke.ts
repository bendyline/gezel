import { InvokePageToolRequestSchema, createLogger } from '@bendyline/gezel';
import { Hono } from 'hono';
import { dispatchToolReaction } from '../../project-type/reactions.js';
import { resolvePageTools, resolveProjectTypeManifest } from '../../project-type/script-tools.js';
import { requireFirstParty } from '../auth.js';
import type { ServiceContext } from '../context.js';

const log = createLogger('http');

/**
 * Ceiling on page-invoked script runtime. Page tools are interaction
 * handlers (record a move, flip a card) — anything slower is a design
 * smell, and the cap keeps a buggy LLM-authored page from parking
 * five-minute sandbox runs.
 */
const PAGE_INVOKE_TIMEOUT_MS = 30_000;

const RATE_WINDOW_MS = 60_000;
const RATE_MAX_INVOKES = 120;

/**
 * The first-party bridge behind interactive Output pages.
 *
 * A served type page cannot reach `/api/*` (it holds only a preview
 * capability); its parent — the in-app Output pane, which holds the ui
 * bearer — relays `{tool, input}` requests here. The route re-derives the
 * allowlist from the applied type's manifest (`pages.tools`) so a
 * compromised or buggy page can never exceed its declaration, then runs
 * the declared script through the standard sandboxed pipeline with the
 * `page` trigger, and finally fires the tool's declared reaction (the
 * ONLY place reactions fire — model-called tools never react, and session
 * tokens can't reach this route, so a gezel can never summon itself).
 */
export function pageInvokeRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();
  const invokeTimes = new Map<string, number[]>();

  function rateLimited(projectId: string): boolean {
    const now = Date.now();
    const recent = (invokeTimes.get(projectId) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
    if (recent.length >= RATE_MAX_INVOKES) {
      invokeTimes.set(projectId, recent);
      return true;
    }
    recent.push(now);
    invokeTimes.set(projectId, recent);
    return false;
  }

  app.post('/:projectId/page-invoke', requireFirstParty(), async (c) => {
    const projectId = c.req.param('projectId');
    if (rateLimited(projectId)) return c.json({ error: 'rate limited' }, 429);

    const body = InvokePageToolRequestSchema.parse(await c.req.json());
    const project = await ctx.store.getProject(projectId).catch(() => null);
    if (!project) return c.json({ error: 'project not found' }, 404);

    const pageTools = await resolvePageTools(ctx.catalog, project);
    if (!pageTools) return c.json({ error: 'project has no applied project type' }, 404);
    const tool = pageTools.tools.find((t) => t.name === body.tool);
    if (!tool) {
      // Distinguish "declared but page-hidden" (a page probing the model
      // surface) from "unknown" for clearer diagnostics.
      const manifest = await resolveProjectTypeManifest(ctx.catalog, project);
      return (manifest?.tools ?? []).some((t) => t.name === body.tool)
        ? c.json({ error: 'tool is not exposed to pages' }, 403)
        : c.json({ error: 'unknown tool' }, 404);
    }

    const run = await ctx.scriptRunner.run({
      projectId,
      scriptName: tool.script,
      inputs: { ...(body.input ?? {}), ...(tool.bind ?? {}) },
      trigger: { kind: 'page', tool: tool.name },
      timeoutMs: PAGE_INVOKE_TIMEOUT_MS,
    });

    await ctx.history
      .log({
        kind: 'page.tool.invoked',
        projectId,
        summary: `Page invoked '${tool.name}' (${run.status})`,
        details: { tool: tool.name, script: tool.script, runId: run.id, status: run.status },
      })
      .catch((err) => log.warn('[page-invoke] history log failed:', err));

    // The summons never fails the invoke — the user's action already
    // applied; `reaction` in the response says what happened to the turn.
    let reaction: Awaited<ReturnType<typeof dispatchToolReaction>> | undefined;
    if (run.status === 'ok' && tool.reaction) {
      reaction = await dispatchToolReaction(
        { store: ctx.store, chat: ctx.chat, history: ctx.history },
        {
          project,
          typeName: pageTools.typeName,
          ...(pageTools.params ? { params: pageTools.params } : {}),
          tool,
          run,
        },
      );
    }

    // Always 200 — a failed script run is a run report the page must read
    // (the error text is its user feedback); 5xx bodies are opaqued by the
    // server-wide sanitizer. Matches the /scripts/run contract.
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
      ...(reaction ? { reaction } : {}),
    });
  });

  return app;
}
