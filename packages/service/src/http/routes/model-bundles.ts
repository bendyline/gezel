import { Readable } from 'node:stream';
import { GezmodelEngineSchema } from '@bendyline/gezel';
import { Hono } from 'hono';
import { z } from 'zod';
import { GezmodelManager } from '../../models/gezmodel.js';
import type { ServiceContext } from '../context.js';
import { invalidateModelsCache } from './models.js';

/** Portable `.gezmodel` export + staged, review-before-publish import. */
export function modelBundleRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();
  const bundles = new GezmodelManager({
    home: ctx.home,
    catalog: ctx.catalog,
    llamaCpp: ctx.llamaCppModels,
    mlx: ctx.mlxModels,
    ds4: ctx.ds4Models,
  });

  app.get('/:engine/:id/export', async (c) => {
    try {
      const engine = GezmodelEngineSchema.parse(c.req.param('engine'));
      const bundle = await bundles.export(engine, c.req.param('id'));
      c.header('Content-Type', 'application/vnd.gezel.model+zip');
      c.header('Content-Disposition', `attachment; filename="${bundle.filename}"`);
      c.header('X-Content-Type-Options', 'nosniff');
      return c.body(Readable.toWeb(bundle.stream as Readable) as ReadableStream<Uint8Array>);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post('/imports/scan', async (c) => {
    const body = c.req.raw.body;
    if (!body) return c.json({ error: 'empty model bundle upload' }, 400);
    try {
      const review = await bundles.scanUpload(
        Readable.fromWeb(body as import('node:stream/web').ReadableStream<Uint8Array>),
      );
      return c.json(review, 201);
    } catch (err) {
      return c.json(
        {
          error: `model bundle failed security scan: ${err instanceof Error ? err.message : String(err)}`,
        },
        400,
      );
    }
  });

  const ConfirmSchema = z.object({
    importId: z.string().uuid(),
    replace: z.boolean().default(false),
  });
  app.post('/imports/confirm', async (c) => {
    try {
      const body = ConfirmSchema.parse(await c.req.json());
      const imported = await bundles.confirmImport(body.importId, body.replace);
      invalidateModelsCache(imported.engine);
      return c.json({ ok: true as const, ...imported });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, message.includes('already installed') ? 409 : 400);
    }
  });

  app.delete('/imports/:importId', async (c) => {
    try {
      await bundles.cancelImport(c.req.param('importId'));
      return c.json({ ok: true as const });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  return app;
}
