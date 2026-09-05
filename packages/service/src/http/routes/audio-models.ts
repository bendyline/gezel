import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import {
  INVALID_MODEL_ID_CODE,
  INVALID_MODEL_ID_MESSAGE,
  isSafeModelId,
} from '../../models/model-id.js';
import { ReadOnlyModelError } from '../../models/storage-roots.js';
import {
  KOKORO_DEFAULT_MODEL_ID,
  KOKORO_DEFAULT_VOICES,
  isKokoroRuntimeAvailable,
} from '../../providers/audio/kokoro.js';
import type { AudioModelPullSpec } from '../../providers/audio/types.js';
import { WHISPER_MODEL_CATALOG } from '../../providers/audio/whisper-cpp.js';
import type { EngineContext } from '../engine-context.js';
import { machineEngineProxy } from './machine-engine-proxy.js';

export function audioModelRoutes(ctx: EngineContext): Hono {
  const app = new Hono();
  const proxy = machineEngineProxy(ctx, '/api/audio', '/v1/remote/manage/audio', []);

  app.get('/engine-status', proxy, async (c) => {
    const [sttProvider, ttsProvider] = await Promise.all([ctx.stt.current(), ctx.tts.current()]);
    const [sttHealth, sttModels, ttsHealth, ttsModels] = await Promise.all([
      sttProvider.health(),
      sttProvider.listInstalledModels(),
      ttsProvider.health(),
      ttsProvider.listInstalledModels(),
    ]);
    return c.json({
      stt: {
        ...sttHealth,
        provider: sttProvider.name,
        modelCount: sttModels.length,
      },
      tts: {
        ...ttsHealth,
        provider: ttsProvider.name,
        modelCount: ttsModels.length,
      },
    });
  });

  app.get('/catalog', proxy, (c) => {
    return c.json(buildAudioCatalog());
  });

  app.get('/stt/models', proxy, async (c) => {
    const provider = await ctx.stt.current();
    const models = await provider.listInstalledModels();
    return c.json({ models });
  });

  app.post('/stt/models/:id/pull', proxy, async (c) => {
    const id = c.req.param('id');
    const entry = WHISPER_MODEL_CATALOG.find((m) => m.id === id);
    if (!entry) {
      return c.json({ error: `unknown stt model: ${id}` }, 404);
    }
    const spec: AudioModelPullSpec = {
      name: entry.name,
      files: [
        {
          role: 'weights',
          downloadUrl: entry.downloadUrl,
          sha256: entry.sha256,
          approxSizeBytes: entry.approxSizeBytes,
        },
      ],
    };
    return streamSSE(c, async (stream) => {
      try {
        const provider = await ctx.stt.current();
        for await (const event of provider.pullModel(id, spec)) {
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

  app.delete('/stt/models/:id', proxy, async (c) => {
    const id = c.req.param('id');
    if (!isSafeModelId(id)) {
      return c.json({ error: INVALID_MODEL_ID_MESSAGE, code: INVALID_MODEL_ID_CODE }, 400);
    }
    const provider = await ctx.stt.current();
    try {
      await provider.deleteModel(id);
    } catch (err) {
      if (err instanceof ReadOnlyModelError) {
        return c.json({ error: err.message, code: err.code }, 409);
      }
      throw err;
    }
    return c.json({ ok: true as const });
  });

  app.get('/tts/models', proxy, async (c) => {
    const provider = await ctx.tts.current();
    const models = await provider.listInstalledModels();
    return c.json({ models });
  });

  app.post('/tts/models/:id/pull', proxy, async (c) => {
    const id = c.req.param('id');
    if (id !== KOKORO_DEFAULT_MODEL_ID) {
      return c.json({ error: `unknown tts model: ${id}` }, 404);
    }
    const spec: AudioModelPullSpec = {
      name: 'Kokoro 82M v1.0',
      files: [
        {
          role: 'weights',
          // kokoro-js downloads via Transformers.js's HF cache; the
          // URL/sha entries here are bookkeeping for total-bytes
          // accounting only. The pull doesn't actually fetch from
          // these — it delegates to `KokoroTTS.from_pretrained`.
          downloadUrl: 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX',
          sha256: ''.padEnd(64, '0'),
          approxSizeBytes: 95_000_000,
        },
      ],
    };
    return streamSSE(c, async (stream) => {
      try {
        const provider = await ctx.tts.current();
        for await (const event of provider.pullModel(id, spec)) {
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

  app.delete('/tts/models/:id', proxy, async (c) => {
    const id = c.req.param('id');
    if (!isSafeModelId(id)) {
      return c.json({ error: INVALID_MODEL_ID_MESSAGE, code: INVALID_MODEL_ID_CODE }, 400);
    }
    const provider = await ctx.tts.current();
    try {
      await provider.deleteModel(id);
    } catch (err) {
      if (err instanceof ReadOnlyModelError) {
        return c.json({ error: err.message, code: err.code }, 409);
      }
      throw err;
    }
    return c.json({ ok: true as const });
  });

  app.get('/voices', proxy, async (c) => {
    const provider = await ctx.tts.current();
    let voices = await provider.listVoices();
    if (voices.length === 0) {
      voices = [...KOKORO_DEFAULT_VOICES];
    }
    return c.json({ voices });
  });
  return app;
}

export function buildAudioCatalog(options: { kokoroRuntimeAvailable?: boolean } = {}) {
  const kokoroRuntimeAvailable = options.kokoroRuntimeAvailable ?? isKokoroRuntimeAvailable();
  return {
    // All Whisper weights ship under MIT (whisper.cpp / OpenAI Whisper);
    // Kokoro under Apache 2.0. Both are permissive → "Free, open".
    stt: WHISPER_MODEL_CATALOG.map((m) => ({
      id: m.id,
      name: m.name,
      description: m.description,
      approxSizeBytes: m.approxSizeBytes,
      kind: 'stt' as const,
      license: 'MIT',
      licenseClass: 'open' as const,
      licenseShortName: 'MIT',
      licenseUrl: 'https://huggingface.co/ggerganov/whisper.cpp',
      // The Base (English) variant is the recommended STT default: ~140 MB,
      // realtime on laptop CPUs. Curated recoScore → ★ badge + auto-pick.
      ...(m.id === 'whisper-base.en' ? { recoScore: 20 } : {}),
    })),
    tts: kokoroRuntimeAvailable
      ? [
          {
            id: KOKORO_DEFAULT_MODEL_ID,
            name: 'Kokoro 82M v1.0',
            description:
              'Apache 2.0 TTS — 54+ voices, ~80MB quantized, near-realtime on M1 / modern desktop CPUs.',
            approxSizeBytes: 95_000_000,
            kind: 'tts' as const,
            license: 'Apache 2.0',
            licenseClass: 'open' as const,
            licenseShortName: 'Apache 2.0',
            licenseUrl: 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX',
            recoScore: 20,
          },
        ]
      : [],
  };
}
