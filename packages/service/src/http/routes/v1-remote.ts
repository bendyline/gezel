/**
 * `/v1/remote/*` — Device B's inference-only surface for paired clients. Gated
 * by the `remote-inference` scope; touches ONLY provider managers, never
 * projects/sessions/fs (a remote token gets 403 on every `/api/*` route).
 *
 * `POST /v1/remote/infer` runs ONE stateless chat forward-pass: it builds a
 * session in external-tools capture mode (no local bridge — B never executes
 * tools), runs it through B's existing provider + ProviderQueue, and streams
 * gezel-native SSE frames. The agentic loop lives on A, which re-POSTs with the
 * tool results. B persists nothing for the client.
 */

import { createLogger } from '@bendyline/gezel';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { ResolvedTuning } from '../../model-profile/index.js';
import {
  PROTOCOL_VERSION,
  RemoteAdmissionRequestSchema,
  RemoteCacheEvictRequestSchema,
  RemoteCacheWarmRequestSchema,
  RemoteImageGenRequestSchema,
  RemoteInferRequestSchema,
  type RemoteModelDescriptor,
  RemoteSynthesizeRequestSchema,
  RemoteTranscribeRequestSchema,
  RemoteVideoGenRequestSchema,
  type WireQueueHints,
} from '../../providers/remote/wire.js';
import {
  ExternalToolsUnsupportedError,
  type LLMProvider,
  type LLMSession,
  ModelNotInstalledError,
  type TurnUsage,
} from '../../providers/types.js';
import { type TenantLimiter, createTenantLimiter } from '../../remotes/tenant-limits.js';
import type { ServiceContext } from '../context.js';
import { resolveModelTarget } from '../openai-compat/translate.js';

const log = createLogger('remote-cache');

/**
 * Namespace the client's affinity keys by its authenticated origin device, so
 * one tenant's prompt-cache prefix can never be served to another and two
 * tenants' identical sessionIds don't collide in B's queue.
 */
function namespaceRemoteId(value: string, originDeviceId: string): string {
  return `dev:${originDeviceId}:${value}`;
}

function mapWireQueueToB(
  q: WireQueueHints,
  originDeviceId: string,
  signal: AbortSignal,
  lane: 'interactive' | 'background',
) {
  const ns = (v: string) => namespaceRemoteId(v, originDeviceId);
  return {
    lane,
    ...(q.sessionId ? { sessionId: ns(q.sessionId) } : {}),
    ...(q.gezelId ? { gezelId: ns(q.gezelId) } : {}),
    ...(q.projectId ? { projectId: ns(q.projectId) } : {}),
    ...(q.actorLabel ? { actorLabel: q.actorLabel } : {}),
    ...(q.job ? { job: q.job } : {}),
    affinity: q.affinity,
    signal,
  };
}

/**
 * Effective queue lane for a remote turn, per the server's policy:
 *   below-local → background (the owner's local turns always drain first)
 *   above-local → interactive (remote favored)
 *   equal/undefined → the client's requested lane
 */
function effectiveLane(
  requested: 'interactive' | 'background',
  priority: 'equal' | 'below-local' | 'above-local' | undefined,
): 'interactive' | 'background' {
  if (priority === 'below-local') return 'background';
  if (priority === 'above-local') return 'interactive';
  return requested;
}

/** Local chat engines B can serve to paired clients. */
const REMOTE_CHAT_PROVIDERS = ['llama-cpp', 'mlx', 'ds4', 'ollama'] as const;

function residentBaseUrl(provider: LLMProvider): string | null {
  if (provider.name === 'llama-cpp' || provider.name === 'mlx') {
    return (
      provider as LLMProvider & {
        currentBaseUrl(): string | null;
      }
    ).currentBaseUrl();
  }
  if (provider.name === 'ds4') {
    return (
      provider as LLMProvider & {
        llamaCpp: { currentBaseUrl(): string | null };
      }
    ).llamaCpp.currentBaseUrl();
  }
  return null;
}

