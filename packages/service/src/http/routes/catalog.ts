import { extname } from 'node:path';
import {
  CatalogKindSchema,
  type GezelFrontmatter,
  GezelFrontmatterSchema,
  GezelGenderSchema,
  type InstalledToolset,
  type ToolsetConfigField,
  type ToolsetManifest,
  type ToolsetsScope,
  ToolsetsScopeSchema,
  resolveSecurityPolicy,
} from '@bendyline/gezel';
import { BUILTIN_TOOLSETS, installNpmPackageToolset } from '@bendyline/gezel-catalog';
import { Hono } from 'hono';
import { z } from 'zod';
import { roleToolsetGroups } from '../../chat/role-tool-filter.js';
import type { ServiceContext } from '../context.js';

/**
 * Validate the catalog manifest's `frontmatter` extension against the
 * gezel frontmatter schema. Returns `null` when the template doesn't
 * carry one. The catalog package keeps the field schema-loose
 * (`record(unknown)`) so the gezel-frontmatter shape can evolve
 * without rev'ing the catalog package; here, at install time, we
 * tighten so a malformed template fails loudly rather than producing
 * a silently-broken `gezel.md` on disk.
 */
function parseTemplateFrontmatter(
  raw: Record<string, unknown> | undefined,
): Partial<GezelFrontmatter> | null {
  if (!raw || Object.keys(raw).length === 0) return null;
  const merged = { name: '__template__', ...raw };
  const parsed = GezelFrontmatterSchema.parse(merged);
  const { name: _name, id: _id, ...extras } = parsed;
  return extras;
}

const InstallToolsetRequestSchema = z.object({
  scope: ToolsetsScopeSchema,
  values: z.record(z.string(), z.string()).optional(),
  secrets: z.record(z.string(), z.string()).optional(),
  /** Optional explicit version pin. Default = catalog's auto-resolved latest. */
  version: z.string().optional(),
});

/**
 * Validate a config payload against the manifest's declared fields.
 * Returns an error message or null.
 *
 * A field is considered "present" if its value appears in `values`
 * (non-secret) or `secrets` (secret), or if it was already stored.
 */
export function validateConfigPayload(
  fields: ToolsetConfigField[],
  values: Record<string, string>,
  secrets: Record<string, string>,
  existing: { existingValues: Record<string, string>; existingSecretFieldIds: string[] },
): string | null {
  for (const f of fields) {
    if (f.secret) {
      if (Object.prototype.hasOwnProperty.call(values, f.id)) {
        return `field ${f.id} is secret; send via \`secrets\`, not \`values\``;
      }
    } else {
      if (Object.prototype.hasOwnProperty.call(secrets, f.id)) {
        return `field ${f.id} is not secret; send via \`values\`, not \`secrets\``;
      }
    }
    if (f.type === 'enum' && Object.prototype.hasOwnProperty.call(values, f.id)) {
      const v = values[f.id];
      if (!f.options || !f.options.includes(v ?? '')) {
        return `field ${f.id} must be one of: ${(f.options ?? []).join(', ')}`;
      }
    }
    if (f.pattern && Object.prototype.hasOwnProperty.call(values, f.id)) {
      const v = values[f.id] ?? '';
      if (!new RegExp(f.pattern).test(v)) {
        return `field ${f.id} does not match pattern ${f.pattern}`;
      }
    }
    if (f.required) {
      const hasIncoming = f.secret
        ? Object.prototype.hasOwnProperty.call(secrets, f.id)
        : Object.prototype.hasOwnProperty.call(values, f.id);
      const hasExisting = f.secret
        ? existing.existingSecretFieldIds.includes(f.id)
        : Object.prototype.hasOwnProperty.call(existing.existingValues, f.id);
      if (!hasIncoming && !hasExisting && f.default === undefined) {
        return `required field ${f.id} is missing`;
      }
    }
  }
  return null;
}

