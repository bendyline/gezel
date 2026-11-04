import {
  type KokoroLexicon,
  type KokoroPlannedUtterance,
  parseKokoroLexicon,
  planKokoroSpeech,
} from '@bendyline/gezel/kokoro';
import { type PluginListenerHandle, registerPlugin } from '@capacitor/core';
import {
  KOKORO_DEFAULT_VOICE,
  KOKORO_SAMPLE_RATE,
  MOBILE_SPEECH_MODELS,
  type MobileSpeechFile,
  type MobileSpeechModel,
  mobileSpeechModel,
  speechDownloadBytes,
} from './speech-catalog.js';

/**
 * Offline speech on this device: Whisper dictation and Kokoro narration.
 *
 * The native GezelOfflineSpeech plugin runs the engines and stores verified model
 * files; this module chooses files from the catalog, normalizes audio, and
 * plans Kokoro's phonemes in JavaScript with the same dictionaries the desktop
 * daemon uses (no eSpeak NG). Nothing downloads or loads a model until a
 * caller asks.
 */

export type MobileSpeechErrorCode =
  | 'unavailable'
  | 'model-missing'
  | 'busy'
  | 'cancelled'
  | 'paused'
  | 'interrupted'
  | 'verification'
  | 'invalid-input'
  | 'resources'
  | 'storage'
  | 'failed';

export class MobileSpeechError extends Error {
  constructor(
    message: string,
    readonly code: MobileSpeechErrorCode,
  ) {
    super(message);
    this.name = 'MobileSpeechError';
  }
}

interface NativeToken {
  start: number;
  end: number;
  text: string;
}
interface NativeSegment {
  start: number;
  end: number;
  text: string;
  tokens?: NativeToken[];
}

/** App-owned native speech. Model ids and file names are validated natively; JavaScript never supplies paths. */
export interface GezelOfflineSpeechPlugin {
  status(): Promise<{
    available: boolean;
    reason?: string;
    models: { id: string; files: string[] }[];
    downloading?: string;
  }>;
  install(options: { id: string; files: readonly MobileSpeechFile[] }): Promise<{ id: string }>;
  cancelInstall(): Promise<void>;
  remove(options: { id: string }): Promise<void>;
  transcribe(options: {
    requestId: string;
    model: string;
    file: string;
    /** Base64 mono 16 kHz PCM16. */
    audio: string;
    language?: string;
    prompt?: string;
    words?: boolean;
  }): Promise<{ language: string | null; segments: NativeSegment[]; durationMs: number }>;
  synthesize(options: {
    requestId: string;
    model: string;
    file: string;
    voices: string;
    voice: number;
    tokens: readonly number[];
    speed: number;
  }): Promise<{ pcm: string; sampleRate: number; durations: number[]; durationMs: number }>;
  cancel(options: { requestId: string }): Promise<void>;
  /** Free loaded models now instead of after the idle timeout. */
  release(): Promise<void>;
  addListener(
    event: 'speechDownload',
    listener: (event: { id: string; receivedBytes: number; totalBytes: number }) => void,
  ): Promise<PluginListenerHandle>;
}

export const GezelOfflineSpeech = registerPlugin<GezelOfflineSpeechPlugin>('GezelOfflineSpeech');

export interface MobileSpeechStatus {
  /** The engine is in this build and can load. */
  readonly available: boolean;
  readonly reason?: string;
  /** Models whose every catalog file is installed and verified. */
  readonly installed: ReadonlySet<string>;
  readonly downloading?: string;
}

export interface MobileSpeechDownloadProgress {
  readonly phase: 'downloading' | 'retrying';
  readonly receivedBytes: number;
  readonly totalBytes: number;
  /** While retrying: seconds until the next attempt. */
  readonly retryInSeconds?: number;
}

export interface MobileSpeechWord {
  /** Seconds from the start of the take. */
  readonly start: number;
  readonly end: number;
  readonly text: string;
}
export interface MobileSpeechSegment {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly words?: readonly MobileSpeechWord[];
}
export interface MobileSpeechTranscript {
  /** Trimmed; empty when the take held no speech. */
  readonly text: string;
  readonly language: string | null;
  readonly segments: readonly MobileSpeechSegment[];
  readonly durationMs: number;
}