async function prewarmRemoteCache(
  ctx: ServiceContext,
  body: ReturnType<typeof RemoteCacheWarmRequestSchema.parse>,
  originDeviceId: string,
): Promise<void> {
  const target = resolveModelTarget(body.model);
  if (!target || !['llama-cpp', 'mlx', 'ds4'].includes(target.provider)) return;
  // Session focus must never start a cold multi-GB engine. A warm only uses a
  // process that is already resident; the next real turn remains responsible
  // for normal lazy startup.
  const provider = ctx.chat
    .peekResidentLocalProviders(target.provider, target.model)
    .find((candidate) => residentBaseUrl(candidate));
  if (!provider) return;
  const queue = provider.queue?.snapshot();
  if (queue && queue.running + queue.queuedInteractive + queue.queuedBackground > 0) {
    return;
  }
  const session = await provider.createSession({
    systemMessage: body.systemMessage,
    model: target.model,
    priorMessages: body.priorMessages,
    ...(body.systemPromptLayers ? { systemPromptLayers: body.systemPromptLayers } : {}),
    ...(body.volatileContext ? { volatileContext: body.volatileContext } : {}),
    ...(body.tools && body.tools.length > 0 ? { externalTools: body.tools } : {}),
    ...(body.tuning ? { tuning: body.tuning as unknown as ResolvedTuning } : {}),
  });
  try {
    await session.prefillOnly?.({
      sessionId: namespaceRemoteId(body.sessionId, originDeviceId),
    });
  } finally {
    await session.disconnect().catch(() => {});
  }
}

