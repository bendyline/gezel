import {
  AudioSynthesizeRequestSchema,
  AudioTranscribeRequestSchema,
  createLogger,
} from '@bendyline/gezel';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { KOKORO_DEFAULT_MODEL_ID, KOKORO_DEFAULT_VOICES } from '../../providers/audio/kokoro.js';
import type { AudioModelPullSpec } from '../../providers/audio/types.js';
import { WHISPER_MODEL_CATALOG } from '../../providers/audio/whisper-cpp.js';
import type { ServiceContext } from '../context.js';

const log = createLogger('audio');

/**
 * Audio (STT + TTS) endpoints. Mounted at `/api/audio`.
 *
 * Layout mirrors `/api/image-gen`:
 *   - `POST /transcribe`           — STT one-shot.
 *   - `POST /synthesize`           — TTS one-shot.
 *   - `GET  /engine-status`        — combined STT + TTS readiness.
 *   - `GET  /catalog`              — what's available to pull.
 *   - `GET  /stt/models`           — list installed STT models.
 *   - `POST /stt/models/:id/pull`  — pull an STT model (SSE progress).
 *   - `DELETE /stt/models/:id`     — delete an installed STT model.
 *   - `GET  /tts/models`           — list installed TTS models.
 *   - `POST /tts/models/:id/pull`  — pull a TTS model (SSE progress).
 *   - `DELETE /tts/models/:id`     — delete an installed TTS model.
 *   - `GET  /voices`               — list available voices (TTS).
 */
export function audioRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  app.post('/transcribe', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = AudioTranscribeRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.message }, 400);
    }
    const req = parsed.data;
    const projectId = req.projectId ?? 'default';

    let bytes: Buffer;
    let mime: string;
    try {
      if ('artifactPath' in req.audio) {
        const stripped = req.audio.artifactPath.replace(/^artifacts\//, '');
        const found = await ctx.store.readProjectArtifactBinary(projectId, stripped);
        if (!found) {
          return c.json({ error: `Audio not found at artifacts/${stripped}` }, 404);
        }
        bytes = found.data;
        mime = found.mimeType;
      } else {
        bytes = Buffer.from(req.audio.data, 'base64');
        mime = req.audio.mimeType || 'audio/wav';
        if (bytes.length === 0) {
          return c.json({ error: 'Audio base64 decoded to zero bytes.' }, 400);
        }
      }
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }

    try {
      const provider = await ctx.stt.providerForModel(req.model);
      const out = await provider.transcribe({
        audio: { data: bytes, mimeType: mime },
        ...(req.model ? { model: req.model } : {}),
        ...(req.language ? { language: req.language } : {}),
      });
      return c.json({
        text: out.text,
        durationMs: out.durationMs,
        ...(out.language ? { language: out.language } : {}),
        ...(out.segments ? { segments: out.segments } : {}),
      });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.post('/synthesize', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = AudioSynthesizeRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.message }, 400);
    }
    const req = parsed.data;
    const projectId = req.projectId ?? 'default';

    // Resolve the effective voice. Caller-supplied wins; otherwise fall
    // back to the gezel's per-character voice from frontmatter so
    // synthesize_speech from a gezel chat picks up that gezel's voice
    // without callers having to thread it through. Provider applies its
    // own default (`af_heart`) when both are absent.
    let resolvedVoice = req.voice;
    if (!resolvedVoice && req.gezelId) {
      const gezel = await ctx.store.getGezel(req.gezelId).catch(() => null);
      resolvedVoice = gezel?.parsed.frontmatter.voice;
    }

    const synthStarted = Date.now();
    log.info(
      `[synthesize] start chars=${req.text.length} voice=${resolvedVoice ?? '(default)'} gezelId=${req.gezelId ?? '(none)'}`,
    );
    try {
      const provider = await ctx.tts.providerForModel(req.model);
      const out = await provider.synthesize({
        text: req.text,
        ...(resolvedVoice ? { voice: resolvedVoice } : {}),
        ...(req.model ? { model: req.model } : {}),
        ...(req.speed !== undefined ? { speed: req.speed } : {}),
      });
      log.info(
        `[synthesize] done in ${Date.now() - synthStarted}ms (${out.meta.durationSeconds.toFixed(1)}s audio, ${out.wav.length}B wav)`,
      );

      const filename = audioArtifactFilename(req.sessionId);
      const relPath = `audio/${filename}`;
      const writtenPath = await ctx.store.writeProjectArtifactBinary(projectId, relPath, out.wav);
      const respBody: {
        artifactPath: string;
        meta: typeof out.meta;
        b64Wav?: string;
      } = {
        artifactPath: writtenPath,
        meta: out.meta,
      };
      if (req.inline) respBody.b64Wav = out.wav.toString('base64');
      return c.json(respBody);
    } catch (err) {
      log.warn(
        `[synthesize] failed after ${Date.now() - synthStarted}ms: ${err instanceof Error ? err.message : String(err)}`,
      );
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.get('/engine-status', async (c) => {
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

  app.get('/catalog', (c) => {
    return c.json({
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
      tts: [
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
      ],
    });
  });

  app.get('/stt/models', async (c) => {
    const provider = await ctx.stt.current();
    const models = await provider.listInstalledModels();
    return c.json({ models });
  });

  app.post('/stt/models/:id/pull', async (c) => {
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

  app.delete('/stt/models/:id', async (c) => {
    const id = c.req.param('id');
    const provider = await ctx.stt.current();
    await provider.deleteModel(id);
    return c.json({ ok: true as const });
  });

  app.get('/tts/models', async (c) => {
    const provider = await ctx.tts.current();
    const models = await provider.listInstalledModels();
    return c.json({ models });
  });

  app.post('/tts/models/:id/pull', async (c) => {
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

  app.delete('/tts/models/:id', async (c) => {
    const id = c.req.param('id');
    const provider = await ctx.tts.current();
    await provider.deleteModel(id);
    return c.json({ ok: true as const });
  });

  app.get('/voices', async (c) => {
    const provider = await ctx.tts.current();
    let voices = await provider.listVoices();
    if (voices.length === 0) {
      voices = [...KOKORO_DEFAULT_VOICES];
    }
    return c.json({ voices });
  });

  return app;
}

function audioArtifactFilename(sessionId: string | undefined): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const tail = sessionId ? `-${sessionId.slice(0, 8)}` : '';
  return `tts-${stamp}${tail}.wav`;
}
