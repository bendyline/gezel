import { KOKORO_VOICES, SPEECH_MODEL_CATALOG } from '@bendyline/gezel/speech-models';
import { describe, expect, it, vi } from 'vitest';
import { MOBILE_SPEECH_MODELS, mobileSpeechModel } from './speech-catalog.js';
import {
  type GezelOfflineSpeechPlugin,
  MobileSpeechError,
  createMobileSpeech,
  kokoroWordTimings,
  splitSentences,
  wavToPcm16,
  whisperWords,
} from './speech.js';

const LEXICON = 'good ɡ ˈ ʊ d\nhello h ə l ˈ O\nmorning m ˈ ɔ ɹ n ɪ ŋ\nworld w ˈ ɜ ɹ l d\n';

function wav(samples: number[], rate: number, channels = 1): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const text = (at: number, value: string) => {
    for (let i = 0; i < 4; i++) bytes[at + i] = value.charCodeAt(i);
  };
  text(0, 'RIFF');
  view.setUint32(4, bytes.length - 8, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, i) => view.setInt16(44 + i * 2, sample, true));
  return bytes;
}

function pcmBase64(samples: number[]): string {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  samples.forEach((sample, i) => view.setInt16(i * 2, sample, true));
  return Buffer.from(bytes).toString('base64');
}

function rejection(message: string, code: string) {
  return Object.assign(new Error(message), { code });
}

function fixture(overrides: Partial<GezelOfflineSpeechPlugin> = {}) {
  const listeners: ((event: { id: string; receivedBytes: number; totalBytes: number }) => void)[] =
    [];
  const plugin: GezelOfflineSpeechPlugin = {
    status: vi.fn(async () => ({ available: true, models: [] })),
    install: vi.fn(async ({ id }) => ({ id })),
    cancelInstall: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    transcribe: vi.fn(async () => ({ language: 'en', segments: [], durationMs: 1 })),
    synthesize: vi.fn(async () => ({ pcm: '', sampleRate: 24_000, durations: [], durationMs: 1 })),
    cancel: vi.fn(async () => undefined),
    release: vi.fn(async () => undefined),
    addListener: vi.fn(async (_event, listener) => {
      listeners.push(listener);
      return { remove: async () => void listeners.splice(listeners.indexOf(listener), 1) };
    }),
    ...overrides,
  } as GezelOfflineSpeechPlugin;
  const speech = createMobileSpeech({
    plugin,
    lexicon: async () => LEXICON,
    downloadRetryDelaysMs: [1, 1, 1],
  });
  const progress = (id: string, receivedBytes: number) => {
    for (const listener of [...listeners]) listener({ id, receivedBytes, totalBytes: 0 });
  };
  return { plugin, speech, progress, listeners };
}

describe('mobile speech catalog', () => {
  it('downloads the Whisper files and Kokoro voices desktop pins', () => {
    for (const model of MOBILE_SPEECH_MODELS.filter((entry) => entry.kind === 'stt')) {
      const desktop = SPEECH_MODEL_CATALOG.find((entry) => entry.id === model.id);
      expect(model.files, model.id).toEqual(desktop?.files);
      expect(model.model).toBe(desktop?.files[0]?.name);
    }
    const kokoro = mobileSpeechModel('kokoro-82m-v1.0');
    const desktop = SPEECH_MODEL_CATALOG.find((entry) => entry.id === 'kokoro-82m-v1.0');
    expect(kokoro?.voices?.map((voice) => voice.id)).toEqual(
      KOKORO_VOICES.map((voice) => voice.id),
    );
    for (const voice of desktop?.files.filter((file) => file.name.startsWith('voices/')) ?? [])
      expect(kokoro?.files).toContainEqual(voice);
    // The same timestamped export at the same revision; only the weights differ.
    const graph = kokoro?.files.find((file) => file.name === kokoro.model);
    const desktopGraph = desktop?.files.find((file) => file.name.endsWith('.onnx'));
    expect(graph?.url.replace(/[^/]+$/, '')).toBe(desktopGraph?.url.replace(/[^/]+$/, ''));
  });
});

