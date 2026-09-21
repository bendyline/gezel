import { describe, expect, it, vi } from 'vitest';
import { AudioSynthesizeResponseSchema } from '../schemas/audio.js';
import type { OfflineSpeechStatus } from '../schemas/offline-speech.js';
import { type PortableInference, PortableProductService } from './product-service.js';
import { speechBase64, speechBytes } from './speech-bytes.js';
import { OfflineSpeechError, type PortableSpeech, transcribeOffline } from './speech.js';
import { portableFixture } from './test-files.js';

function fixture() {
  const status: OfflineSpeechStatus = {
    system: { state: 'ready', model: 'system' },
    whisper: { state: 'ready', model: 'whisper-tiny' },
    kokoro: { state: 'ready', model: 'kokoro-v1' },
    voices: [{ id: 'af_heart', name: 'Heart', language: 'en-US', modelId: 'kokoro-v1' }],
  };
  const result = { text: 'Hello', durationMs: 12 };
  const speech: PortableSpeech = {
    status: vi.fn(async () => status),
    transcribe: vi.fn(async () => result),
    synthesize: vi.fn(async (input) => ({
      wav: new Uint8Array([82, 73, 70, 70]),
      meta: {
        voice: input.voice ?? 'af_heart',
        model: 'kokoro-v1',
        sampleRate: 24000,
        durationSeconds: 1,
        durationMs: 10,
      },
    })),
  };
  return { status, speech, result };
}
const input = { audio: new Uint8Array([1]), mimeType: 'audio/wav' };

describe('offline speech selection', () => {
  it('prefers local system recognition and preserves language and context', async () => {
    const f = fixture();
    const request = { ...input, language: 'nl-NL', prompt: 'Gezel' };
    const signal = new AbortController().signal;
    expect(await transcribeOffline(f.speech, request, signal)).toEqual(f.result);
    expect(f.speech.status).toHaveBeenCalledWith('nl-NL');
    expect(f.speech.transcribe).toHaveBeenCalledExactlyOnceWith('system', request, signal);
  });
  it.each(['unavailable', 'download-required'] as const)(
    'uses installed Whisper when system speech is %s',
    async (state) => {
      const f = fixture();
      f.status.system.state = state;
      await transcribeOffline(f.speech, input, new AbortController().signal);
      expect(f.speech.transcribe).toHaveBeenCalledWith('whisper', input, expect.any(AbortSignal));
    },
  );
  it('falls back if system assets disappear between probing and recognition', async () => {
    const f = fixture();
    vi.mocked(f.speech.transcribe).mockRejectedValueOnce(
      new OfflineSpeechError('Model missing', 'download-required'),
    );
    await transcribeOffline(f.speech, input, new AbortController().signal);
    expect(vi.mocked(f.speech.transcribe).mock.calls.map(([engine]) => engine)).toEqual([
      'system',
      'whisper',
    ]);
  });
  it.each(['permission-required', 'failed'] as const)(
    'does not hide a %s failure by changing recognizers',
    async (code) => {
      const f = fixture();
      vi.mocked(f.speech.transcribe).mockRejectedValue(new OfflineSpeechError('Stopped', code));
      await expect(
        transcribeOffline(f.speech, input, new AbortController().signal),
      ).rejects.toThrow('Stopped');
      expect(f.speech.transcribe).toHaveBeenCalledTimes(1);
    },
  );
  it('honors a pinned Whisper model even when system STT is ready', async () => {
    const f = fixture();
    const request = { ...input, model: 'whisper-tiny' };
    await transcribeOffline(f.speech, request, new AbortController().signal);
    expect(f.speech.transcribe).toHaveBeenCalledWith('whisper', request, expect.any(AbortSignal));
  });
  it('never starts a fallback after cancellation', async () => {
    const f = fixture();
    const controller = new AbortController();
    vi.mocked(f.speech.transcribe).mockImplementation(async () => {
      controller.abort();
      throw new OfflineSpeechError('Unavailable', 'unavailable');
    });
    await expect(transcribeOffline(f.speech, input, controller.signal)).rejects.toThrow();
    expect(f.speech.transcribe).toHaveBeenCalledTimes(1);
  });
  it('fails offline when neither recognizer is ready', async () => {
    const f = fixture();
    f.status.system.state = 'unavailable';
    f.status.whisper.state = 'download-required';
    await expect(
      transcribeOffline(f.speech, input, new AbortController().signal),
    ).rejects.toThrow();
    expect(f.speech.transcribe).not.toHaveBeenCalled();
  });
});

