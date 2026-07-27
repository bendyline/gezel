import { type GezelConfig, createLogger } from '@bendyline/gezel';
import { Hono } from 'hono';
import type { SSEStreamingApi } from 'hono/streaming';
import { streamSSE } from 'hono/streaming';
import type { InstallEvent } from '../../providers/llama-cpp/models.js';
import { decideAutoInstall } from '../../providers/recognition/auto-install.js';
import type { ServiceContext } from '../context.js';
import { invalidateModelsCache } from './models.js';

const log = createLogger('llama-cpp');

/**
 * Pull an image reader alongside a chat model that can't see images, and
 * report its progress on the same stream.
 *
 * A failure here is logged and surfaced as a `companion` error, never as an
 * install failure: the chat model the user actually asked for is already on
 * disk and working.
 */
async function streamCompanionRecognition(
  ctx: ServiceContext,
  catalogId: string,
  config: GezelConfig | null,
  stream: SSEStreamingApi,
): Promise<void> {
  if (!config) return;
  let decision: Awaited<ReturnType<typeof decideAutoInstall>> = null;
  try {
    decision = await decideAutoInstall({
      home: ctx.home,
      config,
      catalogId,
      llamaCppModels: ctx.llamaCppModels,
      recognition: ctx.recognition,
    });
  } catch (err) {
    log.warn(`image-reader auto-install check failed: ${String(err)}`);
    return;
  }
  if (!decision) return;

  const { entry } = decision;
  log.info(`auto-installing image reader ${entry.id} — ${decision.reason}`);
  const send = (extra: Partial<Extract<InstallEvent, { type: 'companion' }>>) =>
    stream.writeSSE({
      data: JSON.stringify({
        type: 'companion',
        kind: 'image-recognition',
        id: entry.id,
        name: entry.name,
        bytesWritten: 0,
        totalBytes: entry.approxSizeBytes,
        ...extra,
      }),
    });

  try {
    await send({});
    const provider = await ctx.recognition.current();
    for await (const event of provider.pullModel(entry.id, entry.spec)) {
      if (event.type === 'progress') {
        await send({
          bytesWritten: event.bytesWritten,
          totalBytes: event.totalBytes ?? entry.approxSizeBytes,
        });
      } else if (event.type === 'error') {
        await send({ error: event.error });
        return;
      }
    }
    await send({ bytesWritten: entry.approxSizeBytes });
    // The engine picks up the newly-installed weights on its next start.
    await ctx.recognition.reset();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`image-reader auto-install failed: ${message}`);
    await send({ error: message }).catch(() => {});
  }
}

/**
 * llama.cpp local model management — install / list / delete GGUF
 * models from the bundled chat-model catalog. The provider itself
 * (chat) lives in `chat-events.ts`; this file only deals with
 * sourcing the weights from Hugging Face.
 *
 * Mounted under `/api/llama-cpp` from `http/server.ts`.
 */
export function llamaCppRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  app.get('/models', async (c) => {
    const models = await ctx.llamaCppModels.listInstalled();
    return c.json({ models });
  });

  /**
   * Polled snapshot of installs currently running. Both the user-
   * triggered install (from Settings) and the first-run bootstrap
   * funnel through `LlamaCppModelManager.install()`, which registers
   * each in-flight catalog id here. The Settings catalog view polls
   * this endpoint so a background-driven install (the bootstrap one)
   * lights up the same progress bar a click-driven install would
   * have shown via SSE.
   */
  app.get('/active-installs', (c) => {
    return c.json({ installs: ctx.llamaCppModels.getActiveInstalls() });
  });

  /**
   * Install a chat-model entry's llama.cpp source. SSE-streams the
   * progress events the model manager yields so the UI can render a
   * live progress bar with sha256-verify and metadata-extract phases
   * called out separately.
   */
  app.post('/models/:catalogId/install', async (c) => {
    const catalogId = c.req.param('catalogId');
    // `?skipSha=1` bypasses sha256 verification — the UI sends this on
    // the user's explicit "Download anyway" retry after they've seen a
    // catalog-vs-Hugging-Face mismatch banner. Any non-empty value
    // other than 'false'/'0' is treated as truthy.
    const skipShaRaw = c.req.query('skipSha');
    const skipSha =
      skipShaRaw != null && skipShaRaw !== '' && skipShaRaw !== '0' && skipShaRaw !== 'false';
    // Only fetch the vision projector when the user has opted this model into
    // native image support. Re-running the install after flipping the toggle
    // picks up just the missing file — completed files are skipped.
    const config = await ctx.store.readConfig().catch(() => null);
    const includeMmproj = config?.nativeVision?.[catalogId] === true;
    return streamSSE(c, async (stream) => {
      try {
        // The chat model's own `done` is held back until any companion pull
        // finishes — the UI treats `done` as terminal and would close the
        // stream while the image reader was still downloading.
        let finished: InstallEvent | null = null;
        for await (const event of ctx.llamaCppModels.install(catalogId, {
          skipSha,
          includeMmproj,
        })) {
          if (event.type === 'done') {
            finished = event;
            continue;
          }
          await stream.writeSSE({ data: JSON.stringify(event) });
        }
        // listModels caches per-provider results — bust the llama-cpp
        // entry so the next /api/models call picks up the new install.
        invalidateModelsCache('llama-cpp');

        if (finished) {
          await streamCompanionRecognition(ctx, catalogId, config, stream);
          await stream.writeSSE({ data: JSON.stringify(finished) });
        }
      } catch (err) {
        await stream.writeSSE({
          data: JSON.stringify({
            type: 'error',
            error: err instanceof Error ? err.message : String(err),
          }),
        });
      }
    });
  });

  app.delete('/models/:id', async (c) => {
    const id = c.req.param('id');
    try {
      await ctx.llamaCppModels.delete(id);
      invalidateModelsCache('llama-cpp');
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  /**
   * Tail the supervised llama-server's rolling log. Query param
   * `bytes` caps the returned tail (default 4096, max 65536). Returns
   * `{ path, tail }` — `path` is the absolute file path for the
   * settings UI to surface; `tail` is the trailing window of the
   * current day's file. Returns empty strings when the provider
   * hasn't been initialized or runs via an external baseUrl (no
   * supervised process, no log).
   */
  app.get('/log', async (c) => {
    const raw = c.req.query('bytes');
    const requested = raw ? Number.parseInt(raw, 10) : 4096;
    const bytes = Number.isFinite(requested) ? Math.min(Math.max(requested, 256), 65_536) : 4096;
    const provider = ctx.chat.getProviderIfReady('llama-cpp');
    // The provider exposes `getLogFile()`; use duck typing so this
    // route doesn't need to import LlamaCppProvider (keeps the route
    // agnostic of provider-internal types).
    const logFile = (
      provider as unknown as {
        getLogFile?: () => {
          tail: (n: number) => Promise<string>;
          currentFile: () => string | null;
        };
      } | null
    )?.getLogFile?.();
    if (!logFile) {
      return c.json({ path: null, tail: '' });
    }
    const tail = await logFile.tail(bytes);
    return c.json({ path: logFile.currentFile(), tail });
  });

  return app;
}