describe('speech helpers', () => {
  it('normalizes a stereo 48 kHz take to mono 16 kHz PCM16', () => {
    const frames = 4800;
    const samples: number[] = [];
    for (let i = 0; i < frames; i++) samples.push(1000, 3000);
    const pcm = wavToPcm16(wav(samples, 48_000, 2));
    expect(pcm.length).toBe((frames / 3) * 2);
    expect(new DataView(pcm.buffer).getInt16(10, true)).toBe(2000);
  });

  it('rejects compressed audio in plain words', () => {
    expect(() => wavToPcm16(new Uint8Array(10))).toThrow(MobileSpeechError);
  });

  it('joins sub-word tokens into words and skips markers', () => {
    expect(
      whisperWords([
        { start: 0, end: 0.2, text: '[_BEG_]' },
        { start: 0, end: 0.3, text: ' We' },
        { start: 0.3, end: 0.4, text: "'re" },
        { start: 0.5, end: 0.9, text: ' ready' },
        { start: 0.9, end: 1, text: '.' },
      ]),
    ).toEqual([
      { start: 0, end: 0.4, text: "We're" },
      { start: 0.5, end: 1, text: 'ready.' },
    ]);
  });

  it('keeps sentence offsets into the request text', () => {
    expect(splitSentences('  Hello world.  Good morning! ')).toEqual([
      { text: 'Hello world.', start: 2, end: 14 },
      { text: 'Good morning!', start: 16, end: 29 },
    ]);
  });

  it('times words from token durations and refuses inconsistent ones', () => {
    const utterance = {
      tokens: [0, 1, 2, 0],
      words: [{ textStart: 0, textEnd: 2, tokenStart: 1, tokenEnd: 3 }],
    };
    // Frames: 1 + 2 (2.5 rounds to even) + 3 + 1 = 7.
    const timings = kokoroWordTimings(utterance, [1, 2.5, 3.2, 0.4], 7 * 600);
    expect(timings).toEqual([{ textStart: 0, textEnd: 2, startSec: 1 / 40, endSec: 6 / 40 }]);
    expect(kokoroWordTimings(utterance, [1, 2.5, 3.2, 0.4], 100)).toBeUndefined();
    expect(kokoroWordTimings(utterance, [1, 2], 7 * 600)).toBeUndefined();
  });
});

