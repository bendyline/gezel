import {
  type AudioSynthesizeProgress,
  type AudioSynthesizeRequest,
  AudioSynthesizeRequestSchema,
  type AudioSynthesizeResponse,
  AudioTranscribeRequestSchema,
  createLogger,
} from '@bendyline/gezel';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';

import type { SynthesizeChunk } from '../../providers/audio/types.js';

import type { ServiceContext } from '../context.js';
import { audioModelRoutes } from './audio-models.js';

const log = createLogger('audio');

/**
 * Audio (STT + TTS) endpoints. Mounted at `/api/audio`.
 *
 * Layout mirrors `/api/image-gen`:
 *   - `POST /transcribe`           — STT one-shot.
 *   - `POST /synthesize`           — TTS one-shot.
 *   - `POST /synthesize-stream`    — TTS with sentence-level SSE progress.
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

  async function synthesize(
    req: AudioSynthesizeRequest,
    signal: AbortSignal,
    onProgress?: (progress: AudioSynthesizeProgress) => void | Promise<void>,
    onChunk?: (chunk: SynthesizeChunk) => void | Promise<void>,
  ): Promise<AudioSynthesizeResponse> {
    const projectId = req.projectId ?? 'default';

    // Resolve the effective voice. Caller-supplied wins; otherwise fall
    // back to the gezel's per-character voice from frontmatter.
    let resolvedVoice = req.voice;
    if (!resolvedVoice && req.gezelId) {
      const gezel = await ctx.store.getGezel(req.gezelId).catch(() => null);
      resolvedVoice = gezel?.parsed.frontmatter.voice;
    }

    const synthStarted = Date.now();
    log.info(
      `[synthesize] start chars=${req.text.length} voice=${resolvedVoice ?? '(default)'} gezelId=${req.gezelId ?? '(none)'}`,
    );
    const provider = await ctx.tts.providerForModel(req.model);
    const out = await provider.synthesize({
      text: req.text,
      signal,
      ...(onProgress ? { onProgress } : {}),
      ...(onChunk ? { onChunk } : {}),
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
    return {
      artifactPath: writtenPath,
      meta: out.meta,
      ...(req.inline ? { b64Wav: out.wav.toString('base64') } : {}),
    };
  }

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
        ...(req.prompt ? { prompt: req.prompt } : {}),
      });
      return c.json({
        text: out.text,
        durationMs: out.durationMs,
        ...(out.language ? { language: out.language } : {}),
        ...(out.segments ? { segments: out.segments } : {}),
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      log.warn(`[transcribe] failed: ${detail}`);
      return c.json({ error: speechToTextErrorCode(err) }, 503);
    }
  });

  app.post('/synthesize', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = AudioSynthesizeRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.message }, 400);
    }
    try {
      return c.json(await synthesize(parsed.data, c.req.raw.signal));
    } catch (err) {
      log.warn(`[synthesize] failed: ${err instanceof Error ? err.message : String(err)}`);
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.post('/synthesize-stream', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = AudioSynthesizeRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.message }, 400);
    }
    const req = parsed.data;
    return streamSSE(c, async (stream) => {
      const writeProgress = (progress: AudioSynthesizeProgress) =>
        stream.writeSSE({ data: JSON.stringify({ type: 'progress', progress }) });
      try {
        await writeProgress({
          phase: 'loading',
          completedCharacters: 0,
          totalCharacters: req.text.length,
          completedChunks: 0,
        });
        const result = await synthesize(req, c.req.raw.signal, writeProgress, (chunk) =>
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
        );
        await writeProgress({
          phase: 'encoding',
          completedCharacters: req.text.length,
          totalCharacters: req.text.length,
          completedChunks: 0,
        });
        await stream.writeSSE({ data: JSON.stringify({ type: 'done', result }) });
      } catch (err) {
        if (c.req.raw.signal.aborted) return;
        const error = err instanceof Error ? err.message : String(err);
        log.warn(`[synthesize-stream] failed: ${error}`);
        await stream.writeSSE({ data: JSON.stringify({ type: 'error', error }) });
      }
    });
  });
  app.route('/', audioModelRoutes(ctx));

  return app;
}

/** Stable, non-sensitive UI code for expected speech-engine failures. */
export function speechToTextErrorCode(
  error: unknown,
): 'speech_to_text_not_ready' | 'speech_to_text_failed' {
  const message = error instanceof Error ? error.message : String(error);
  return /no stt model|speech-to-text model|download one from settings|audio engine enabled|not wired up/i.test(
    message,
  )
    ? 'speech_to_text_not_ready'
    : 'speech_to_text_failed';
}

function audioArtifactFilename(sessionId: string | undefined): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const tail = sessionId ? `-${sessionId.slice(0, 8)}` : '';
  return `tts-${stamp}${tail}.wav`;
}

export { buildAudioCatalog } from './audio-models.js';
