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
import { CapacityDeniedError } from '../../providers/native/capacity-broker.js';
import {
  PROTOCOL_VERSION,
  RemoteAdmissionRequestSchema,
  RemoteCacheEvictRequestSchema,
  RemoteCacheWarmRequestSchema,
  RemoteImageGenRequestSchema,
  type RemoteInferFrame,
  RemoteInferRequestSchema,
  type RemoteModelDescriptor,
  RemoteSynthesizeRequestSchema,
  RemoteTranscribeRequestSchema,
  RemoteVideoGenRequestSchema,
  type WireQueueHints,
} from '../../providers/remote/wire.js';
import type {
  EnginePhaseEvent,
  EngineStatsEvent,
  TurnStatsEvent,
} from '../../providers/streaming-session.js';
import {
  ExternalToolsUnsupportedError,
  type LLMProvider,
  type LLMSession,
  ModelNotInstalledError,
  type TurnUsage,
} from '../../providers/types.js';
import type { ServiceContext } from '../context.js';
import { resolveModelTarget } from '../openai-compat/translate.js';
import { serializeSseWrites } from './chat-events.js';

const log = createLogger('remote-cache');

/**
 * Namespace the client's affinity keys by its authenticated origin device, so
 * one tenant's prompt-cache prefix can never be served to another and two
 * tenants' identical sessionIds don't collide in B's queue.
 */
function namespaceRemoteId(value: string, originDeviceId: string): string {
  return `dev:${originDeviceId}:${value}`;
}

/**
 * The user-daemon → broker bridge authenticates with the shared
 * `machine-engine-client` credential (scopes include `machine-models`), so
 * every LOCAL user's chats pool under one tenant id on this surface. Serving
 * policy — allowModels, tenant caps, lane demotion — exists to constrain
 * PAIRED LAN devices; applying it to the bridge would let a LAN admission
 * policy throttle the machine's own users. Root keeps the same exemption.
 */
