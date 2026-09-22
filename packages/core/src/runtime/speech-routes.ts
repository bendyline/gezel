import {
  type AudioSynthesizeEvent,
  AudioSynthesizeMetaSchema,
  type AudioSynthesizeRequest,
  AudioSynthesizeRequestSchema,
  AudioTranscribeRequestSchema,
  AudioTranscribeResponseSchema,
} from '../schemas/audio.js';
import { OfflineSpeechStatusSchema } from '../schemas/offline-speech.js';
import { acquireSuspendMonitor, createAwakeTimeout } from '../suspend-clock.js';
import { json } from './http/json.js';
import { speechBase64, speechBytes } from './speech-bytes.js';
import { type PortableSpeech, requireOfflineSpeech, transcribeOffline } from './speech.js';
import type { PortableStore } from './store.js';

/** Owns speech admission through the last native callback and durable artifact
 * write. Streaming responses do not release the operation when headers return. */
export class PortableSpeechRoutes {
  private active?: { controller: AbortController; finished: Promise<void> };
  constructor(
    private readonly store: PortableStore,
    private readonly speech: PortableSpeech,
    private readonly admit: () => void,
    private readonly changed: () => void = () => {},
  ) {}
  get busy(): boolean {
    return !!this.active;
  }
  async cancel(): Promise<void> {
    const active = this.active;
    active?.controller.abort(new DOMException('Speech stopped', 'AbortError'));
    await active?.finished;
  }

  private begin(request: Request) {
    this.admit();
    if (this.active) throw new Error('Wait for speech to finish, or stop it first.');
    const controller = new AbortController();
    const abort = () => controller.abort(request.signal.reason);
    request.signal.addEventListener('abort', abort, { once: true });
    if (request.signal.aborted) abort();
    const releaseMonitor = acquireSuspendMonitor();
    // Android system recognition consumes recorded PCM in real time. Allow
    // final decoding/cleanup after a maximum-length two-minute recording.
    const deadline = createAwakeTimeout(180_000);
    const expire = () => controller.abort(deadline.signal.reason);
    deadline.signal.addEventListener('abort', expire, { once: true });
    let release!: () => void;
    const active = {
      controller,
      finished: new Promise<void>((resolve) => {
        release = resolve;
      }),
    };
    this.active = active;
    this.changed();
    return {
      signal: controller.signal,
      abort: () => controller.abort(new DOMException('Speech stopped', 'AbortError')),
      finish: () => {
        request.signal.removeEventListener('abort', abort);
        deadline.signal.removeEventListener('abort', expire);
        deadline.dispose();
        releaseMonitor();
        if (this.active === active) this.active = undefined;
        this.changed();
        release();
      },
    };
  }

