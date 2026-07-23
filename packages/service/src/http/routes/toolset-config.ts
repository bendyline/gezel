import type { ToolsetConfigField, ToolsetManifest } from '@bendyline/gezel';
import { Hono } from 'hono';
import { z } from 'zod';
import type { ServiceContext } from '../context.js';
import { validateConfigPayload } from './catalog.js';
import { maskValue } from './config.js';

const UpdateToolsetConfigRequestSchema = z.object({
  values: z.record(z.string(), z.string()).optional(),
  /**
   * Partial update. Value `null` deletes the secret; undefined leaves it
   * alone. Omit a field entirely to leave it as-is.
   */
  secrets: z.record(z.string(), z.union([z.string(), z.null()])).optional(),
});

/**
 * Per-toolset global configuration. Non-secret values persisted in the
 * store; secret values routed through SecretStore. Responses never carry
 * secret plaintext — only `secretsPresent: Record<fieldId, boolean>` and
 * (for display) the `****<last4>` mask of each stored secret.
 */
export function toolsetConfigRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  app.get('/:id/config', async (c) => {
    const id = c.req.param('id');
    const detail = await ctx.catalog.get('toolset', id);
    if (!detail || detail.manifest.kind !== 'toolset') {
      return c.json({ error: 'toolset not found' }, 404);
    }
    const manifest = detail.manifest as ToolsetManifest;
    const fields = manifest.config ?? [];
    const config = await ctx.store.readToolsetConfig(id);
    const values = config?.values ?? {};
    const storedSecretFieldIds = await ctx.secrets.listForToolset(id);
    const secretsPresent: Record<string, boolean> = {};
    const secretMasks: Record<string, string> = {};
    for (const f of fields.filter((f) => f.secret)) {
      const present = storedSecretFieldIds.includes(f.id);
      secretsPresent[f.id] = present;
      if (present) {
        const v = await ctx.secrets.get({
          kind: 'toolset',
          toolsetId: id,
          fieldId: f.id,
        });
        secretMasks[f.id] = v ? maskValue(v) : '';
      }
    }
    const missingRequired = fields
      .filter((f) => f.required)
      .filter((f) => {
        const hasValue = f.secret
          ? storedSecretFieldIds.includes(f.id)
          : Object.prototype.hasOwnProperty.call(values, f.id);
        return !hasValue && f.default === undefined;
      })
      .map((f) => f.id);
    const fieldIds = new Set(fields.map((f) => f.id));
    const orphanedValues = Object.keys(values).filter((k) => !fieldIds.has(k));
    const orphanedSecrets = storedSecretFieldIds.filter((k) => !fieldIds.has(k));
    return c.json({
      values,
      secretsPresent,
      secretMasks,
      missingRequired,
      orphaned: { values: orphanedValues, secrets: orphanedSecrets },
    });
  });

  app.put('/:id/config', async (c) => {
    const id = c.req.param('id');
    const detail = await ctx.catalog.get('toolset', id);
    if (!detail || detail.manifest.kind !== 'toolset') {
      return c.json({ error: 'toolset not found' }, 404);
    }
    const manifest = detail.manifest as ToolsetManifest;
    const fields: ToolsetConfigField[] = manifest.config ?? [];
    const body = UpdateToolsetConfigRequestSchema.parse(await c.req.json());

    const existing = await ctx.store.readToolsetConfig(id);
    const existingValues = existing?.values ?? {};
    const existingSecretFieldIds = await ctx.secrets.listForToolset(id);

    const nonNullSecrets: Record<string, string> = {};
    for (const [k, v] of Object.entries(body.secrets ?? {})) {
      if (typeof v === 'string') nonNullSecrets[k] = v;
    }
    const validationError = validateConfigPayload(fields, body.values ?? {}, nonNullSecrets, {
      existingValues,
      existingSecretFieldIds,
    });
    if (validationError) return c.json({ error: validationError }, 400);

    if (body.values) {
      const merged = { ...existingValues, ...body.values };
      await ctx.store.writeToolsetConfigValues(id, merged);
    }
    if (body.secrets) {
      for (const [fieldId, value] of Object.entries(body.secrets)) {
        const key = {
          kind: 'toolset' as const,
          toolsetId: id,
          fieldId,
        };
        if (value === null) {
          await ctx.secrets.delete(key);
        } else {
          await ctx.secrets.set(key, value);
        }
      }
    }
    const changedFields = [...Object.keys(body.values ?? {}), ...Object.keys(body.secrets ?? {})];
    if (changedFields.length > 0) {
      await ctx.history.log({
        kind: 'toolset.config.updated',
        summary: `Updated ${id} config (${changedFields.join(', ')})`,
        details: { toolsetId: id, fieldIds: changedFields },
      });
    }
    await ctx.chat.resetClient();
    return c.json({ ok: true });
  });

  return app;
}
