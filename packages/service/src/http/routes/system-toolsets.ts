import type { SystemToolsetInstallEvent } from '@bendyline/gezel';
import { createLogger } from '@bendyline/gezel';
import { Hono } from 'hono';
import type { SSEStreamingApi } from 'hono/streaming';
import { streamSSE } from 'hono/streaming';
import { resetCopilotAvailabilityCache } from '../../providers/copilot-availability.js';
import { SystemToolsetInstallUnavailableError } from '../../system-toolsets/install-registry.js';
import { SYSTEM_TOOLSETS, isPlaceholder } from '../../system-toolsets/manifest.js';
import type { ServiceContext } from '../context.js';

const log = createLogger('system-toolsets-route');

/**
 * Routes for the system-toolset bootstrap and for on-demand installs:
 *
 *   GET    /api/system-toolsets/status                — current boot status
 *   GET    /api/system-toolsets/status/stream         — SSE stream of transitions
 *   GET    /api/system-toolsets/installs              — in-flight on-demand installs
 *   POST   /api/system-toolsets/:toolsetId/install    — SSE stream of one install
 *   DELETE /api/system-toolsets/:toolsetId/install    — cancel an in-flight install
 *
 * The UI's Home screen HealthPanel polls `/status` once on mount, then
 * subscribes to `/status/stream`. The Copilot settings tab drives
 * `/:toolsetId/install`.
 */
export function systemToolsetRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  app.get('/status', (c) => c.json(ctx.systemStatus.current));

  app.get('/status/stream', async (c) => {
    return streamSSE(c, async (stream) => {
      let closed = false;
      const unsubscribe = ctx.systemStatus.subscribe((status) => {
        if (closed) return;
        void stream.writeSSE({ data: JSON.stringify(status) }).catch(() => {
          /* stream closed */
        });
      });
      stream.onAbort(() => {
        closed = true;
        unsubscribe();
      });
      while (!closed) {
        await stream.sleep(5000);
        try {
          await stream.writeSSE({ event: 'ping', data: '' });
        } catch {
          closed = true;
        }
      }
      unsubscribe();
    });
  });

  app.get('/installs', (c) => c.json({ installs: ctx.systemToolsetInstalls.list() }));

  app.post('/:toolsetId/install', async (c) => {
    const toolsetId = c.req.param('toolsetId');
    // Restricting to `onDemand` entries is the security boundary: without it
    // this would be a general "install any pinned package right now" trigger
    // that could race the boot bootstrap over the same staging directory.
    const entry = SYSTEM_TOOLSETS.find((e) => e.toolsetId === toolsetId && e.onDemand === true);
    if (!entry) {
      return c.json({ error: `'${toolsetId}' is not an on-demand system toolset` }, 400);
    }
    if (isPlaceholder(entry)) {
      return c.json(
        {
          error: `This build has no real version pin for ${toolsetId}, so it cannot be installed.`,
        },
        503,
      );
    }

    let key: string;
    try {
      key = ctx.systemToolsetInstalls.ensure(entry).toolsetId;
    } catch (err) {
      // Answered before the stream opens: a store build's refusal is a
      // property of the build, so the client needs a status code it can act
      // on rather than an SSE stream that immediately errors.
      if (err instanceof SystemToolsetInstallUnavailableError) {
        return c.json({ error: 'unavailable_in_build', reason: err.message }, 403);
      }
      throw err;
    }
    return streamSSE(c, async (stream) => {
      await subscribeInstallSse(ctx, key, stream);
    });
  });

  app.delete('/:toolsetId/install', (c) => {
    const toolsetId = c.req.param('toolsetId');
    return c.json({ aborted: ctx.systemToolsetInstalls.cancel(toolsetId) });
  });

  return app;
}

/**
 * Relay one install's events to an SSE client until it terminates.
 *
 * Aborting the HTTP request only detaches this listener — the install is
 * owned by the registry and keeps running, which is what lets the user close
 * Settings mid-download and come back to live progress.
 */
async function subscribeInstallSse(
  ctx: ServiceContext,
  toolsetId: string,
  stream: SSEStreamingApi,
): Promise<void> {
  let done!: () => void;
  const finished = new Promise<void>((resolve) => {
    done = resolve;
  });
  // Serialize writes: `writeSSE` is async and the registry broadcasts
  // synchronously, so without a chain two events can interleave mid-frame.
  let writes: Promise<void> = Promise.resolve();
  let closed = false;

  const unsubscribe = ctx.systemToolsetInstalls.subscribe(toolsetId, (event) => {
    if (closed) return;
    writes = writes
      .then(() => stream.writeSSE({ data: JSON.stringify(event) }))
      .catch(() => {
        closed = true;
      });
    if (event.type === 'done' || event.type === 'error') {
      writes = writes.then(() => onTerminal(ctx, toolsetId, event)).finally(() => done());
    }
  });

  // The registry drops finished entries after a TTL, so `ensure` and this
  // subscribe can race on a fast failure.
  if (!unsubscribe) {
    await stream.writeSSE({
      data: JSON.stringify({
        type: 'error',
        error: 'install finished before the progress stream attached; re-check status',
      } satisfies SystemToolsetInstallEvent),
    });
    return;
  }

  stream.onAbort(() => {
    closed = true;
    unsubscribe();
    done();
  });

  await finished;
  unsubscribe();
  await writes.catch(() => {});
}

/**
 * Make a completed install take effect without a restart.
 *
 * `ChatManager` resolves the Copilot SDK path when it constructs the
 * provider, so evicting the cached one is all it takes for the next session
 * to pick up the new install.
 */
async function onTerminal(
  ctx: ServiceContext,
  toolsetId: string,
  event: SystemToolsetInstallEvent,
): Promise<void> {
  if (event.type !== 'done') return;
  resetCopilotAvailabilityCache();
  if (toolsetId !== '@github/copilot-sdk') return;
  try {
    await ctx.chat.evictProvider('copilot');
  } catch (err) {
    log.warn(
      `[system-toolsets] copilot provider eviction failed after install: ${
        err instanceof Error ? err.message : err
      }`,
    );
  }
}