  async handle(request: Request, url: URL): Promise<Response> {
    const route = url.pathname.slice('/api/audio/'.length);
    if (request.method === 'GET') {
      const status = OfflineSpeechStatusSchema.parse(
        await this.speech.status(url.searchParams.get('language') ?? undefined),
      );
      if (route === 'offline-status') return json(status);
      if (route === 'voices')
        return json({ voices: status.kokoro.state === 'ready' ? status.voices : [] });
      if (route === 'engine-status') {
        const selected = (await this.store.readConfig()).defaultSttModel;
        const stt = selected
          ? selected === 'system'
            ? 'system'
            : 'whisper'
          : status.system.state === 'ready'
            ? 'system'
            : 'whisper';
        const health = (engine: 'system' | 'whisper' | 'kokoro') => ({
          status:
            status[engine].state === 'ready'
              ? 'ok'
              : status[engine].state === 'download-required'
                ? 'no-model'
                : 'not-configured',
          provider: engine,
          modelCount: status[engine].state === 'ready' ? 1 : 0,
          ...(status[engine].reason ? { error: status[engine].reason } : {}),
        });
        return json({
          stt:
            selected && selected !== 'system' && selected !== status.whisper.model
              ? {
                  status: 'no-model',
                  provider: 'whisper',
                  modelCount: 0,
                  error: 'The selected speech model is not installed.',
                }
              : health(stt),
          tts: health('kokoro'),
        });
      }
      if (route === 'catalog') return json({ stt: [], tts: [] });
      if (route === 'stt/models' || route === 'tts/models') {
        return json({ models: status.models?.[route === 'stt/models' ? 'stt' : 'tts'] ?? [] });
      }
      return json({ error: 'Audio route not found' }, 404);
    }
    if (
      request.method !== 'POST' ||
      !['transcribe', 'synthesize', 'synthesize-stream'].includes(route)
    )
      return json({ error: 'This speech operation is unavailable on this device.' }, 501);
    const body = await request.json();
    const parsed =
      route === 'transcribe'
        ? AudioTranscribeRequestSchema.parse(body)
        : AudioSynthesizeRequestSchema.parse(body);
    const operation = this.begin(request);
    if (route === 'synthesize-stream') {
      let closed = false;
      const stream = new ReadableStream<Uint8Array>({
        start: async (controller) => {
          const emit = (event: AudioSynthesizeEvent) => {
            if (!closed && !operation.signal.aborted)
              controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
          };
          try {
            const result = await this.synthesize(
              parsed as AudioSynthesizeRequest,
              operation.signal,
              emit,
            );
            emit({ type: 'done', result });
          } catch (error) {
            emit({
              type: 'error',
              error: error instanceof Error ? error.message : 'Speech synthesis failed',
            });
          } finally {
            operation.finish();
            if (!closed) controller.close();
            closed = true;
          }
        },
        cancel: () => {
          closed = true;
          operation.abort();
        },
      });
      return new Response(stream, {
        headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
      });
    }
    try {
      operation.signal.throwIfAborted();
      if (route === 'transcribe') {
        const req = AudioTranscribeRequestSchema.parse(parsed);
        const projectId = req.projectId ?? 'default';
        if (!(await this.store.getProject(projectId)))
          return json({ error: 'Project not found' }, 404);
        const audio =
          'data' in req.audio
            ? speechBytes(req.audio.data)
            : await this.store.readFileBytes(
                'artifacts',
                projectId,
                req.audio.artifactPath.replace(/^artifacts\//, ''),
              );
        if (!audio) return json({ error: 'Audio file not found' }, 404);
        const result = await transcribeOffline(
          this.speech,
          {
            audio,
            mimeType: 'mimeType' in req.audio ? req.audio.mimeType : 'audio/wav',
            model: req.model ?? (await this.store.readConfig()).defaultSttModel,
            language: req.language,
            prompt: req.prompt,
          },
          operation.signal,
        );
        operation.signal.throwIfAborted();
        return json(AudioTranscribeResponseSchema.parse(result));
      }
      return json(await this.synthesize(parsed as AudioSynthesizeRequest, operation.signal));
    } finally {
      operation.finish();
    }
  }

  private async synthesize(
    req: AudioSynthesizeRequest,
    signal: AbortSignal,
    emit?: (event: AudioSynthesizeEvent) => void,
  ) {
    if (req.text.length > 12_000)
      throw new Error('Speak up to 12,000 characters at a time on this device.');
    const projectId = req.projectId ?? 'default';
    if (!(await this.store.getProject(projectId))) throw new Error('Project not found');
    let voice = req.voice;
    if (!voice && req.gezelId)
      voice = (await this.store.getGezel(req.gezelId))?.parsed.frontmatter.voice;
    const status = OfflineSpeechStatusSchema.parse(await this.speech.status());
    signal.throwIfAborted();
    requireOfflineSpeech(status, 'kokoro');
    if (req.model && req.model !== status.kokoro.model)
      throw new Error('The selected Kokoro model is not installed.');
    if (voice && !status.voices.some((item) => item.id === voice))
      throw new Error('The selected Kokoro voice is not installed.');
    const output = await this.speech.synthesize(
      { text: req.text, model: req.model, voice, speed: req.speed },
      signal,
      {
        onProgress: (progress) => emit?.({ type: 'progress', progress }),
        onChunk: (chunk) => emit?.({ type: 'chunk', chunk }),
      },
    );
    signal.throwIfAborted();
    const meta = AudioSynthesizeMetaSchema.parse(output.meta);
    if (voice && meta.voice !== voice)
      throw new Error('The speech engine changed the requested voice.');
    if (meta.model !== status.kokoro.model || !status.voices.some((item) => item.id === meta.voice))
      throw new Error('The speech engine returned an unavailable model or voice.');
    const b64Wav = speechBase64(output.wav);
    const relative = `audio/tts-${crypto.randomUUID()}.wav`;
    await this.store.writeFileBytes('artifacts', projectId, relative, output.wav, {
      createOnly: true,
    });
    return { artifactPath: `artifacts/${relative}`, meta, ...(req.inline ? { b64Wav } : {}) };
  }
}