describe('createMobileSpeech', () => {
  it('reports a model installed only when every catalog file is', async () => {
    const whisper = mobileSpeechModel('whisper-base.en');
    const { speech } = fixture({
      status: vi.fn(async () => ({
        available: true,
        models: [
          { id: 'whisper-base.en', files: whisper?.files.map((file) => file.name) ?? [] },
          { id: 'kokoro-82m-v1.0', files: ['voices/af_heart.bin'] },
        ],
      })),
    });
    expect([...(await speech.status()).installed]).toEqual(['whisper-base.en']);
  });

  it('resumes an interrupted download while it keeps making progress', async () => {
    let attempt = 0;
    const { speech, progress, plugin } = fixture();
    plugin.install = vi.fn(async ({ id }) => {
      attempt++;
      progress(id, attempt * 100);
      if (attempt < 6) throw rejection('unexpected end of stream', 'interrupted');
      return { id };
    });
    const phases: string[] = [];
    await speech.install('whisper-tiny.en', { onProgress: (event) => phases.push(event.phase) });
    expect(attempt).toBe(6);
    expect(phases).toContain('retrying');
  });

  it('gives up when retries save nothing, and never retries a damaged file', async () => {
    const { speech, plugin } = fixture();
    plugin.install = vi.fn(async () => {
      throw rejection('unexpected end of stream', 'interrupted');
    });
    await expect(speech.install('whisper-tiny.en')).rejects.toMatchObject({ code: 'interrupted' });
    expect(plugin.install).toHaveBeenCalledTimes(4);
    plugin.install = vi.fn(async () => {
      throw rejection('damaged', 'verification');
    });
    await expect(speech.install('whisper-tiny.en')).rejects.toMatchObject({ code: 'verification' });
    expect(plugin.install).toHaveBeenCalledTimes(1);
  });

  it('cancels the native download when the caller aborts', async () => {
    const controller = new AbortController();
    const { speech, plugin } = fixture();
    plugin.install = vi.fn(async () => {
      controller.abort();
      throw rejection('Download cancelled', 'cancelled');
    });
    await expect(
      speech.install('whisper-tiny.en', { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'cancelled' });
    expect(plugin.cancelInstall).toHaveBeenCalled();
  });

  it('transcribes with the model file, merges words, and drops blank audio', async () => {
    const { speech, plugin } = fixture({
      transcribe: vi.fn(async () => ({
        language: 'en',
        durationMs: 5,
        segments: [
          {
            start: 0,
            end: 1,
            text: ' Hello there.',
            tokens: [
              { start: 0, end: 0.4, text: ' Hello' },
              { start: 0.4, end: 1, text: ' there.' },
            ],
          },
          { start: 1, end: 2, text: ' [BLANK_AUDIO]' },
        ],
      })),
    });
    const result = await speech.transcribe({
      wav: wav([0, 1, 2, 3], 16_000),
      model: 'whisper-base.en',
      words: true,
    });
    expect(plugin.transcribe).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'whisper-base.en', file: 'ggml-base.en.bin', words: true }),
    );
    expect(result).toEqual({
      text: 'Hello there.',
      language: 'en',
      durationMs: 5,
      segments: [
        {
          start: 0,
          end: 1,
          text: 'Hello there.',
          words: [
            { start: 0, end: 0.4, text: 'Hello' },
            { start: 0.4, end: 1, text: 'there.' },
          ],
        },
      ],
    });
  });

  it('stops a native request when the caller aborts', async () => {
    const controller = new AbortController();
    const { speech, plugin } = fixture({
      transcribe: vi.fn(async ({ requestId }) => {
        controller.abort();
        expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
        throw rejection('Speech stopped', 'cancelled');
      }),
    });
    await expect(
      speech.transcribe({
        wav: wav([0, 1], 16_000),
        model: 'whisper-tiny.en',
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'cancelled' });
    expect(plugin.cancel).toHaveBeenCalled();
  });

  it('speaks sentence by sentence with source offsets and word times', async () => {
    const { speech, plugin } = fixture({
      synthesize: vi.fn(async ({ tokens }) => {
        // One frame per token, so durations line up with the samples.
        const samples = new Array(tokens.length * 600).fill(16_384);
        return {
          pcm: pcmBase64(samples),
          sampleRate: 24_000,
          durations: tokens.map(() => 1),
          durationMs: 1,
        };
      }),
    });
    const text = 'Hello world. Good morning.';
    const chunks: { textStart: number; textEnd: number; words: number }[] = [];
    const summary = await speech.synthesize({
      text,
      voice: 'bf_emma',
      onChunk: (chunk) => {
        expect(chunk.pcm[0]).toBeCloseTo(0.5);
        chunks.push({
          textStart: chunk.textStart,
          textEnd: chunk.textEnd,
          words: chunk.wordTimings?.length ?? 0,
        });
      },
    });
    expect(chunks).toEqual([
      { textStart: 0, textEnd: 12, words: 2 },
      { textStart: 13, textEnd: 26, words: 2 },
    ]);
    expect(summary).toMatchObject({ voice: 'bf_emma', model: 'kokoro-82m-v1.0', chunks: 2 });
    expect(plugin.synthesize).toHaveBeenCalledWith(
      expect.objectContaining({
        file: 'onnx/model_quantized.onnx',
        voices: 'voices/bf_emma.bin',
        voice: 0,
      }),
    );
  });

  it('refuses unknown voices and empty text in plain words', async () => {
    const { speech } = fixture();
    await expect(speech.synthesize({ text: 'Hello.', voice: 'zz_nobody' })).rejects.toMatchObject({
      code: 'invalid-input',
    });
    await expect(speech.synthesize({ text: '   ' })).rejects.toMatchObject({
      code: 'invalid-input',
    });
  });
});
