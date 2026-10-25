import {
  type AppEnsureEvent,
  type AppImageGenerationEvent,
  AppImageGenerationRequestSchema,
  type AppImageModel,
  type GezelConfig,
  type ImageModelManifest,
  type ImageModelPullEvent,
  createLogger,
  imageModelDefaultSide,
  resolveImageSize,
} from '@bendyline/gezel';
import type { CatalogService } from '@bendyline/gezel-catalog';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { imageCatalogFits, imageModelFit, wontRunRefusal } from '../../models/image-fit.js';
import {
  ReadOnlyModelError,
  modelExistsOnlyReadOnly,
  modelStorageRoots,
} from '../../models/storage-roots.js';
import { NoLocalImageModelError } from '../../providers/image/local-factory.js';
import type {
  ActiveImagePull,
  ImageModelPullRegistry,
} from '../../providers/image/pull-registry.js';
import {
  ImageCapacityError,
  ImageGenerationCancelledError,
  type ImageGenerationProgress,
  type ImageProvider,
} from '../../providers/image/types.js';

const log = createLogger('v1-images');

/** The one local image engine this host serves. */
const ENGINE = 'sd-cpp';

export interface ImagesRouteContext {
  home: string;
  catalog: CatalogService;
  store: { readConfig(): Promise<GezelConfig> };
  images: {
    /** Whether an engine can render here at all. */
    available(): boolean;
    current(): Promise<ImageProvider>;
    /** Stop the engine, draining renders, before its model files change. */
    reset(): Promise<void>;
    pulls: ImageModelPullRegistry;
  };
}

const EnsureRequestSchema = z.object({ model: z.string().min(1, 'model is required') });

function apiError(code: string, message: string) {
  return { error: { message, type: 'invalid_request_error', code } };
}

/** `sd-cpp:<id>` or a bare `<id>`; null for another engine's id. */
function catalogIdOf(model: string): string | null {
  const trimmed = model.trim();
  const colon = trimmed.indexOf(':');
  if (colon < 0) return trimmed || null;
  if (trimmed.slice(0, colon) !== ENGINE) return null;
  return trimmed.slice(colon + 1).trim() || null;
}

function qualified(catalogId: string): string {
  return `${ENGINE}:${catalogId}`;
}

function downloadBytes(manifest: ImageModelManifest): number {
  return (
    manifest.approxSizeBytes + manifest.auxiliaryFiles.reduce((n, f) => n + f.approxSizeBytes, 0)
  );
}

function describeManifest(manifest: ImageModelManifest): Partial<AppImageModel> {
  const license = manifest.licenseShortName ?? manifest.license;
  return {
    name: manifest.name,
    description: manifest.description,
    download_bytes: downloadBytes(manifest),
    ...(license ? { license } : {}),
    commercial_use: manifest.commercialUse,
    ...(manifest.rendersText !== undefined ? { renders_text: manifest.rendersText } : {}),
    ...(manifest.promptStyle ? { prompt_style: manifest.promptStyle } : {}),
    ...(manifest.hardwareTier ? { hardware_tier: manifest.hardwareTier } : {}),
    ...(manifest.minRamGB !== undefined ? { min_ram_gb: manifest.minRamGB } : {}),
    ...(manifest.widthRange ? { width_range: manifest.widthRange } : {}),
    ...(manifest.heightRange ? { height_range: manifest.heightRange } : {}),
    default_side_px: imageModelDefaultSide(manifest.id),
    ...(manifest.supportsImg2Img !== undefined
      ? { supports_img2img: manifest.supportsImg2Img }
      : {}),
  };
}

