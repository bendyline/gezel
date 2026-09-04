import {
  CreateGezelRequestSchema,
  EnsureGezelRequestSchema,
  GenerateGezelAboutRequestSchema,
  GenerateGezelIconRequestSchema,
  MessageGezelRequestSchema,
  RenameGezelRequestSchema,
  RerollGezelPoppetjeRequestSchema,
  RevertGezelIconRequestSchema,
  UpdateGezelAboutRequestSchema,
  UpdateGezelFixedFunctionDefaultsRequestSchema,
  UpdateGezelIconRequestSchema,
  UpdateGezelMarkdownRequestSchema,
  UpdateGezelPoppetjeRequestSchema,
  UpdateGezelSettingsRequestSchema,
  getEngagementMode,
  isEngagementAllowed,
} from '@bendyline/gezel';
import { Hono } from 'hono';
import { generateGezelAbout } from '../../about/generator.js';
import { ensureDefaultBoekwachter } from '../../gezels/autonomous-roles.js';
import { ensureGezel, resolveGildeTemplateForRole } from '../../gezels/ensure.js';
import { resetTemplateGezels } from '../../gezels/reset-templates.js';
import { deriveGezelRoster, filterRoster, rankProjectsForGezel } from '../../gezels/roster.js';
import { generateGezelIcon } from '../../icon/generator.js';
import { sanitizeSvg } from '../../icon/sanitize.js';
import type { ServiceContext } from '../context.js';
import { buildTimeline } from './timeline.js';