function scopeFromQuery(
  query: Record<string, string | undefined>,
): ToolsetsScope | { error: string } {
  const kind = query.scope;
  if (kind === 'shared') return { kind: 'shared' };
  if (kind === 'system') return { kind: 'system' };
  if (kind === 'project') {
    const projectId = query.project;
    if (!projectId) return { error: 'missing ?project=<id> for project scope' };
    return { kind: 'project', projectId };
  }
  if (kind === 'gezel' || kind === undefined) {
    const gezelId = query.gezel;
    if (!gezelId) return { error: 'missing ?gezel=<id> for gezel scope' };
    return { kind: 'gezel', gezelId };
  }
  return { error: `unknown scope "${kind}"` };
}

const InstallTemplateRequestSchema = z.object({
  name: z.string().min(1),
  /** Optional explicit version pin. Default = catalog's auto-resolved latest. */
  version: z.string().optional(),
  /**
   * Optional explicit gender. When omitted, the Store infers from the
   * name's gendered pool with a flat NB share. Pass through when the
   * caller already picked a name+gender pair (so the NB roll isn't
   * re-rolled inside the Store).
   */
  gender: GezelGenderSchema.optional(),
});

/**
 * Catalog HTTP surface. The UI drives everything off these endpoints:
 *
 *   GET  /api/catalog/:kind
 *   GET  /api/catalog/:kind/:id
 *   GET  /api/catalog/:kind/:id/file/:relPath   ← logos, readmes, aboutmd
 *
 * Install endpoints (template → gezel, toolset → gezel install) are
 * wired in later alongside the gezel plumbing so they can mutate the
 * store.
 */
function contentTypeFor(ext: string): string {
  switch (ext.toLowerCase()) {
    case '.svg':
      return 'image/svg+xml';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    case '.md':
      return 'text/markdown; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    default:
      return 'application/octet-stream';
  }
}