function isFirstPartyMachineTenant(auth: { scopes?: readonly string[] } | undefined): boolean {
  return (
    auth?.scopes?.includes('machine-models') === true || auth?.scopes?.includes('root') === true
  );
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

  // Inference-only model discovery: what this server will run for clients.
  // No project/session state — pure capability enumeration. The broker reads
  // its own system-home config here: serving policy lives with whichever
  // daemon owns the LAN listener.
  app.get('/models', async (c) => {
    const config = await ctx.store.readConfig().catch(() => null);
    const auth = c.get('auth') as { scopes?: readonly string[] } | undefined;
    const allow = isFirstPartyMachineTenant(auth) ? undefined : config?.remoteServing?.allowModels;
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
      signal: c.req.raw.signal,
      ...(body.voice ? { voice: body.voice } : {}),
      ...(body.model ? { model: body.model } : {}),
      ...(body.speed !== undefined ? { speed: body.speed } : {}),
    });
    return c.json({ wav: out.wav.toString('base64'), meta: out.meta });
  });

  app.post('/audio/synthesize-stream', async (c) => {
    const body = RemoteSynthesizeRequestSchema.parse(await c.req.json());
    return streamSSE(c, async (stream) => {
      try {
        const out = await (await ctx.tts.current()).synthesize({
          text: body.text,
          signal: c.req.raw.signal,
          onProgress: (progress) =>
            stream.writeSSE({ data: JSON.stringify({ type: 'progress', progress }) }),
          onChunk: (chunk) =>
            stream.writeSSE({
              data: JSON.stringify({
                type: 'chunk',
                chunk: {
                  index: chunk.index,
                  b64Wav: chunk.wav.toString('base64'),
                  sampleRate: chunk.sampleRate,
                  durationSeconds: chunk.durationSeconds,
                },
              }),
            }),
          ...(body.voice ? { voice: body.voice } : {}),
          ...(body.model ? { model: body.model } : {}),
          ...(body.speed !== undefined ? { speed: body.speed } : {}),
        });
        await stream.writeSSE({
          data: JSON.stringify({
            type: 'done',
            result: { wav: out.wav.toString('base64'), meta: out.meta },
          }),
        });
      } catch (error) {
        if (c.req.raw.signal.aborted) return;
        await stream.writeSSE({
          data: JSON.stringify({
            type: 'error',
            error: error instanceof Error ? error.message : String(error),
          }),
        });
      }
    });
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

  // Return the context window AFTER the capacity broker's live RAM/VRAM
  // clamp, but do not bind or load a cold native engine. Session focus is a
  // planning operation: it must never evict another account's resident model.
  app.post('/admit', async (c) => {
    const body = RemoteAdmissionRequestSchema.parse(await c.req.json());
    if (body.protocolVersion > PROTOCOL_VERSION) {
      return c.json({ error: 'protocol_version_unsupported', supported: PROTOCOL_VERSION }, 426);
    }
    const target = resolveModelTarget(body.model);
    if (!target || !target.model) {
      return c.json({ error: 'invalid_model', hint: 'expected <provider>:<model>' }, 400);
    }

    const auth = c.get('auth') as { appId: string; scopes?: readonly string[] } | undefined;
    const originDeviceId = auth?.appId ?? 'unknown';
    let release: () => void = () => {};
    if (!isFirstPartyMachineTenant(auth)) {
      const admission = ctx.remoteTenantLimits.tryAcquire(originDeviceId, 'chat');
      if (!admission.ok) {
        c.header('Retry-After', String(admission.retryAfterSec));
        return c.json(
          {
            error:
              admission.reason === 'rate_limit'
                ? 'tenant_rate_limited'
                : 'tenant_concurrency_exceeded',
          },
          429,
        );
      }
      release = admission.release;
    }
    let probe: LLMSession | null = null;
    try {
      const nativeTarget = ['llama-cpp', 'mlx', 'ds4'].includes(target.provider);
      const provider = nativeTarget
        ? null
        : await ctx.chat.getProviderForModel(target.provider, target.model);
      let contextWindow = nativeTarget
        ? await ctx.chat.previewContextWindowForModel(
            target.provider as 'llama-cpp' | 'mlx' | 'ds4',
            target.model,
          )
        : ((await provider?.prepareContextWindow?.(target.model)) ??
          provider?.getContextWindow?.());

      // Ollama resolves num_ctx asynchronously while creating a session. Keep
      // the wire contract provider-agnostic by probing a bridge-free session
      // when the provider cannot report a window directly.
      if (!contextWindow && provider) {
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
      if (err instanceof CapacityDeniedError) {
        return c.json({ error: 'capacity_denied' }, 503);
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

    const auth = c.get('auth') as { appId: string; scopes?: readonly string[] } | undefined;
    const originDeviceId = auth?.appId ?? 'unknown';
    const firstParty = isFirstPartyMachineTenant(auth);
    const cfg = await ctx.store.readConfig().catch(() => null);

    // Per-tenant admission: reject early (429) when this device is at its
    // concurrency cap or rate limit, before we touch the GPU/engine.
    // Released when the turn ends. First-party bridge traffic bypasses the
    // limiter — see isFirstPartyMachineTenant.
    let release: () => void = () => {};
    if (!firstParty) {
      const admission = ctx.remoteTenantLimits.tryAcquire(originDeviceId, 'chat');
      if (!admission.ok) {
        c.header('Retry-After', String(admission.retryAfterSec));
        return c.json(
          {
            error:
              admission.reason === 'rate_limit'
                ? 'tenant_rate_limited'
                : 'tenant_concurrency_exceeded',
          },
          429,
        );
      }
      release = admission.release;
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

    const lane = firstParty
      ? body.queue.lane
      : effectiveLane(body.queue.lane, cfg?.remoteServing?.priority);

    return streamSSE(c, async (stream) => {
      // Native sessions can synchronously emit content, reasoning, phase, and
      // stats callbacks for one wire chunk. Hono's writer is stateful, so keep
      // those frames ordered and await the terminal frame before disconnecting
      // (otherwise a fast `done` can close the response ahead of queued data).
      const write = serializeSseWrites((frame: RemoteInferFrame) =>
        stream.writeSSE({ data: JSON.stringify(frame) }),
      );
      const send = (frame: RemoteInferFrame) => void write(frame).catch(() => {});
      const unsubs: Array<() => void> = [];
      unsubs.push(session.onDelta((text) => send({ type: 'delta', text })));
      unsubs.push(
        session.onReasoningDelta?.((text) => send({ type: 'reasoning_delta', text })) ?? (() => {}),
      );
      unsubs.push(
        session.onToolArgsDelta?.((name, text, meta) =>
          send({
            type: 'tool_args_delta',
            name,
            text,
            ...(meta?.index !== undefined ? { index: meta.index } : {}),
            ...(meta?.id ? { id: meta.id } : {}),
          }),
        ) ?? (() => {}),
      );
      unsubs.push(session.onWirePulse?.(() => send({ type: 'wire_pulse' })) ?? (() => {}));
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
      const streamingSession = session as LLMSession & {
        onEnginePhase?: (handler: (ev: EnginePhaseEvent) => void) => () => void;
        onTurnStats?: (handler: (ev: TurnStatsEvent) => void) => () => void;
        onEngineStats?: (handler: (ev: EngineStatsEvent) => void) => () => void;
      };
      unsubs.push(
        streamingSession.onEnginePhase?.((ev) =>
          send({
            type: 'phase',
            provider: target.provider === 'ds4' ? 'ds4' : ev.provider,
            phase: ev.phase,
            ...(ev.detail ? { detail: ev.detail } : {}),
            ...(typeof ev.progress === 'number' ? { progress: ev.progress } : {}),
            ...(typeof ev.ttftMs === 'number' ? { ttftMs: ev.ttftMs } : {}),
            ...(typeof ev.outputTokens === 'number' ? { outputTokens: ev.outputTokens } : {}),
            ...(typeof ev.tokensPerSec === 'number' ? { tokensPerSec: ev.tokensPerSec } : {}),
          }),
        ) ?? (() => {}),
      );
      unsubs.push(
        streamingSession.onTurnStats?.((ev) =>
          send({
            type: 'turn_stats',
            provider: target.provider === 'ds4' ? 'ds4' : ev.provider,
            promptTokens: ev.promptTokens,
            completionTokens: ev.completionTokens,
            durationMs: ev.durationMs,
            ...(typeof ev.tokensPerSec === 'number' ? { tokensPerSec: ev.tokensPerSec } : {}),
          }),
        ) ?? (() => {}),
      );
      unsubs.push(
        streamingSession.onEngineStats?.((ev) =>
          send({
            type: 'engine_stats',
            provider: target.provider === 'ds4' ? 'ds4' : ev.provider,
            ramAllocBytes: ev.ramAllocBytes,
          }),
        ) ?? (() => {}),
      );

      try {
        const continueFromToolResult =
          body.prompt.length === 0 && body.priorMessages.at(-1)?.role === 'tool';
        await session.sendAndWait(body.prompt, {
          timeoutMs: REMOTE_INFER_TIMEOUT_MS,
          ...(continueFromToolResult ? { continueFromToolResult: true } : {}),
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
        await write({ type: 'done' });
      } catch (err) {
        await write({
          type: 'error',
          code: 'inference_failed',
          message: err instanceof Error ? err.message : String(err),
        }).catch(() => {});
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
