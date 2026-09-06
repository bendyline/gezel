import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  GezmodelEngineSchema,
  type GezmodelImportProgress,
  type GezmodelImportReview,
} from '@bendyline/gezel';
import { Hono } from 'hono';
import { z } from 'zod';
import { GezmodelManager } from '../../models/gezmodel.js';
import type { EngineContext } from '../engine-context.js';
import { machineEngineProxy } from './machine-engine-proxy.js';
import { invalidateModelsCache } from './models.js';

const SCAN_RESULT_TTL_MS = 10 * 60_000;

interface ActiveModelBundleScan {
  controller: AbortController;
  progress: GezmodelImportProgress;
  state: 'active' | 'complete' | 'error';
  review?: GezmodelImportReview;
  error?: string;
  settled?: Promise<void>;
}

/** Portable `.gezmodel` export + staged, review-before-publish import. */
export function modelBundleRoutes(ctx: EngineContext): Hono {
  const app = new Hono();
  app.use('*', machineEngineProxy(ctx, '/api/model-bundles', '/v1/remote/manage/model-bundles'));
  const bundles = new GezmodelManager({
    home: ctx.home,
    catalog: ctx.catalog,
    llamaCpp: ctx.llamaCppModels,
    mlx: ctx.mlxModels,
    ds4: ctx.ds4Models,
  });
  const activeScans = new Map<string, ActiveModelBundleScan>();

  app.get('/:engine/:id/export', async (c) => {
    try {
      const engine = GezmodelEngineSchema.parse(c.req.param('engine'));
      const bundle = await bundles.export(engine, c.req.param('id'));
      c.header('Content-Type', 'application/vnd.gezel.model+zip');
      c.header('Content-Disposition', `attachment; filename="${bundle.filename}"`);
      c.header('X-Gezel-Model-Bytes', String(bundle.manifest.approxSizeBytes));
      c.header('X-Content-Type-Options', 'nosniff');
      return c.body(Readable.toWeb(bundle.stream as Readable) as ReadableStream<Uint8Array>);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post('/imports/scan', async (c) => {
    const body = c.req.raw.body;
    if (!body) return c.json({ error: 'empty model bundle upload' }, 400);
    const requestedId = c.req.header('x-gezel-import-id');
    const parsedId = z
      .string()
      .uuid()
      .safeParse(requestedId ?? randomUUID());
    if (!parsedId.success) return c.json({ error: 'invalid model bundle import id' }, 400);
    const importId = parsedId.data;
    if (activeScans.has(importId)) {
      return c.json({ error: 'model bundle import is already active' }, 409);
    }
    const declaredBytes = Number(c.req.header('x-gezel-upload-bytes'));
    const bytesTotal =
      Number.isSafeInteger(declaredBytes) && declaredBytes >= 0 ? declaredBytes : undefined;
    const respondAsync = c.req
      .header('prefer')
      ?.split(',')
      .some((item) => item.trim() === 'respond-async');
    const controller = new AbortController();
    const active: ActiveModelBundleScan = {
      controller,
      state: 'active',
      progress: {
        phase: 'receiving' as const,
        bytesCompleted: 0,
        ...(bytesTotal === undefined ? {} : { bytesTotal }),
      },
    };
    activeScans.set(importId, active);
    const abortFromRequest = () => controller.abort(c.req.raw.signal.reason);
    c.req.raw.signal.addEventListener('abort', abortFromRequest, { once: true });
    let uploadComplete!: () => void;
    const uploaded = new Promise<void>((resolve) => {
      uploadComplete = resolve;
    });
    const scan = bundles.scanUpload(
      Readable.fromWeb(body as import('node:stream/web').ReadableStream<Uint8Array>),
      {
        importId,
        bytesTotal,
        signal: controller.signal,
        onProgress: (progress) => {
          active.progress = progress;
        },
        onUploadComplete: uploadComplete,
      },
    );
    active.settled = scan.then(
      () => undefined,
      () => undefined,
    );

    if (!respondAsync) {
      try {
        const review = await scan;
        return c.json(review, 201);
      } catch (err) {
        return c.json({ error: scanError(err) }, 400);
      } finally {
        c.req.raw.signal.removeEventListener('abort', abortFromRequest);
        if (activeScans.get(importId) === active) activeScans.delete(importId);
      }
    }

    void scan.then(
      (review) => {
        if (activeScans.get(importId) !== active) return;
        active.state = 'complete';
        active.review = review;
        expireScanResult(activeScans, importId, active);
      },
      (err) => {
        if (activeScans.get(importId) !== active) return;
        active.state = 'error';
        active.error = scanError(err);
        expireScanResult(activeScans, importId, active);
      },
    );
    try {
      // Keep the upload request alive only while bytes are arriving. Once the
      // private archive is staged, release Chromium's request and let the
      // client follow the long checksum pass through the progress resource.
      await Promise.race([uploaded, scan]);
      return c.json({ importId }, 202, { 'Preference-Applied': 'respond-async' });
    } catch (err) {
      if (activeScans.get(importId) === active) activeScans.delete(importId);
      return c.json({ error: scanError(err) }, 400);
    } finally {
      c.req.raw.signal.removeEventListener('abort', abortFromRequest);
    }
  });

  app.get('/imports/:importId/progress', (c) => {
    const importId = c.req.param('importId');
    const active = activeScans.get(importId);
    if (!active) return c.json({ error: 'model bundle import is not active' }, 404);
    if (active.state === 'complete' && active.review) {
      activeScans.delete(importId);
      return c.json({ status: 'complete' as const, review: active.review });
    }
    if (active.state === 'error') {
      activeScans.delete(importId);
      return c.json({
        status: 'error' as const,
        error: active.error ?? 'model bundle scan failed',
      });
    }
    return c.json({ status: 'active' as const, progress: active.progress });
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
      const importId = c.req.param('importId');
      const active = activeScans.get(importId);
      if (active) {
        activeScans.delete(importId);
        active.controller.abort();
        await active.settled;
        await bundles.cancelImport(importId);
      } else await bundles.cancelImport(importId);
      return c.json({ ok: true as const });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  return app;
}

function scanError(error: unknown): string {
  return `model bundle failed security scan: ${error instanceof Error ? error.message : String(error)}`;
}

function expireScanResult(
  scans: Map<string, ActiveModelBundleScan>,
  importId: string,
  scan: ActiveModelBundleScan,
): void {
  const timer = setTimeout(() => {
    if (scans.get(importId) === scan) scans.delete(importId);
  }, SCAN_RESULT_TTL_MS);
  timer.unref();
}
