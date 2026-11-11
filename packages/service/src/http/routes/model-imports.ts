import { Readable } from 'node:stream';
import {
  ModelImportConfirmRequestSchema,
  ModelImportReviewRequestSchema,
  createLogger,
} from '@bendyline/gezel';
import { machineEngineProxy } from '@bendyline/gezel-inference/internal/http/routes/machine-engine-proxy';
import {
  HubRequestError,
  HuggingFaceModelImporter,
} from '@bendyline/gezel-inference/internal/models/imports/importer';
import { LocalModelImports } from '@bendyline/gezel-inference/internal/models/imports/local-files';
import { Hono } from 'hono';
import type { EngineContext } from '../engine-context.js';
import { invalidateModelsCache } from './models.js';

const log = createLogger('model-import');

type ImportStatus = 400 | 403 | 404 | 409 | 413 | 422 | 429 | 502;
const KNOWN_STATUSES: readonly number[] = [400, 403, 404, 409, 413, 422, 429];

/** HTTP status for an import failure; a Hub error carries its own. */
function importFailure(err: unknown): { status: ImportStatus; error: string } {
  if (err instanceof HubRequestError) {
    const status = KNOWN_STATUSES.includes(err.status) ? (err.status as ImportStatus) : 502;
    return { status, error: err.message };
  }
  const message = err instanceof Error ? err.message : String(err);
  log.warn(`[model-import] failed: ${message}`);
  return { status: 502, error: message };
}

/**
 * Models from outside the catalog: a Hugging Face GGUF or MLX repo, or GGUF
 * files sent from this computer. Mounted at `/api/model-imports` and, on the
 * machine broker, `/v1/remote/manage/model-imports`, so the daemon that owns
 * the model store answers. Contract in docs/model-imports.md.
 */
export function modelImportRoutes(ctx: EngineContext): Hono {
  const app = new Hono();
  app.use('*', machineEngineProxy(ctx, '/api/model-imports', '/v1/remote/manage/model-imports'));

  const hub = new HuggingFaceModelImporter({
    home: ctx.home,
    catalog: ctx.catalog,
    llamaCppModels: ctx.llamaCppModels,
    mlxModels: ctx.mlxModels,
  });
  const local = new LocalModelImports({
    home: ctx.home,
    catalog: ctx.catalog,
    llamaCppModels: ctx.llamaCppModels,
  });

  const fail = (c: { json: (body: unknown, status: ImportStatus) => Response }, err: unknown) => {
    const { status, error } = importFailure(err);
    return c.json({ error }, status);
  };

  /** Review a Hugging Face model before anything downloads. Writes nothing. */
  app.post('/review', async (c) => {
    const parsed = ModelImportReviewRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json(
        { error: 'Send a Hugging Face link, or a model name like owner/model-GGUF.' },
        400,
      );
    }
    try {
      return c.json(await hub.review(parsed.data));
    } catch (err) {
      return fail(c, err);
    }
  });

  /**
   * Record one reviewed Hugging Face model so the engine's install route can
   * fetch it. Re-checks the review at the pinned commit and refuses a failing one.
   */
  app.post('/confirm', async (c) => {
    const parsed = ModelImportConfirmRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: 'That review is not valid. Review the model again.' }, 400);
    }
    try {
      const result = await hub.confirm(parsed.data);
      invalidateModelsCache(result.engine);
      return c.json(result);
    } catch (err) {
      return fail(c, err);
    }
  });

  /** Start sending GGUF files from this computer. */
  app.post('/local', async (c) => {
    try {
      return c.json(await local.create(), 201);
    } catch (err) {
      return fail(c, err);
    }
  });

  /** One file's bytes, streamed as the request body. */
  app.put('/local/:importId/files/:name', async (c) => {
    const body = c.req.raw.body;
    if (!body) return c.json({ error: 'The file arrived empty.' }, 400);
    try {
      const file = await local.receive(
        c.req.param('importId'),
        c.req.param('name'),
        Readable.fromWeb(body as import('node:stream/web').ReadableStream<Uint8Array>),
        { signal: c.req.raw.signal },
      );
      return c.json(file, 201);
    } catch (err) {
      return fail(c, err);
    }
  });

  /** What has arrived so far, for a progress bar. */
  app.get('/local/:importId', async (c) => {
    try {
      return c.json(await local.status(c.req.param('importId')));
    } catch (err) {
      return fail(c, err);
    }
  });

  app.post('/local/:importId/review', async (c) => {
    try {
      return c.json(await local.review(c.req.param('importId')));
    } catch (err) {
      return fail(c, err);
    }
  });

  /** Publish the received files as the model. Nothing downloads. */
  app.post('/local/:importId/confirm', async (c) => {
    try {
      const result = await local.confirm(c.req.param('importId'));
      invalidateModelsCache('llama-cpp');
      return c.json(result);
    } catch (err) {
      return fail(c, err);
    }
  });

  app.delete('/local/:importId', async (c) => {
    try {
      await local.cancel(c.req.param('importId'));
      return c.json({ ok: true });
    } catch (err) {
      return fail(c, err);
    }
  });

  return app;
}