async function product() {
  const f = fixture();
  const { store, files } = portableFixture();
  const inference: PortableInference = {
    providers: async () => [],
    generate: vi.fn(),
    cancel: vi.fn(),
  };
  const service = new PortableProductService(store, inference, 'secret', { speech: f.speech });
  await service.initialize();
  const request = (route: string, body?: unknown, signal?: AbortSignal) =>
    service.fetch(`https://gezel.local/api/audio/${route}`, {
      method: body ? 'POST' : 'GET',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal,
    });
  return { ...f, store, files, service, request };
}
describe('shared speech API on the portable runtime', () => {
  it('honors the same saved STT preference as desktop', async () => {
    const f = await product();
    await f.store.writeConfig({ ...(await f.store.readConfig()), defaultSttModel: 'whisper-tiny' });
    expect(
      (await f.request('transcribe', { audio: { data: speechBase64(input.audio) } })).status,
    ).toBe(200);
    expect(f.speech.transcribe).toHaveBeenCalledWith(
      'whisper',
      expect.objectContaining({ model: 'whisper-tiny' }),
      expect.any(AbortSignal),
    );
    const cleared = await f.service.fetch('https://gezel.local/api/config', {
      method: 'PUT',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({ defaultSttModel: null }),
    });
    expect(cleared.status).toBe(200);
    expect((await f.store.readConfig()).defaultSttModel).toBeUndefined();
  });
  it('resolves ordinary project artifacts through the Store', async () => {
    const f = await product();
    await f.store.writeFileBytes('artifacts', 'default', 'audio/input.wav', input.audio);
    const response = await f.request('transcribe', {
      audio: { artifactPath: 'artifacts/audio/input.wav' },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(f.result);
    expect(f.speech.transcribe).toHaveBeenCalledWith(
      'system',
      expect.objectContaining({ audio: input.audio }),
      expect.any(AbortSignal),
    );
  });
  it('rejects malformed audio and traversal before inference', async () => {
    const f = await product();
    for (const audio of [{ data: '%%%=' }, { artifactPath: '../config.json' }])
      expect((await f.request('transcribe', { audio })).status).toBe(400);
    expect(f.speech.transcribe).not.toHaveBeenCalled();
  });
  it('uses the saved gezel voice and stores a standard audio artifact', async () => {
    const f = await product();
    const gezel = await f.store.createGezel({ name: 'Voice', frontmatter: { voice: 'af_heart' } });
    const response = await f.request('synthesize', {
      text: 'Hello',
      gezelId: gezel.id,
      inline: true,
    });
    expect(response.status).toBe(200);
    const result = AudioSynthesizeResponseSchema.parse(await response.json());
    expect(result.meta.voice).toBe('af_heart');
    expect(
      await f.store.readFileBytes(
        'artifacts',
        'default',
        result.artifactPath.replace(/^artifacts\//, ''),
      ),
    ).toEqual(speechBytes(result.b64Wav!));
  });
  it('never substitutes a different TTS voice or downloads a missing model', async () => {
    const f = await product();
    expect((await f.request('synthesize', { text: 'Hello', voice: 'missing' })).status).toBe(400);
    f.status.kokoro.state = 'download-required';
    expect((await f.request('synthesize', { text: 'Hello' })).status).toBe(400);
    expect(f.speech.synthesize).not.toHaveBeenCalled();
  });
  it('keeps admission until a cancelled native operation settles and saves no late audio', async () => {
    const f = await product();
    let started!: () => void;
    let finish!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const released = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const output = await f.speech.synthesize({ text: 'Hi' }, new AbortController().signal);
    vi.mocked(f.speech.synthesize).mockImplementation(async () => {
      started();
      await released;
      return output;
    });
    const running = f.request('synthesize', { text: 'Hi' });
    await ready;
    expect(f.service.busy).toBe(true);
    const paused = f.service.suspend();
    expect(
      (await f.request('transcribe', { audio: { data: speechBase64(input.audio) } })).status,
    ).toBe(409);
    finish();
    await paused;
    expect(f.service.busy).toBe(false);
    await expect(running).rejects.toThrow();
    expect([...f.files.entries.keys()].some((path) => /tts-.*\.wav$/.test(path))).toBe(false);
  });
  it('retains the desktop SSE completion shape', async () => {
    const f = await product();
    const response = await f.request('synthesize-stream', { text: 'Hello' });
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(await response.text()).toContain('"type":"done"');
  });
});