function ensureEvent(
  jobId: string,
  event: ImageModelPullEvent,
  totalBytes: number,
): AppEnsureEvent {
  const job = { jobId, modelId: qualified(jobId) };
  switch (event.type) {
    case 'progress':
      return {
        ...job,
        type: 'progress',
        bytesWritten: event.bytesWritten,
        totalBytes: event.totalBytes ?? totalBytes,
      };
    case 'retrying':
      return {
        ...job,
        type: 'retrying',
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
        delayMs: event.delayMs,
        reason: event.reason,
      };
    case 'error':
      return { ...job, type: 'error', error: event.error };
    case 'done':
      return { ...job, type: 'done' };
  }
}

function pullStatus(pull: ActiveImagePull): 'running' | 'done' | 'error' {
  if (!pull.finished) return 'running';
  return pull.error ? 'error' : 'done';
}

function generationError(err: unknown): { code: string; message: string } {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof ImageGenerationCancelledError) return { code: 'cancelled', message };
  if (err instanceof ImageCapacityError) return { code: err.code, message };
  if (err instanceof NoLocalImageModelError) return { code: err.code, message };
  const code = (err as { code?: unknown } | null)?.code;
  if (code === 'capacity-denied') return { code: 'capacity_denied', message };
  return { code: 'image_generation_failed', message };
}

/**
 * `/v1/images/*` — local image generation for apps.
 *
 *   GET    /models                   Installed and downloadable image models,
 *                                    with this machine's fit. Never part of
 *                                    `/v1/models`, so chat pickers never
 *                                    offer them.
 *   POST   /models/ensure            `{model: "sd-cpp:<id>"}` → ready, or a
 *                                    background download (`job_id`).
 *   GET    /models/ensure/:jobId     Snapshot of a download.
 *   GET    /models/ensure/:jobId/events
 *                                    SSE of `AppEnsureEvent`s, closing after
 *                                    `done` or `error`. Disconnecting does
 *                                    not cancel the download.
 *   DELETE /models/ensure/:jobId     Cancel the download; a later ensure
 *                                    resumes it.
 *   DELETE /models/:id               Remove an installed model. A shared
 *                                    model belongs to another store: 409.
 *   POST   /generations              SSE of `AppImageGenerationEvent`s:
 *                                    progress, then one `done` (the PNG) or
 *                                    `error`. Closing the stream cancels the
 *                                    render, which stops the engine.
 */