export interface MobileSpeechWordTiming {
  readonly textStart: number;
  readonly textEnd: number;
  readonly startSec: number;
  readonly endSec: number;
}
/** One independently playable piece of a synthesis, usually a sentence. */
export interface MobileSpeechChunk {
  readonly index: number;
  readonly pcm: Float32Array;
  readonly sampleRate: number;
  readonly durationSec: number;
  /** UTF-16 range of the request text this chunk speaks. */
  readonly textStart: number;
  readonly textEnd: number;
  readonly wordTimings?: readonly MobileSpeechWordTiming[];
}
export interface MobileSpeechSynthesis {
  readonly voice: string;
  readonly model: string;
  readonly sampleRate: number;
  readonly durationSec: number;
  readonly chunks: number;
}

export interface MobileSpeechOptions {
  /** Kokoro's pronunciation dictionary as text, for American (`us`) or British (`gb`) voices. */
  lexicon(language: 'us' | 'gb'): Promise<string>;
  plugin?: GezelOfflineSpeechPlugin;
  /** Waits before each retry of an interrupted download that saved no new bytes. */
  downloadRetryDelaysMs?: readonly number[];
}

const CODES = new Set<MobileSpeechErrorCode>([
  'unavailable',
  'model-missing',
  'busy',
  'cancelled',
  'paused',
  'interrupted',
  'verification',
  'invalid-input',
  'resources',
  'storage',
]);
// About a minute of trying while the network is gone: long enough to ride out
// a Wi-Fi to cellular handoff or a brief dead zone.
const RETRY_DELAYS_MS = [2_000, 5_000, 10_000, 20_000, 30_000];

/** Plugin rejections carry a string `code`; anything else is a plain failure. */
export function mobileSpeechError(error: unknown): MobileSpeechError {
  if (error instanceof MobileSpeechError) return error;
  const code =
    error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code
      : '';
  const message = error instanceof Error && error.message ? error.message : 'Speech failed';
  return new MobileSpeechError(
    message,
    CODES.has(code as MobileSpeechErrorCode) ? (code as MobileSpeechErrorCode) : 'failed',
  );
}

function cancelled(): MobileSpeechError {
  return new MobileSpeechError('Speech stopped', 'cancelled');
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(cancelled());
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', stop);
      resolve();
    }, ms);
    const stop = () => {
      clearTimeout(timer);
      reject(cancelled());
    };
    signal?.addEventListener('abort', stop, { once: true });
  });
}