export function gezelRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  app.get('/', async (c) => {
    const gezels = await ctx.store.listGezels();
    return c.json({ gezels });
  });

  // Roster for the chat composer's `@`-mention popover. Optional
  // `project` weights voorman + task assignees to the top; optional
  // `query` does a case-insensitive server-side filter. Registered
  // before `/:id` so the literal path doesn't get swallowed.
  app.get('/mention-candidates', async (c) => {
    const projectId = c.req.query('project') || undefined;
    const query = c.req.query('query') || '';
    const roster = await deriveGezelRoster(ctx.store, projectId);
    const candidates = filterRoster(roster, query);
    return c.json({ candidates });
  });

  app.post('/', async (c) => {
    const body = CreateGezelRequestSchema.parse(await c.req.json());
    // About-omitted fallback: a role that matches a shipped gilde
    // template gets the template's curated about (plus its frontmatter,
    // e.g. suggestedTuningProfile) instead of the generic placeholder.
    // An explicit about always wins — that's the bespoke path. This is
    // what makes "create a Developer" produce the product-shaped
    // Developer everywhere (UI, API, eval harness) instead of a
    // role-less generic assistant.
    if (!body.about?.trim() && body.role) {
      const tpl = await resolveGildeTemplateForRole(ctx.catalog, body.role).catch(() => null);
      if (tpl) {
        const agent = await ctx.store.createGezel({
          ...body,
          about: tpl.about,
          templateId: tpl.templateId,
          templateVersion: tpl.templateVersion,
          ...(tpl.frontmatter ? { frontmatter: tpl.frontmatter } : {}),
        });
        return c.json(agent, 201);
      }
    }
    const agent = await ctx.store.createGezel(body);
    return c.json(agent, 201);
  });

  app.get('/:id', async (c) => {
    const id = c.req.param('id');
    const agent = await ctx.store.getGezel(id);
    if (!agent) return c.json({ error: 'not found' }, 404);
    return c.json(agent);
  });

  app.delete('/:id', async (c) => {
    const id = c.req.param('id');
    const agent = await ctx.store.getGezel(id);
    if (!agent) return c.json({ error: 'not found' }, 404);
    // Shared identity belongs to every local account. Refuse before closing
    // this account's private sessions; machine-wide removal needs its own
    // explicit administration flow.
    if (agent.storageScope === 'machine-shared') {
      return c.json(
        {
          error:
            'Machine-shared gezels cannot be removed from an individual account. Shared removal is not available yet.',
          reason: 'machine_shared',
        },
        400,
      );
    }

    // Close provider sessions before their on-disk records disappear so
    // in-flight work, queues, and prompt caches cannot outlive the gezel.
    const sessions = await ctx.chat.listSessions({ gezelId: id });
    for (const session of sessions) await ctx.chat.deleteSession(session.id);

    const wasBoekwachter = (await ctx.store.readConfig()).boekwachterGezelId === id;
    const boekwachterProjectIds = wasBoekwachter
      ? (await ctx.store.listProjects())
          .filter((project) => project.gezelIds?.includes(id))
          .map((project) => project.id)
      : [];
    const removed = await ctx.store.deleteGezel(id);
    if (wasBoekwachter) {
      // Like the Meester, the Boekwachter is an ensured product role. The
      // replacement is canonical and inherits only the old one's projects,
      // preserving every explicit project opt-out.
      await ensureDefaultBoekwachter(ctx.store, ctx.catalog, {
        recruitProjectIds: boekwachterProjectIds,
      });
    }
    return c.json({ ok: true as const, ...removed });
  });

  // Ranked list of projects where the gezel has presence (voorman,
  // active assignment, or any non-archived session) — drives the
  // project picker in the Gezel screen's Chat tab. `default` always
  // tails the list so the dropdown is never empty.
  app.get('/:id/projects', async (c) => {
    const id = c.req.param('id');
    const projects = await rankProjectsForGezel(ctx.store, id);
    return c.json({ projects });
  });

  // Per-gezel chat timeline — every session for this gezel, interleaved
  // across projects (or scoped to one project via `?project=<id>`). Used
  // by the Gezel screen's Chat tab so it feels like a DM thread with the
  // gezel rather than a feed of everything happening in the project.
  app.get('/:id/timeline', async (c) => {
    const id = c.req.param('id');
    const response = await buildTimeline(ctx, {
      gezelId: id,
      rawLimit: c.req.query('limit'),
      before: c.req.query('before'),
      projectId: c.req.query('project'),
    });
    return c.json(response);
  });

  app.put('/:id/md', async (c) => {
    const id = c.req.param('id');
    const body = UpdateGezelMarkdownRequestSchema.parse(await c.req.json());
    const agent = await ctx.store.updateGezelMarkdown(id, body.source);
    return c.json(agent);
  });

  app.post('/:id/rename', async (c) => {
    const id = c.req.param('id');
    const body = RenameGezelRequestSchema.parse(await c.req.json());
    const agent = await ctx.store.renameGezel(id, body.name);
    return c.json(agent);
  });

  app.put('/:id/about', async (c) => {
    const id = c.req.param('id');
    const body = UpdateGezelAboutRequestSchema.parse(await c.req.json());
    try {
      const agent = await ctx.store.updateGezelAbout(id, body.source);
      return c.json(agent);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Fixed-function gezels reject about.md edits — surface as 400
      // so the UI can render the editor as disabled instead of mid-
      // edit failing with a generic 500.
      if (message.includes('fixed-function')) {
        return c.json({ error: message }, 400);
      }
      throw err;
    }
  });

  /**
   * Fixed-function defaults editor. Only valid for gezels whose
   * frontmatter declares a `fixedFunction` block (the
   * `image-generator` template, etc.). The `tool` and `promptKey`
   * fields are template-owned; only `defaults` is user-editable.
   */
  app.put('/:id/fixed-function-defaults', async (c) => {
    const id = c.req.param('id');
    const body = UpdateGezelFixedFunctionDefaultsRequestSchema.parse(await c.req.json());
    try {
      const agent = await ctx.store.updateGezelFixedFunctionDefaults(id, body.defaults);
      // The session's MCP bridge stays warm — the new defaults take
      // effect on the next message because they're read at call time
      // from the gezel record, not baked into the bridge spawn. No
      // session reset needed.
      return c.json(agent);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 400);
    }
  });

  app.post('/:id/settings', async (c) => {
    const id = c.req.param('id');
    const body = UpdateGezelSettingsRequestSchema.parse(await c.req.json());
    const agent = await ctx.store.updateGezelSettings(id, body);
    // Provider change invalidates every live session for this gezel — the next
    // turn will rebuild with the new provider.
    if (body.provider !== undefined) {
      const sessions = await ctx.chat.listSessions({ gezelId: id });
      for (const s of sessions) {
        try {
          await ctx.chat.reset(s.id);
        } catch {
          /* ignore */
        }
      }
    }
    return c.json(agent);
  });

  app.post('/:id/about/generate', async (c) => {
    const id = c.req.param('id');
    const body = GenerateGezelAboutRequestSchema.parse(await c.req.json().catch(() => ({})));
    const agent = await ctx.store.getGezel(id);
    if (!agent) return c.json({ error: 'not found' }, 404);
    const role = (body.role ?? agent.role ?? '').trim();
    if (!role) return c.json({ error: 'role required to generate about' }, 400);
    try {
      const markdown = await generateGezelAbout(ctx.chat, role);
      const updated = await ctx.store.updateGezelAbout(id, markdown);
      return c.json(updated);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  app.post('/:id/icon/generate', async (c) => {
    const id = c.req.param('id');
    const body = GenerateGezelIconRequestSchema.parse(await c.req.json().catch(() => ({})));
    const agent = await ctx.store.getGezel(id);
    if (!agent) return c.json({ error: 'not found' }, 404);
    try {
      const svg = await generateGezelIcon(ctx.chat, agent, {
        instruction: body.instruction,
        iterateFrom: agent.icon ?? null,
      });
      const updated = await ctx.store.writeGezelIcon(id, svg);
      return c.json(updated);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  app.put('/:id/icon', async (c) => {
    const id = c.req.param('id');
    const body = UpdateGezelIconRequestSchema.parse(await c.req.json());
    const svg = sanitizeSvg(body.svg);
    if (!svg) return c.json({ error: 'invalid SVG' }, 400);
    const agent = await ctx.store.writeGezelIcon(id, svg);
    return c.json(agent);
  });

  app.get('/:id/icons', async (c) => {
    const id = c.req.param('id');
    const result = await ctx.store.listGezelIconHistory(id);
    return c.json(result);
  });

  app.post('/:id/icon/revert', async (c) => {
    const id = c.req.param('id');
    const body = RevertGezelIconRequestSchema.parse(await c.req.json());
    const agent = await ctx.store.revertGezelIcon(id, body.timestamp);
    return c.json(agent);
  });

  // Poppetje routes — parametric character figure. The PoppetjeManager
  // self-heals (generates and persists on first read), so GET always
  // returns a struct. PUT replaces it (e.g. future per-slot pickers);
  // reroll draws a fresh seed.
  app.get('/:id/poppetje', async (c) => {
    const id = c.req.param('id');
    const agent = await ctx.store.getGezel(id);
    if (!agent) return c.json({ error: 'not found' }, 404);
    const poppetje = await ctx.store.poppetjeManager.get(id, agent.name, agent.gender);
    return c.json({ poppetje });
  });

  app.put('/:id/poppetje', async (c) => {
    const id = c.req.param('id');
    const agent = await ctx.store.getGezel(id);
    if (!agent) return c.json({ error: 'not found' }, 404);
    const body = UpdateGezelPoppetjeRequestSchema.parse(await c.req.json());
    const poppetje = await ctx.store.poppetjeManager.set(id, agent.name, body.poppetje);
    return c.json({ poppetje });
  });

  app.post('/:id/poppetje/reroll', async (c) => {
    const id = c.req.param('id');
    const agent = await ctx.store.getGezel(id);
    if (!agent) return c.json({ error: 'not found' }, 404);
    const body = RerollGezelPoppetjeRequestSchema.parse(await c.req.json().catch(() => ({})));
    const poppetje = await ctx.store.poppetjeManager.reroll(id, agent.name, {
      ...(body.seed !== undefined ? { seed: body.seed } : {}),
      ...(agent.gender ? { gender: agent.gender } : {}),
    });
    return c.json({ poppetje });
  });

  app.post('/ensure', async (c) => {
    const body = EnsureGezelRequestSchema.parse(await c.req.json());
    try {
      const result = await ensureGezel({
        opts: body,
        store: ctx.store,
        catalog: ctx.catalog,
        chat: ctx.chat,
      });
      return c.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 400);
    }
  });

  // Restore every template-derived gezel's about.md back to its catalog
  // default, discarding local edits. Backs the Settings → General "Reset to
  // defaults" button; the same sweep runs at boot when
  // `resetTemplatesOnStartup` is set (see startService).
  app.post('/reset-templates', async (c) => {
    const result = await resetTemplateGezels({ store: ctx.store, catalog: ctx.catalog });
    return c.json(result);
  });

  app.post('/:id/message', async (c) => {
    const toId = c.req.param('id');
    const body = MessageGezelRequestSchema.parse(await c.req.json());
    const cfg = await ctx.store.readConfig();
    // Same engagement-mode gate as within-turn nudges: this endpoint
    // fires when one gezel delegates to another (Meester → voorman,
    // voorman → specialist) — that's part of fulfilling the user's
    // already-sent ask, not new ambient outreach. Gating on
    // `isProactiveAllowed` blocked every cross-gezel message under
    // `reactive` mode, leaving voormen unable to kick off specialist
    // work. Use `isEngagementAllowed` to permit it under reactive while
    // still blocking under `off`. Genuinely-ambient outreach (cron
    // ticks waking up a voorman) is gated separately at the trigger
    // layer; the call landing here means a session is actively
    // delegating, which is in-scope for any non-`off` mode.
    if (!isEngagementAllowed(cfg)) {
      return c.json(
        {
          error: `engagement mode is ${getEngagementMode(cfg)}; cross-gezel messaging is paused`,
        },
        403,
      );
    }
    try {
      const res = await ctx.chat.messageGezel({
        fromGezelId: body.fromGezelId,
        fromSessionId: body.fromSessionId,
        toGezelIdOrName: toId,
        projectId: body.projectId,
        text: body.text,
        ...(body.suppressReply ? { suppressReply: true } : {}),
        ...(body.expectedDeliverable ? { expectedDeliverable: body.expectedDeliverable } : {}),
      });
      return c.json({
        accepted: true as const,
        sessionId: res.sessionId,
        toGezelId: res.toGezelId,
        toGezelName: res.toGezelName,
        deliveryState: res.deliveryState,
        ...(res.deduplicated ? { deduplicated: true } : {}),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 400);
    }
  });

  return app;
}
