import { externalGezelModelId } from '@bendyline/gezel';
import { Hono } from 'hono';
import type { ServiceContext } from '../context.js';

/**
 * `GET /v1/gezels` — list the user's gezels for third-party apps that
 * want to surface them as model entries.
 *
 * The VS Code Language Model Chat Provider is the primary consumer:
 * it calls this endpoint, then registers one model entry per gezel
 * (`gezel:<role>-<name>`) so Copilot Chat's model picker shows them alongside
 * raw provider models.
 *
 * Slim shape on purpose — apps don't need the full GezelDetail (which
 * includes the markdown source, sections, poppetje, etc.). Each entry
 * tells the caller "here's a gezel; its effective provider is X; you
 * can address it via a role-name alias in /v1/chat/completions".
 *
 * `provider` / `model` are the gezel's frontmatter override — present
 * only when the gezel explicitly opted out of the install default.
 * `effectiveProvider` / `effectiveModel` are what /v1/chat/completions
 * would actually dispatch with right now, after defaulting kicks in.
 * Apps that just want to show "Planner · gpt-4o-mini" in a picker
 * should read the `effective*` pair; apps that want to render the
 * literal frontmatter (settings panes, audits) should read the raw
 * `provider`/`model`.
 */
interface PublicGezelEntry {
  id: string;
  /** Human-readable id accepted by the external inference routes. */
  modelId: string;
  name: string;
  description?: string;
  role?: string;
  /** Frontmatter override; absent → install default applies. */
  provider?: string;
  /** Frontmatter override; absent → provider default applies. */
  model?: string;
  /**
   * The provider /v1/chat/completions would dispatch to right now.
   * Always present — falls back to the install-default provider when
   * the gezel doesn't override.
   */
  effectiveProvider: string;
  /**
   * The model id /v1/chat/completions would dispatch with right now.
   * Absent when the resolved provider has no model concept (CLI-backed
   * providers — anthropic-cli / codex-cli — bundle their own) or when
   * the install config hasn't set a default for the resolved provider.
   */
  effectiveModel?: string;
}

export function v1GezelsRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  app.get('/', async (c) => {
    const list = await ctx.store.listGezels();
    const config = await ctx.store
      .readConfig()
      .catch(() => ({}) as { defaultModel?: Record<string, string> });
    const defaultModelByProvider = (config.defaultModel ?? {}) as Record<string, string>;

    // Resolve effective provider per gezel in parallel — providerForGezel
    // walks the gezel's frontmatter + install config, and is cached
    // inside ChatManager so repeated calls during a single request are
    // cheap. We swallow per-gezel failures so a single broken gezel
    // doesn't take the whole list down — instead we fall back to the
    // frontmatter override (or 'copilot' when neither is set), the
    // same shape the picker showed before this endpoint resolved
    // effective values.
    const effective = await Promise.all(
      list.map(async (g) => {
        const provider = await ctx.chat.providerForGezel(g.id).catch(() => g.provider ?? 'copilot');
        const model = g.model ?? defaultModelByProvider[provider];
        return { id: g.id, provider, model };
      }),
    );
    const effectiveById = new Map(effective.map((e) => [e.id, e]));

    const data: PublicGezelEntry[] = list.map((g) => {
      const eff = effectiveById.get(g.id);
      return {
        id: g.id,
        modelId: externalGezelModelId(g),
        name: g.name,
        ...(g.description ? { description: g.description } : {}),
        ...(g.role ? { role: g.role } : {}),
        ...(g.provider ? { provider: g.provider } : {}),
        ...(g.model ? { model: g.model } : {}),
        effectiveProvider: eff?.provider ?? g.provider ?? 'copilot',
        ...(eff?.model ? { effectiveModel: eff.model } : {}),
      };
    });
    return c.json({ object: 'list' as const, data });
  });

  return app;
}
