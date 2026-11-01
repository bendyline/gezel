import type { AppImageStyle } from '@bendyline/gezel';
import { Hono } from 'hono';
import { z } from 'zod';
import { isSafeModelId } from '../../models/model-id.js';
import type { ImageModelPullRegistry } from '../../providers/image/pull-registry.js';
import { registerImageEnsureRoutes } from './image-ensure-routes.js';
import type { ImagesRouteContext } from './v1-images.js';

const styleId = z.string().min(1).max(512).refine(isSafeModelId);
const ensureRequest = z.object({ style: styleId }).strict();
const apiError = (code: string, message: string) => ({
  error: { code, message, type: 'invalid_request_error' },
});

/** App-scoped access to catalog LoRAs; no paths, URLs or engine arguments from callers. */
export function v1ImageStylesRoutes(ctx: ImagesRouteContext, pulls: ImageModelPullRegistry): Hono {
  const app = new Hono();
  app.get('/', async (c) => {
    const provider = await ctx.images.current();
    if (!provider.listLoras || !provider.pullLora || !provider.deleteLora) {
      return c.json(apiError('styles_unsupported', 'Update Gezel to add image styles.'), 409);
    }
    const [installed, catalog] = await Promise.all([
      provider.listLoras(),
      ctx.catalog.list('image-lora'),
    ]);
    const data: AppImageStyle[] = [];
    for (const item of catalog) {
      const m = item.manifest;
      if (m.kind !== 'image-lora' || m.purpose !== 'style') continue;
      data.push({
        id: m.id,
        object: 'image_style',
        name: m.name,
        description: m.description,
        availability: installed.some((l) => l.id === m.id)
          ? 'available'
          : pulls.get(m.id)?.finished === false
            ? 'downloading'
            : 'download-required',
        base_models: m.baseModels.map((id) => `sd-cpp:${id}`),
        download_bytes: m.approxSizeBytes,
        ...((m.licenseShortName ?? m.license) ? { license: m.licenseShortName ?? m.license } : {}),
        commercial_use: m.commercialUse,
        ...(m.licenseUrl ? { license_url: m.licenseUrl } : {}),
      });
    }
    for (const l of installed) {
      if (l.purpose !== 'style' || data.some((s) => s.id === l.id)) continue;
      data.push({
        id: l.id,
        object: 'image_style',
        name: l.name,
        availability: 'available',
        download_bytes: l.approxSizeBytes,
        base_models: l.baseModels.map((id) => `sd-cpp:${id}`),
      });
    }
    return c.json({ object: 'list', data });
  });
  app.post('/ensure', async (c) => {
    const { style } = ensureRequest.parse(await c.req.json());
    const provider = await ctx.images.current();
    if (!provider.listLoras || !provider.pullLora)
      return c.json(apiError('styles_unsupported', 'Update Gezel to add image styles.'), 409);
    const installed = await provider.listLoras();
    if (installed.some((l) => l.id === style && l.purpose === 'style'))
      return c.json({ status: 'ready', model_id: style });
    const item = await ctx.catalog.get('image-lora', style);
    if (item?.manifest.kind !== 'image-lora' || item.manifest.purpose !== 'style')
      return c.json(apiError('unknown_style', 'That style is not in the catalog.'), 404);
    const models = await provider.listInstalledModels();
    if (
      !models.some(
        (model) =>
          item.manifest.kind === 'image-lora' && item.manifest.baseModels.includes(model.id),
      )
    ) {
      return c.json(
        apiError(
          'style_model_required',
          'Download a compatible image model before adding this style.',
        ),
        409,
      );
    }
    await pulls.start(style);
    return c.json({ status: 'downloading', model_id: style, job_id: style }, 202);
  });
  registerImageEnsureRoutes(app, '/ensure', pulls, (id) => id);
  app.delete('/:id', async (c) => {
    const id = styleId.parse(c.req.param('id'));
    if (pulls.get(id)?.finished === false)
      return c.json(
        apiError('style_downloading', 'Cancel the style download before removing it.'),
        409,
      );
    await ctx.images.reset();
    const provider = await ctx.images.current();
    if (!provider.deleteLora || !provider.listLoras)
      return c.json(apiError('styles_unsupported', 'Update Gezel to manage image styles.'), 409);
    if (!(await provider.listLoras()).some((l) => l.id === id && l.purpose === 'style'))
      return c.json(apiError('unknown_style', 'That style is not installed.'), 404);
    await provider.deleteLora(id);
    return c.body(null, 204);
  });
  return app;
}
