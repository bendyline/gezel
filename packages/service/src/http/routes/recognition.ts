import { RecognitionRequestSchema, createLogger } from '@bendyline/gezel';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { readImageStaticMeta } from '../../index-store/image-meta.js';
import {
  INVALID_MODEL_ID_CODE,
  INVALID_MODEL_ID_MESSAGE,
  isSafeModelId,
} from '../../models/model-id.js';
import {
  RECOGNITION_MODEL_CATALOG,
  findRecognitionCatalogEntry,
} from '../../providers/recognition/catalog.js';
import { resolveAutoMode } from '../../providers/recognition/prompts.js';
import type { ServiceContext } from '../context.js';

const log = createLogger('recognition');

/**
 * Image-recognition endpoints. Mounted at `/api/recognition`.
 *
 *   - `POST /describe`          — one-shot recognition.
 *   - `GET  /health`            — readiness, without paying a cold start.
 *   - `GET  /catalog`           — models available to pull.
 *   - `GET  /models`            — installed models.
 *   - `POST /models/:id/pull`   — pull a model (SSE progress).
 *   - `DELETE /models/:id`      — delete an installed model.
 *   - `POST /cache/clear`       — drop cached descriptions.
 *
 * Layout mirrors `/api/audio`.
 */
export function recognitionRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  app.post('/describe', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = RecognitionRequestSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const req = parsed.data;
    const projectId = c.req.query('project') ?? 'default';

    let bytes: Buffer;
    let mime: string;
    let filename: string | undefined;
    try {
      if (req.artifactPath) {
        const stripped = req.artifactPath.replace(/^artifacts\//, '');
        const found = await ctx.store.readProjectArtifactBinary(projectId, stripped);
        if (!found) return c.json({ error: `Image not found at artifacts/${stripped}` }, 404);
        bytes = found.data;
        mime = found.mimeType;
        filename = stripped.split('/').pop();
      } else if (req.data) {
        bytes = Buffer.from(req.data, 'base64');
        mime = req.mimeType || 'image/png';
        if (bytes.length === 0)
          return c.json({ error: 'Image base64 decoded to zero bytes.' }, 400);
      } else {
        return c.json({ error: 'Provide either artifactPath or data.' }, 400);
      }
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }

    const meta = readImageStaticMeta(bytes);
    const mode = req.mode === 'auto' ? resolveAutoMode(meta, filename) : req.mode;

    try {
      const result = await ctx.recognition.recognize({
        bytes,
        mimeType: mime,
        mode,
        ...(req.schema ? { schema: req.schema } : {}),
      });
      return c.json(result);
    } catch (err) {
      log.warn(`describe failed: ${String(err)}`);
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  /**
   * Deterministic file metadata, no model involved.
   *
   * `includeLocation` is the one path that surfaces GPS coordinates. It exists
   * so a gezel asked "where was this taken?" can answer, as a deliberate tool
   * call that lands in the history log — rather than location riding along in
   * every image digest.
   */
  app.post('/metadata', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = RecognitionRequestSchema.extend({
      includeLocation: z.boolean().optional(),
    }).safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const req = parsed.data;
    const projectId = c.req.query('project') ?? 'default';

    let bytes: Buffer;
    if (req.artifactPath) {
      const stripped = req.artifactPath.replace(/^artifacts\//, '');
      const found = await ctx.store.readProjectArtifactBinary(projectId, stripped);
      if (!found) return c.json({ error: `Image not found at artifacts/${stripped}` }, 404);
      bytes = found.data;
    } else if (req.data) {
      bytes = Buffer.from(req.data, 'base64');
    } else {
      return c.json({ error: 'Provide either artifactPath or data.' }, 400);
    }
    return c.json(readImageStaticMeta(bytes, { includeLocation: req.includeLocation === true }));
  });

  app.get('/health', async (c) => {
    try {
      return c.json(await ctx.recognition.health());
    } catch (err) {
      return c.json({ state: 'error', detail: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/catalog', (c) =>
    c.json({
      models: RECOGNITION_MODEL_CATALOG.map((m) => ({
        id: m.id,
        name: m.name,
        description: m.description,
        license: m.license,
        approxSizeBytes: m.approxSizeBytes,
        recoScore: m.recoScore,
      })),
    }),
  );

  app.get('/models', async (c) => {
    const provider = await ctx.recognition.current();
    return c.json({ models: await provider.listInstalledModels() });
  });

  app.post('/models/:id/pull', async (c) => {
    const id = c.req.param('id');
    const entry = findRecognitionCatalogEntry(id);
    if (!entry) return c.json({ error: `unknown recognition model: ${id}` }, 404);
    return streamSSE(c, async (stream) => {
      try {
        const provider = await ctx.recognition.current();
        for await (const event of provider.pullModel(id, entry.spec)) {
          await stream.writeSSE({ data: JSON.stringify(event) });
          if (event.type === 'done' || event.type === 'error') {
            if (event.type === 'error') {
              await stream.writeSSE({ data: JSON.stringify({ type: 'done', id }) });
            }
            return;
          }
        }
      } catch (err) {
        await stream.writeSSE({
          data: JSON.stringify({
            type: 'error',
            error: err instanceof Error ? err.message : String(err),
          }),
        });
        await stream.writeSSE({ data: JSON.stringify({ type: 'done', id }) });
      }
    });
  });

  app.delete('/models/:id', async (c) => {
    const id = c.req.param('id');
    if (!isSafeModelId(id)) {
      return c.json({ error: INVALID_MODEL_ID_MESSAGE, code: INVALID_MODEL_ID_CODE }, 400);
    }
    const provider = await ctx.recognition.current();
    await provider.deleteModel(id);
    // The engine may be holding the deleted weights open.
    await ctx.recognition.reset();
    return c.json({ ok: true });
  });

  app.post('/cache/clear', async (c) => {
    await ctx.recognition.clearCache();
    return c.json({ ok: true });
  });

  return app;
}