export function v1RemoteRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  // Per-tenant admission gate, built lazily on first use from the server's
  // configured limits. Persists across requests (in-memory counters).
  let limiter: TenantLimiter | null = null;
  const getLimiter = async (): Promise<TenantLimiter> => {
    if (!limiter) {
      const cfg =
        ctx.serviceRole === 'machine-engine'
          ? null
          : await ctx.store.readConfig().catch(() => null);
      limiter = createTenantLimiter(cfg?.remoteServing?.limits);
    }
    return limiter;
  };

  // Inference-only model discovery: what this server will run for clients.
  // No project/session state — pure capability enumeration.
  app.get('/models', async (c) => {
    const config =
      ctx.serviceRole === 'machine-engine' ? null : await ctx.store.readConfig().catch(() => null);
    const allow = config?.remoteServing?.allowModels;
    const allowSet = allow && allow.length > 0 ? new Set(allow) : null;
    const models: RemoteModelDescriptor[] = [];
    await Promise.all(
      REMOTE_CHAT_PROVIDERS.map(async (provider) => {
        try {
          for (const m of await ctx.chat.listModelsForProvider(provider)) {
            const id = `${provider}:${m.id}`;
            if (allowSet && !allowSet.has(id) && !allowSet.has(m.id)) continue;
            models.push({
              id,
              name: m.name,
              modality: 'chat',
              ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
              ...(m.supportsTools !== undefined ? { supportsTools: m.supportsTools } : {}),
              ...(m.supportsReasoning !== undefined
                ? { supportsReasoning: m.supportsReasoning }
                : {}),
              ...(m.parameterSize ? { parameterSize: m.parameterSize } : {}),
            });
          }
        } catch {
          /* provider not configured / unavailable — skip silently */
        }
      }),
    );
    return c.json({ deviceId: ctx.deviceIdentity.deviceId, models });
  });

  // --- Image generation (inference-only; A persists the artifact) ---------
  app.post('/image/generate', async (c) => {
    const body = RemoteImageGenRequestSchema.parse(await c.req.json());
    const provider = await ctx.imageProvider.current();
    const out = await provider.generate({
      prompt: body.prompt,
      ...(body.negativePrompt ? { negativePrompt: body.negativePrompt } : {}),
      ...(body.model ? { model: body.model } : {}),
      ...(body.width ? { width: body.width } : {}),
      ...(body.height ? { height: body.height } : {}),
      ...(body.steps ? { steps: body.steps } : {}),
      ...(body.seed !== undefined ? { seed: body.seed } : {}),
      ...(body.strength !== undefined ? { strength: body.strength } : {}),
      ...(body.inputImages && body.inputImages.length > 0
        ? {
            inputImages: body.inputImages.map((i) => ({
              data: Buffer.from(i.data, 'base64'),
              mimeType: i.mimeType,
            })),
          }
        : {}),
    });
    return c.json({ meta: out.meta, png: out.png.toString('base64') });
  });

  app.get('/image/models', async (c) => {
    const provider = await ctx.imageProvider.current();
    return c.json({ models: await provider.listInstalledModels() });
  });

  app.get('/image/health', async (c) => {
    const provider = await ctx.imageProvider.current();
    return c.json(await provider.health());
  });

  // --- Video generation ----------------------------------------------------
  app.post('/video/generate', async (c) => {
    const body = RemoteVideoGenRequestSchema.parse(await c.req.json());
    const provider = await ctx.videoProvider.current();
    const out = await provider.generate({
      prompt: body.prompt,
      ...(body.negativePrompt ? { negativePrompt: body.negativePrompt } : {}),
      ...(body.model ? { model: body.model } : {}),
      ...(body.width ? { width: body.width } : {}),
      ...(body.height ? { height: body.height } : {}),
      ...(body.numFrames ? { numFrames: body.numFrames } : {}),
      ...(body.fps ? { fps: body.fps } : {}),
      ...(body.steps ? { steps: body.steps } : {}),
      ...(body.guidanceScale !== undefined ? { guidanceScale: body.guidanceScale } : {}),
      ...(body.seed !== undefined ? { seed: body.seed } : {}),
      ...(body.inputImage
        ? {
            inputImage: {
              data: Buffer.from(body.inputImage.data, 'base64'),
              mimeType: body.inputImage.mimeType,
            },
          }
        : {}),
    });
    return c.json({
      meta: out.meta,
      video: out.video.toString('base64'),
      ...(out.poster ? { poster: out.poster.toString('base64') } : {}),
    });
  });

  app.get('/video/models', async (c) =>
    c.json({ models: await (await ctx.videoProvider.current()).listInstalledModels() }),
  );
  app.get('/video/health', async (c) => c.json(await (await ctx.videoProvider.current()).health()));

  // --- Audio: speech-to-text ----------------------------------------------
  app.post('/audio/transcribe', async (c) => {
    const body = RemoteTranscribeRequestSchema.parse(await c.req.json());
    const out = await (await ctx.stt.current()).transcribe({
      audio: { data: Buffer.from(body.audio.data, 'base64'), mimeType: body.audio.mimeType },
      ...(body.model ? { model: body.model } : {}),
      ...(body.language ? { language: body.language } : {}),
    });
    return c.json(out);
  });

  app.get('/audio/stt/models', async (c) =>
    c.json({ models: await (await ctx.stt.current()).listInstalledModels() }),
  );
  app.get('/audio/stt/health', async (c) => c.json(await (await ctx.stt.current()).health()));

  // --- Audio: text-to-speech ----------------------------------------------
  app.post('/audio/synthesize', async (c) => {
    const body = RemoteSynthesizeRequestSchema.parse(await c.req.json());
    const out = await (await ctx.tts.current()).synthesize({
      text: body.text,
      ...(body.voice ? { voice: body.voice } : {}),
      ...(body.model ? { model: body.model } : {}),
      ...(body.speed !== undefined ? { speed: body.speed } : {}),
    });
    return c.json({ wav: out.wav.toString('base64'), meta: out.meta });
  });

  app.get('/audio/voices', async (c) =>
    c.json({ voices: await (await ctx.tts.current()).listVoices() }),
  );
  app.get('/audio/tts/models', async (c) =>
    c.json({ models: await (await ctx.tts.current()).listInstalledModels() }),
  );
  app.get('/audio/tts/health', async (c) => c.json(await (await ctx.tts.current()).health()));

  // User daemon A owns the session and prepares its exact prompt. B receives
  // only the renderable inference payload and performs a best-effort prefill
  // against an already-resident native engine.
  app.post('/cache/warm', async (c) => {
    const body = RemoteCacheWarmRequestSchema.parse(await c.req.json());
    if (body.protocolVersion > PROTOCOL_VERSION) {
      return c.json({ error: 'protocol_version_unsupported', supported: PROTOCOL_VERSION }, 426);
    }
    const target = resolveModelTarget(body.model);
    if (!target || !['llama-cpp', 'mlx', 'ds4'].includes(target.provider)) {
      return c.json({ error: 'invalid_model', hint: 'expected a native <provider>:<model>' }, 400);
    }
    const auth = c.get('auth') as { appId: string } | undefined;
    const originDeviceId = auth?.appId ?? 'unknown';
    void prewarmRemoteCache(ctx, body, originDeviceId).catch((error) => {
      log.warn(
        `warm failed for ${body.model}/${body.sessionId.slice(0, 8)}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
    return c.json({ ok: true, sessionId: body.sessionId }, 202);
  });

  // Session-specific eviction also begins with A's id. Namespace it here so
  // it targets the same engine key remote inference used.
  app.post('/cache/evict', async (c) => {
    const body = RemoteCacheEvictRequestSchema.parse(await c.req.json());
    const auth = c.get('auth') as { appId: string } | undefined;
    const originDeviceId = auth?.appId ?? 'unknown';
    ctx.chat.invalidateSessionCache(namespaceRemoteId(body.sessionId, originDeviceId));
    return c.json({ ok: true, sessionId: body.sessionId });
  });

  // Resolve the model through the same native-engine router used by /infer,
  // then return the context window AFTER the capacity broker has applied its
  // live RAM/VRAM clamp. Device A calls this before it builds the coordinator
  // prompt; discovery metadata alone is only the model-native/requested cap.
  app.post('/admit', async (c) => {
    const body = RemoteAdmissionRequestSchema.parse(await c.req.json());
    if (body.protocolVersion > PROTOCOL_VERSION) {
      return c.json({ error: 'protocol_version_unsupported', supported: PROTOCOL_VERSION }, 426);
    }
    const target = resolveModelTarget(body.model);
    if (!target) {
      return c.json({ error: 'invalid_model', hint: 'expected <provider>:<model>' }, 400);
    }

    const auth = c.get('auth') as { appId: string } | undefined;
    const originDeviceId = auth?.appId ?? 'unknown';
    const release = (await getLimiter()).tryAcquire(originDeviceId, 'chat');
    if (!release) {
      return c.json({ error: 'tenant_concurrency_exceeded' }, 429);
    }
    let probe: LLMSession | null = null;
    try {
      const provider = await ctx.chat.getProviderForModel(target.provider, target.model);
      const prepared = await provider.prepareContextWindow?.(target.model);
      let contextWindow = prepared ?? provider.getContextWindow?.();

      // Ollama resolves num_ctx asynchronously while creating a session. Keep
      // the wire contract provider-agnostic by probing a bridge-free session
      // when the provider cannot report a window directly.
      if (!contextWindow) {
        probe = await provider.createSession({
          systemMessage: '',
          model: target.model,
          priorMessages: [],
        });
        contextWindow = probe.numCtx;
      }
      if (!contextWindow || !Number.isFinite(contextWindow) || contextWindow <= 0) {
        return c.json({ error: 'context_window_unavailable', model: body.model }, 503);
      }
      return c.json({ model: body.model, contextWindow: Math.floor(contextWindow) });
    } catch (err) {
      if (err instanceof ModelNotInstalledError) {
        return c.json({ error: 'model_not_loaded', model: body.model }, 404);
      }
      throw err;
    } finally {
      await probe?.disconnect().catch(() => {});
      release();
    }
  });

  app.post('/infer', async (c) => {
    const body = RemoteInferRequestSchema.parse(await c.req.json());
    if (body.protocolVersion > PROTOCOL_VERSION) {
      return c.json({ error: 'protocol_version_unsupported', supported: PROTOCOL_VERSION }, 426);
    }

    const target = resolveModelTarget(body.model);
    if (!target) {
      return c.json({ error: 'invalid_model', hint: 'expected <provider>:<model>' }, 400);
    }

    const auth = c.get('auth') as { appId: string } | undefined;
    const originDeviceId = auth?.appId ?? 'unknown';
    const cfg =
      ctx.serviceRole === 'machine-engine' ? null : await ctx.store.readConfig().catch(() => null);

    // Per-tenant admission: reject early (429) when this device is at its cap,
    // before we touch the GPU/engine. Released when the turn ends.
    const release = (await getLimiter()).tryAcquire(originDeviceId, 'chat');
    if (!release) {
      return c.json({ error: 'tenant_concurrency_exceeded' }, 429);
    }

    // Resolve B's local provider for the model up front so model-not-loaded /
    // tools-unsupported surface as proper HTTP status before streaming starts.
    let session: LLMSession;
    try {
      const provider = await ctx.chat.getProviderForModel(target.provider, target.model);
      session = await provider.createSession({
        systemMessage: body.systemMessage,
        model: target.model,
        // Capture mode: advertise A's tools, execute none (no bridge on B).
        externalTools: body.tools,
        priorMessages: body.priorMessages,
        ...(body.systemPromptLayers ? { systemPromptLayers: body.systemPromptLayers } : {}),
        ...(body.volatileContext ? { volatileContext: body.volatileContext } : {}),
        ...(body.reasoningEffort ? { reasoningEffort: body.reasoningEffort } : {}),
        ...(body.tuning ? { tuning: body.tuning as unknown as ResolvedTuning } : {}),
      });
    } catch (err) {
      release();
      if (err instanceof ModelNotInstalledError) {
        return c.json({ error: 'model_not_loaded', model: body.model }, 404);
      }
      if (err instanceof ExternalToolsUnsupportedError) {
        return c.json({ error: 'tools_not_supported_for_provider', model: body.model }, 400);
      }
      throw err;
    }

    const lane = effectiveLane(body.queue.lane, cfg?.remoteServing?.priority);

    return streamSSE(c, async (stream) => {
      const send = (frame: unknown) =>
        void stream.writeSSE({ data: JSON.stringify(frame) }).catch(() => {});
      const unsubs: Array<() => void> = [];
      unsubs.push(session.onDelta((text) => send({ type: 'delta', text })));
      unsubs.push(
        session.onUsage((u: TurnUsage) =>
          send({
            type: 'usage',
            model: u.model,
            inputTokens: u.inputTokens,
            outputTokens: u.outputTokens,
            ...(u.cachedInputTokens !== undefined
              ? { cachedInputTokens: u.cachedInputTokens }
              : {}),
            ...(u.durationMs !== undefined ? { durationMs: u.durationMs } : {}),
            ...(u.contextUtilization !== undefined
              ? { contextUtilization: u.contextUtilization }
              : {}),
          }),
        ),
      );
      unsubs.push(
        session.onWarning?.((message) => send({ type: 'warning', message })) ?? (() => {}),
      );

      try {
        await session.sendAndWait(body.prompt, {
          timeoutMs: REMOTE_INFER_TIMEOUT_MS,
          ...(body.attachments && body.attachments.length > 0
            ? {
                attachments: body.attachments.map((a) => ({
                  base64: a.base64,
                  mimeType: a.mimeType,
                  filename: a.filename ?? 'attachment',
                })),
              }
            : {}),
          queue: mapWireQueueToB(body.queue, originDeviceId, c.req.raw.signal, lane),
        });
        const calls = session.capturedToolCalls?.() ?? [];
        if (calls.length > 0) send({ type: 'tool_call', calls });
        const reasoning = session.getLastTurnReasoning?.();
        if (reasoning) send({ type: 'reasoning', text: reasoning });
        send({ type: 'done' });
      } catch (err) {
        send({
          type: 'error',
          code: 'inference_failed',
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        for (const u of unsubs) u();
        await session.disconnect().catch(() => {});
        release();
      }
    });
  });

  return app;
}

/** B-side ceiling per forward-pass — generous for big-model prefill. */
const REMOTE_INFER_TIMEOUT_MS = 20 * 60 * 1000;