export function catalogRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  /**
   * Installed toolsets for a scope (per-gezel or shared). Declared BEFORE
   * the `/:kind` catch-all so Hono's router doesn't interpret
   * "installed-toolsets" as a kind (which would fail zod validation).
   */
  app.get('/installed-toolsets', async (c) => {
    const scope = scopeFromQuery(c.req.query());
    if ('error' in scope) return c.json({ error: scope.error }, 400);
    const roster = await ctx.store.listInstalledToolsets(scope);
    // Include the gezel's role default groups so the UI can render
    // an "inheriting role default" banner when the scope has no
    // built-in entries. Only computed for gezel scope.
    let roleDefault: { role: string | null; groupIds: string[]; groupNames: string[] } | undefined;
    if (scope.kind === 'gezel') {
      const gezel = await ctx.store.getGezel(scope.gezelId);
      const role = gezel?.role ?? null;
      const groupIds = [...roleToolsetGroups(role ?? undefined)];
      const groupNames = groupIds.map(
        (id) => BUILTIN_TOOLSETS.find((g) => g.id === id)?.name ?? id,
      );
      roleDefault = { role, groupIds, groupNames };
    }
    return c.json({ toolsets: roster, ...(roleDefault ? { roleDefault } : {}) });
  });

  app.get('/:kind', async (c) => {
    const kind = CatalogKindSchema.safeParse(c.req.param('kind'));
    if (!kind.success) return c.json({ error: 'unknown kind' }, 400);
    const items = await ctx.catalog.list(kind.data);
    return c.json({ items });
  });

  app.get('/:kind/:id', async (c) => {
    const kind = CatalogKindSchema.safeParse(c.req.param('kind'));
    if (!kind.success) return c.json({ error: 'unknown kind' }, 400);
    const id = c.req.param('id');
    const source = c.req.query('source') || undefined;
    const version = c.req.query('version') || undefined;
    const detail = await ctx.catalog.get(kind.data, id, source, version);
    if (!detail) return c.json({ error: 'not found' }, 404);
    return c.json(detail);
  });

  /**
   * All known versions of an item, newest first. Empty array when the
   * item is unknown or has no versions on disk. Drives the "older
   * versions" expander in the catalog UI and the upgrade-available
   * badge derivation.
   */
  app.get('/:kind/:id/versions', async (c) => {
    const kind = CatalogKindSchema.safeParse(c.req.param('kind'));
    if (!kind.success) return c.json({ error: 'unknown kind' }, 400);
    const id = c.req.param('id');
    const source = c.req.query('source') || undefined;
    const versions = await ctx.catalog.listVersions(kind.data, id, source);
    return c.json({ versions });
  });

  app.get('/:kind/:id/file/:rel{.+}', async (c) => {
    const kind = CatalogKindSchema.safeParse(c.req.param('kind'));
    if (!kind.success) return c.json({ error: 'unknown kind' }, 400);
    const id = c.req.param('id');
    const rel = c.req.param('rel');
    const source = c.req.query('source') || undefined;
    const version = c.req.query('version') || undefined;
    const buf = await ctx.catalog.readItemFile(kind.data, id, rel, source, version);
    if (!buf) return c.json({ error: 'not found' }, 404);
    return c.body(new Uint8Array(buf), 200, {
      'content-type': contentTypeFor(extname(rel)),
    });
  });

  /**
   * Create a new gezel from a gezel-template. Reads the template's about.md
   * and passes it through to `createGezel`. Doesn't auto-install the
   * template's `suggestedTools` yet — callers can do that with subsequent
   * toolset install calls.
   */
  app.post('/gezel-template/:id/install', async (c) => {
    const id = c.req.param('id');
    const body = InstallTemplateRequestSchema.parse(await c.req.json());
    const detail = await ctx.catalog.get('gezel-template', id, undefined, body.version);
    if (!detail) {
      return c.json(
        {
          error: body.version ? `template ${id}@${body.version} not found` : 'template not found',
        },
        404,
      );
    }
    if (detail.manifest.kind !== 'gezel-template') {
      return c.json({ error: 'kind mismatch' }, 400);
    }
    const about = detail.about ?? '';
    // Templates may carry a `frontmatter` extension (today: only the
    // `fixedFunction` block on pass-through templates). Validate against
    // the gezel frontmatter schema here so a malformed template fails
    // loudly at install time rather than producing a silently-broken
    // gezel.md downstream.
    const extraFrontmatter = parseTemplateFrontmatter(detail.manifest.frontmatter);
    const created = await ctx.store.createGezel({
      name: body.name,
      role: detail.manifest.role,
      about,
      ...(body.gender ? { gender: body.gender } : {}),
      templateId: id,
      templateVersion: detail.manifest.version,
      ...(extraFrontmatter ? { frontmatter: extraFrontmatter } : {}),
    });
    await ctx.history.log({
      kind: 'gezel.created',
      gezelId: created.id,
      summary: `Created "${created.name}" from template ${id}@${detail.manifest.version}`,
      details: {
        templateId: id,
        templateVersion: detail.manifest.version,
        role: detail.manifest.role,
      },
    });
    return c.json(created, 201);
  });

  /**
   * Install a toolset for a specific gezel. Writes the InstalledToolset
   * record to the gezel's on-disk roster; the record's `runtime` snapshot
   * is what ChatManager will spawn on next session create.
   *
   * Supported runtimes today:
   *   - http-mcp:            instant — just records the URL + env hints.
   *   - npm-package:         fetches + sha256-verifies + extracts tarball.
   *   - stdio-mcp-binary:    not yet — returns 501.
   */
  app.post('/toolset/:id/install', async (c) => {
    const id = c.req.param('id');
    const body = InstallToolsetRequestSchema.parse(await c.req.json());
    if (body.scope.kind === 'gezel') {
      const gezel = await ctx.store.getGezel(body.scope.gezelId);
      if (!gezel) return c.json({ error: 'gezel not found' }, 404);
    }
    if (body.scope.kind === 'project') {
      const project = await ctx.store.getProject(body.scope.projectId).catch(() => null);
      if (!project) return c.json({ error: 'project not found' }, 404);
    }
    const detail = await ctx.catalog.get('toolset', id, undefined, body.version);
    if (!detail) {
      return c.json(
        {
          error: body.version ? `toolset ${id}@${body.version} not found` : 'toolset not found',
        },
        404,
      );
    }
    const manifest = detail.manifest;
    if (manifest.kind !== 'toolset') {
      return c.json({ error: 'kind mismatch' }, 400);
    }

    // Centralized security ceiling: installing a non-builtin toolset means
    // downloading code (npm tarball) or wiring up a remote MCP — outbound
    // external-service access. Blocked when services are disabled. Built-in
    // groups are in-process and need no download, so they stay installable.
    // (HuggingFace model pulls are the deliberate, separately-gated
    // exception and don't flow through here.)
    if (
      manifest.runtime.kind !== 'builtin' &&
      !resolveSecurityPolicy(await ctx.store.readConfig()).allowExternalServices
    ) {
      return c.json(
        {
          error:
            'Security policy: external services are disabled, so external toolsets cannot be downloaded or registered. Raise the security level in Settings → Security & Compliance.',
        },
        403,
      );
    }

    let installPath: string | undefined;
    try {
      if (manifest.runtime.kind === 'npm-package') {
        const result = await installNpmPackageToolset({
          manifest: manifest as ToolsetManifest & { runtime: { kind: 'npm-package' } },
          installRoot: ctx.store.toolsetInstallRoot(body.scope),
        });
        installPath = result.installPath;
      } else if (manifest.runtime.kind === 'stdio-mcp-binary') {
        return c.json({ error: 'stdio-mcp-binary installs are not yet supported' }, 501);
      }
      // http-mcp: nothing to download; the URL is the install.
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }

    const validationError = validateConfigPayload(
      manifest.config,
      body.values ?? {},
      body.secrets ?? {},
      { existingValues: {}, existingSecretFieldIds: [] },
    );
    if (validationError) return c.json({ error: validationError }, 400);

    const roster = await ctx.store.listInstalledToolsets(body.scope);
    const record: InstalledToolset = {
      toolsetId: manifest.id,
      sourceId: detail.sourceId,
      version: manifest.version,
      installedAt: new Date().toISOString(),
      ...(installPath ? { installPath } : {}),
      runtime: manifest.runtime,
    };
    const next = [...roster.filter((t) => t.toolsetId !== manifest.id), record];
    await ctx.store.writeInstalledToolsets(body.scope, next);

    if (body.values && Object.keys(body.values).length > 0) {
      const existing = await ctx.store.readToolsetConfig(manifest.id);
      const merged = { ...(existing?.values ?? {}), ...body.values };
      await ctx.store.writeToolsetConfigValues(manifest.id, merged);
    }
    if (body.secrets) {
      for (const [fieldId, value] of Object.entries(body.secrets)) {
        await ctx.secrets.set({ kind: 'toolset', toolsetId: manifest.id, fieldId }, value);
      }
    }

    // New toolset → live chat sessions must be rebuilt so their MCP bridges
    // include the new server.
    await ctx.chat.resetClient();

    return c.json({ ok: true, installed: record });
  });

  app.delete('/toolset/:id/install', async (c) => {
    const id = c.req.param('id');
    const scope = scopeFromQuery(c.req.query());
    if ('error' in scope) return c.json({ error: scope.error }, 400);
    const roster = await ctx.store.listInstalledToolsets(scope);
    const next = roster.filter((t) => t.toolsetId !== id);
    if (next.length === roster.length) {
      return c.json({ error: 'not installed' }, 404);
    }
    await ctx.store.writeInstalledToolsets(scope, next);
    await ctx.chat.resetClient();
    return c.json({ ok: true });
  });

  return app;
}