/** Run one native request, cancelling it natively when the signal aborts. */
async function request<T>(
  plugin: GezelOfflineSpeechPlugin,
  signal: AbortSignal | undefined,
  run: (requestId: string) => Promise<T>,
): Promise<T> {
  if (signal?.aborted) throw cancelled();
  const requestId = crypto.randomUUID();
  const abort = () => void plugin.cancel({ requestId }).catch(() => undefined);
  signal?.addEventListener('abort', abort, { once: true });
  try {
    return await run(requestId);
  } catch (error) {
    throw signal?.aborted ? cancelled() : mobileSpeechError(error);
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}

function base64(bytes: Uint8Array): string {
  let text = '';
  for (let at = 0; at < bytes.length; at += 0x8000)
    text += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(text);
}

function pcm16ToFloat(encoded: string): Float32Array {
  const text = atob(encoded);
  const samples = new Float32Array(text.length >> 1);
  for (let i = 0; i < samples.length; i++) {
    const value = text.charCodeAt(2 * i) | (text.charCodeAt(2 * i + 1) << 8);
    samples[i] = (value > 0x7fff ? value - 0x10000 : value) / 32768;
  }
  return samples;
}

/**
 * Mono 16 kHz PCM16 from an uncompressed PCM WAV take, as Whisper wants it.
 * The same normalization as `speechPcm16` in `@bendyline/gezel/runtime`,
 * which this module does not import because that entry is large.
 */
export function wavToPcm16(wav: Uint8Array): Uint8Array {
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const tag = (at: number) => String.fromCharCode(...wav.subarray(at, at + 4));
  const invalid = (message: string) => new MobileSpeechError(message, 'invalid-input');
  if (wav.length < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE')
    throw invalid('Choose an uncompressed PCM WAV recording.');
  let rate = 0;
  let channels = 0;
  let data: Uint8Array | undefined;
  for (let at = 12; at + 8 <= wav.length; ) {
    const size = view.getUint32(at + 4, true);
    if (at + 8 + size > wav.length) throw invalid('The WAV recording is incomplete.');
    if (tag(at) === 'fmt ') {
      if (size < 16 || view.getUint16(at + 8, true) !== 1 || view.getUint16(at + 22, true) !== 16)
        throw invalid('Use a 16-bit PCM WAV recording.');
      channels = view.getUint16(at + 10, true);
      rate = view.getUint32(at + 12, true);
      if (channels < 1 || channels > 2 || rate < 8000 || rate > 96000)
        throw invalid('Unsupported WAV recording format.');
    }
    if (tag(at) === 'data') data = wav.subarray(at + 8, at + 8 + size);
    at += 8 + size + (size % 2);
  }
  if (!rate || !data?.length || data.length % (channels * 2) !== 0)
    throw invalid('The recording contains no complete audio samples.');
  const frames = data.length / (channels * 2);
  if (frames > rate * 120) throw invalid('Transcribe up to two minutes at a time on this device.');
  const samples = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const mono = (frame: number) => {
    let total = 0;
    for (let channel = 0; channel < channels; channel++)
      total += samples.getInt16((Math.min(frames - 1, frame) * channels + channel) * 2, true);
    return total / channels;
  };
  const length = Math.max(1, Math.floor((frames * 16000) / rate));
  const output = new Uint8Array(length * 2);
  const encoded = new DataView(output.buffer);
  for (let i = 0; i < length; ++i) {
    const start = (i * rate) / 16000;
    const end = Math.min(frames, ((i + 1) * rate) / 16000);
    let value = 0;
    for (let frame = Math.floor(start); frame < Math.ceil(end); frame++)
      value += mono(frame) * (Math.min(end, frame + 1) - Math.max(start, frame));
    encoded.setInt16(i * 2, Math.round(value / (end - start)), true);
  }
  return output;
}

/**
 * Words from Whisper's timed sub-word tokens: a token that starts with a
 * space begins a word; any other (`'re`, punctuation) continues the last one.
 */
export function whisperWords(tokens: readonly NativeToken[]): MobileSpeechWord[] {
  const words: { start: number; end: number; text: string }[] = [];
  for (const token of tokens) {
    if (!token.text || /^\[.*\]$/.test(token.text.trim())) continue;
    const current = words[words.length - 1];
    if (current && !/^\s/u.test(token.text)) {
      current.text += token.text;
      current.end = Math.max(current.end, token.end);
    } else {
      words.push({
        start: token.start,
        end: Math.max(token.start, token.end),
        text: token.text.trim(),
      });
    }
  }
  return words.filter((word) => word.text);
}

/** Sentences with their offsets: Gezel's split on `[.!?…]` followed by whitespace. */
export function splitSentences(text: string): { text: string; start: number; end: number }[] {
  const sentences: { text: string; start: number; end: number }[] = [];
  let cursor = 0;
  const push = (from: number, to: number) => {
    const raw = text.slice(from, to);
    const trimmed = raw.trim();
    if (!trimmed) return;
    const start = from + raw.length - raw.trimStart().length;
    sentences.push({ text: trimmed, start, end: start + trimmed.length });
  };
  for (const match of text.matchAll(/(?<=[.!?…])\s+/gu)) {
    push(cursor, match.index);
    cursor = match.index + match[0].length;
  }
  push(cursor, text.length);
  return sentences;
}

/** Timestamped Kokoro reports predictions before ONNX Round (ties to even) and Clip. */
function durationFrames(prediction: number): number {
  const lower = Math.floor(prediction);
  return Math.max(1, prediction - lower === 0.5 ? lower + (lower % 2) : Math.round(prediction));
}

/** Word times from per-token durations; inconsistent metadata yields none rather than wrong times. */
export function kokoroWordTimings(
  utterance: Pick<KokoroPlannedUtterance, 'tokens' | 'words'>,
  predictions: readonly number[],
  sampleCount: number,
): MobileSpeechWordTiming[] | undefined {
  if (predictions.length !== utterance.tokens.length) return undefined;
  const boundaries = [0];
  let frames = 0;
  for (const prediction of predictions) {
    if (!Number.isFinite(prediction) || prediction < 0) return undefined;
    frames += durationFrames(prediction);
    boundaries.push(frames);
  }
  // The graph emits 600 samples per frame at 24 kHz.
  if (frames * 600 !== sampleCount) return undefined;
  return utterance.words.map((word) => ({
    textStart: word.textStart,
    textEnd: word.textEnd,
    startSec: (boundaries[word.tokenStart] ?? 0) / 40,
    endSec: (boundaries[word.tokenEnd] ?? frames) / 40,
  }));
}

export function createMobileSpeech(options: MobileSpeechOptions) {
  const plugin = options.plugin ?? GezelOfflineSpeech;
  const lexicons = new Map<'us' | 'gb', Promise<KokoroLexicon>>();
  const lexicon = (language: 'us' | 'gb') => {
    const cached = lexicons.get(language);
    if (cached) return cached;
    const pending = options.lexicon(language).then(
      (text) => parseKokoroLexicon(text, { language }),
      () => {
        throw new MobileSpeechError(
          'The narration pronunciation dictionary is missing from this build.',
          'unavailable',
        );
      },
    );
    // A failed read must not be cached as a permanent failure.
    void pending.catch(() => lexicons.delete(language));
    lexicons.set(language, pending);
    return pending;
  };
  const pick = (id: string, kind: 'stt' | 'tts'): MobileSpeechModel => {
    const model = mobileSpeechModel(id);
    if (!model || model.kind !== kind)
      throw new MobileSpeechError(
        'This speech model is not available on this device.',
        'invalid-input',
      );
    return model;
  };

  return {
    models: MOBILE_SPEECH_MODELS,

    async status(): Promise<MobileSpeechStatus> {
      let value: Awaited<ReturnType<GezelOfflineSpeechPlugin['status']>>;
      try {
        value = await plugin.status();
      } catch (error) {
        throw mobileSpeechError(error);
      }
      const installed = new Set<string>();
      for (const entry of value.models) {
        const model = mobileSpeechModel(entry.id);
        if (model?.files.every((file) => entry.files.includes(file.name))) installed.add(model.id);
      }
      return {
        available: value.available,
        ...(value.reason ? { reason: value.reason } : {}),
        installed,
        ...(value.downloading ? { downloading: value.downloading } : {}),
      };
    },

    /**
     * Download and verify a model. An interrupted transfer resumes where it
     * stopped; only attempts that save nothing new spend the retry budget.
     */
    async install(
      id: string,
      {
        signal,
        onProgress,
      }: {
        signal?: AbortSignal;
        onProgress?: (progress: MobileSpeechDownloadProgress) => void;
      } = {},
    ): Promise<void> {
      const model = mobileSpeechModel(id);
      if (!model)
        throw new MobileSpeechError(
          'This speech model is not available on this device.',
          'invalid-input',
        );
      if (signal?.aborted) throw cancelled();
      const totalBytes = speechDownloadBytes(model);
      let received = 0;
      let saved = 0;
      let stalled = 0;
      const listener = await plugin.addListener('speechDownload', (event) => {
        if (event.id !== id) return;
        received = Math.max(received, event.receivedBytes);
        onProgress?.({ phase: 'downloading', receivedBytes: event.receivedBytes, totalBytes });
      });
      const abort = () => void plugin.cancelInstall().catch(() => undefined);
      signal?.addEventListener('abort', abort, { once: true });
      try {
        while (true) {
          try {
            await plugin.install({ id, files: model.files });
            return;
          } catch (error) {
            if (signal?.aborted) throw cancelled();
            const failure = mobileSpeechError(error);
            if (received > saved) {
              saved = received;
              stalled = 0;
            }
            const delay = (options.downloadRetryDelaysMs ?? RETRY_DELAYS_MS)[stalled++];
            if (failure.code !== 'interrupted' || delay === undefined) throw failure;
            onProgress?.({
              phase: 'retrying',
              receivedBytes: received,
              totalBytes,
              retryInSeconds: Math.max(1, Math.round(delay / 1000)),
            });
            await wait(delay, signal);
          }
        }
      } finally {
        signal?.removeEventListener('abort', abort);
        await listener.remove();
      }
    },

    async remove(id: string): Promise<void> {
      try {
        await plugin.remove({ id });
      } catch (error) {
        throw mobileSpeechError(error);
      }
    },

    async transcribe(input: {
      wav: Uint8Array;
      model: string;
      language?: string;
      prompt?: string;
      /** Add word times to each segment. */
      words?: boolean;
      signal?: AbortSignal;
    }): Promise<MobileSpeechTranscript> {
      const model = pick(input.model, 'stt');
      const audio = base64(wavToPcm16(input.wav));
      const result = await request(plugin, input.signal, (requestId) =>
        plugin.transcribe({
          requestId,
          model: model.id,
          file: model.model,
          audio,
          ...(input.language ? { language: input.language } : {}),
          ...(input.prompt ? { prompt: input.prompt } : {}),
          ...(input.words ? { words: true } : {}),
        }),
      );
      const segments = result.segments
        .map((segment) => {
          const words = input.words ? whisperWords(segment.tokens ?? []) : [];
          return {
            start: Math.max(0, segment.start),
            end: Math.max(segment.start, segment.end),
            text: segment.text.trim(),
            ...(words.length ? { words } : {}),
          };
        })
        .filter((segment) => segment.text && !/^\[\s*BLANK_AUDIO\s*\]$/iu.test(segment.text));
      return {
        text: segments
          .map((segment) => segment.text)
          .join(' ')
          .trim(),
        language: result.language,
        segments,
        durationMs: result.durationMs,
      };
    },

    /** Speak `text` sentence by sentence, handing each chunk over as soon as it is ready. */
    async synthesize(input: {
      text: string;
      voice?: string;
      speed?: number;
      model?: string;
      signal?: AbortSignal;
      onChunk?: (chunk: MobileSpeechChunk) => void;
      onProgress?: (completedCharacters: number, totalCharacters: number) => void;
    }): Promise<MobileSpeechSynthesis> {
      const model = pick(input.model ?? 'kokoro-82m-v1.0', 'tts');
      const voice = input.voice ?? KOKORO_DEFAULT_VOICE;
      if (!model.voices?.some((entry) => entry.id === voice))
        throw new MobileSpeechError(
          'This narration voice is not available on this device.',
          'invalid-input',
        );
      const speed = Math.min(2, Math.max(0.5, input.speed ?? 1));
      const dictionary = await lexicon(voice.startsWith('b') ? 'gb' : 'us');
      const utterances: KokoroPlannedUtterance[] = [];
      for (const sentence of splitSentences(input.text))
        for (const piece of planKokoroSpeech(sentence.text, { lexicon: dictionary }))
          utterances.push({
            ...piece,
            textStart: sentence.start + piece.textStart,
            textEnd: sentence.start + piece.textEnd,
            words: piece.words.map((word) => ({
              ...word,
              textStart: sentence.start + word.textStart,
              textEnd: sentence.start + word.textEnd,
            })),
          });
      if (!utterances.length)
        throw new MobileSpeechError('There is nothing to read aloud.', 'invalid-input');
      let durationSec = 0;
      for (const [index, utterance] of utterances.entries()) {
        input.onProgress?.(utterance.textStart, input.text.length);
        const result = await request(plugin, input.signal, (requestId) =>
          plugin.synthesize({
            requestId,
            model: model.id,
            file: model.model,
            voices: `voices/${voice}.bin`,
            voice: 0,
            tokens: utterance.tokens,
            speed,
          }),
        );
        const pcm = pcm16ToFloat(result.pcm);
        const wordTimings = kokoroWordTimings(utterance, result.durations, pcm.length);
        const seconds = pcm.length / result.sampleRate;
        durationSec += seconds;
        input.onChunk?.({
          index,
          pcm,
          sampleRate: result.sampleRate,
          durationSec: seconds,
          textStart: utterance.textStart,
          textEnd: utterance.textEnd,
          ...(wordTimings ? { wordTimings } : {}),
        });
      }
      input.onProgress?.(input.text.length, input.text.length);
      return {
        voice,
        model: model.id,
        sampleRate: KOKORO_SAMPLE_RATE,
        durationSec,
        chunks: utterances.length,
      };
    },

    /** Free loaded models now; the plugin also frees them after two idle minutes. */
    release(): Promise<void> {
      return plugin.release().catch(() => undefined);
    },
  };
}

export type MobileSpeech = ReturnType<typeof createMobileSpeech>;