export function v1ImagesRoutes(ctx: ImagesRouteContext): Hono {
  const app = new Hono();
  const fitContext = { catalog: ctx.catalog, readConfig: () => ctx.store.readConfig() };

  app.get('/models', async (c) => {
    const provider = await ctx.images.current();
    const [installed, items, fits] = await Promise.all([
      provider.listInstalledModels(),
      ctx.catalog.list('image-model'),
      imageCatalogFits(fitContext).catch((error) => {
        log.warn(`[v1-images] fit assessment failed: ${String(error)}`);
        return null;
      }),
    ]);
    const storageRoots = modelStorageRoots({ home: ctx.home, engine: ENGINE });
    const installedIds = new Set(installed.map((m) => m.id));
    const fitById = new Map(fits?.models.map((m) => [m.id, m]) ?? []);
    const downloading = new Set(
      ctx.images.pulls
        .list()
        .filter((p) => !p.finished)
        .map((p) => p.id),
    );
    const data: AppImageModel[] = [];
    const seen = new Set<string>();
    for (const item of items) {
      const manifest = item.manifest;
      if (manifest.kind !== 'image-model') continue;
      seen.add(manifest.id);
      const fit = fitById.get(manifest.id);
      const isInstalled = installedIds.has(manifest.id);
      data.push({
        id: qualified(manifest.id),
        object: 'image_model',
        ...describeManifest(manifest),
        name: manifest.name,
        availability: isInstalled
          ? 'available'
          : downloading.has(manifest.id)
            ? 'downloading'
            : 'download-required',
        ...(isInstalled && (await modelExistsOnlyReadOnly(storageRoots, manifest.id))
          ? { shared: true }
          : {}),
        ...(fit ? { fit: { verdict: fit.verdict, reason: fit.reason } } : {}),
      });
    }
    // Installed models the catalog no longer lists still render.
    for (const model of installed) {
      if (seen.has(model.id)) continue;
      data.push({
        id: qualified(model.id),
        object: 'image_model',
        name: model.name,
        availability: 'available',
        ...((await modelExistsOnlyReadOnly(storageRoots, model.id)) ? { shared: true } : {}),
        ...(model.supportsImg2Img !== undefined ? { supports_img2img: model.supportsImg2Img } : {}),
      });
    }
    return c.json({ object: 'list', data });
  });

  app.post('/models/ensure', async (c) => {
    const { model } = EnsureRequestSchema.parse(await c.req.json());
    const id = catalogIdOf(model);
    if (!id) {
      return c.json(apiError('unsupported_backend', `Image models are ${ENGINE}:<id>`), 400);
    }
    const provider = await ctx.images.current();
    const installed = await provider.listInstalledModels();
    if (installed.some((m) => m.id === id)) {
      return c.json({ status: 'ready', model_id: qualified(id) });
    }
    const refusal = await wontRunRefusal(() => imageModelFit(fitContext, id));
    if (refusal) return c.json(apiError(refusal.code, refusal.error), 409);
    try {
      await ctx.images.pulls.start(id);
    } catch (error) {
      if ((error as Error).name === 'UnknownImageModelError') {
        return c.json(apiError('unknown_model', `No image model ${model} in the catalog`), 404);
      }
      throw error;
    }
    return c.json({ status: 'downloading', model_id: qualified(id), job_id: id }, 202);
  });

  app.get('/models/ensure/:jobId', (c) => {
    const pull = ctx.images.pulls.get(c.req.param('jobId'));
    if (!pull) return c.json(apiError('job_not_found', 'job not found'), 404);
    return c.json({
      job_id: pull.id,
      model_id: qualified(pull.id),
      status: pullStatus(pull),
      started_at: Date.parse(pull.startedAt),
      bytes_written: pull.bytesWritten,
      total_bytes: pull.totalBytes,
      ...(pull.error ? { error: pull.error } : {}),
    });
  });

  app.get('/models/ensure/:jobId/events', (c) => {
    const jobId = c.req.param('jobId');
    const snapshot = ctx.images.pulls.get(jobId);
    if (!snapshot) return c.json(apiError('job_not_found', 'job not found'), 404);
    return streamSSE(c, async (stream) => {
      let closed = false;
      let sawError = false;
      const unsubscribe = ctx.images.pulls.subscribe(jobId, (event) => {
        // A failed pull ends with an error and then its done; the error is terminal.
        if (sawError) return;
        if (event.type === 'error') sawError = true;
        const terminal = event.type === 'done' || event.type === 'error';
        void stream
          .writeSSE({ data: JSON.stringify(ensureEvent(jobId, event, snapshot.totalBytes)) })
          .then(() => {
            if (terminal) closed = true;
          })
          .catch(() => {
            closed = true;
          });
      });
      if (!unsubscribe) return;
      stream.onAbort(() => {
        closed = true;
        unsubscribe();
      });
      while (!closed) {
        await stream.sleep(1000);
        try {
          await stream.writeSSE({ event: 'ping', data: '' });
        } catch {
          closed = true;
        }
      }
      unsubscribe();
    });
  });

  app.delete('/models/ensure/:jobId', (c) => {
    if (!ctx.images.pulls.cancel(c.req.param('jobId'))) {
      return c.json(apiError('job_not_found', 'No download in progress for that job'), 404);
    }
    return c.json({ cancelled: true });
  });

  app.delete('/models/:id', async (c) => {
    const id = catalogIdOf(decodeURIComponent(c.req.param('id')));
    if (!id) return c.json(apiError('unsupported_backend', `Image models are ${ENGINE}:<id>`), 400);
    const storageRoots = modelStorageRoots({ home: ctx.home, engine: ENGINE });
    if (await modelExistsOnlyReadOnly(storageRoots, id)) {
      return c.json(
        apiError('shared_model', 'This model is shared from another store and is not removed here'),
        409,
      );
    }
    // The engine may hold the model's files open.
    await ctx.images.reset();
    try {
      await (await ctx.images.current()).deleteModel(id);
    } catch (error) {
      if (error instanceof ReadOnlyModelError) {
        return c.json(apiError('shared_model', error.message), 409);
      }
      throw error;
    }
    return c.body(null, 204);
  });

  app.post('/generations', async (c) => {
    const request = AppImageGenerationRequestSchema.parse(await c.req.json());
    if (!ctx.images.available()) {
      return c.json(
        apiError('images_unavailable', 'Image generation is not available on this computer'),
        503,
      );
    }
    const provider = await ctx.images.current();
    const installed = await provider.listInstalledModels();
    const requested = request.model ? catalogIdOf(request.model) : undefined;
    if (request.model && !requested) {
      return c.json(apiError('unsupported_backend', `Image models are ${ENGINE}:<id>`), 400);
    }
    const modelId = requested ?? (await provider.resolveDefaultModelId?.());
    if (!modelId || !installed.some((m) => m.id === modelId)) {
      const error = requested
        ? apiError('model_not_installed', `${request.model} is not installed; ensure it first`)
        : apiError('no_local_image_model', new NoLocalImageModelError().message);
      return c.json(error, 409);
    }
    const item = await ctx.catalog.get('image-model', modelId).catch(() => null);
    const manifest = item?.manifest.kind === 'image-model' ? item.manifest : undefined;
    const { width, height } = resolveImageSize(
      {
        ...(request.aspect_ratio ? { aspectRatio: request.aspect_ratio } : {}),
        ...(request.quality ? { quality: request.quality } : {}),
      },
      {
        defaultSidePx: imageModelDefaultSide(modelId),
        ...(manifest?.widthRange ? { widthRange: manifest.widthRange } : {}),
        ...(manifest?.heightRange ? { heightRange: manifest.heightRange } : {}),
      },
    );

    return streamSSE(c, async (stream) => {
      const controller = new AbortController();
      const cancel = () => controller.abort();
      stream.onAbort(cancel);
      c.req.raw.signal.addEventListener('abort', cancel, { once: true });
      const send = (event: AppImageGenerationEvent) =>
        stream.writeSSE({ data: JSON.stringify(event) }).catch(cancel);
      let last = '';
      const onProgress = (progress: ImageGenerationProgress) => {
        const event: AppImageGenerationEvent = {
          type: 'progress',
          phase: progress.phase ?? 'sampling',
          step: progress.step,
          total_steps: progress.totalSteps,
          ...(progress.secondsPerStep ? { seconds_per_step: progress.secondsPerStep } : {}),
        };
        const key = JSON.stringify(event);
        if (key === last) return;
        last = key;
        void send(event);
      };
      try {
        const out = await provider.generate({
          prompt: request.prompt,
          ...(request.negative_prompt ? { negativePrompt: request.negative_prompt } : {}),
          model: modelId,
          width,
          height,
          ...(request.seed !== undefined ? { seed: request.seed } : {}),
          signal: controller.signal,
          onProgress,
        });
        await send({
          type: 'done',
          b64_png: out.png.toString('base64'),
          width: out.meta.widthPx,
          height: out.meta.heightPx,
          seed: out.meta.seed,
          model: qualified(out.meta.model),
          steps: out.meta.steps,
          duration_ms: out.meta.durationMs,
        });
      } catch (error) {
        if (!controller.signal.aborted) {
          log.warn(`[v1-images] generation failed: ${String(error)}`);
        }
        await send({ type: 'error', error: generationError(error) });
      } finally {
        c.req.raw.signal.removeEventListener('abort', cancel);
      }
    });
  });

  return app;
}
