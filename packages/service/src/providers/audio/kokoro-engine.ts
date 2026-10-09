/**
 * The Kokoro inference engine: model loading, the phoneme frontend, and one
 * ONNX run per utterance.
 *
 * An ONNX run is synchronous and blocks whatever thread it is on for the
 * length of a sentence, so the daemon runs this on its own worker thread
 * (kokoro-worker.ts). In embedded mode the daemon shares Electron's main
 * process, and in-process narration beachballed the whole app for as long as
 * a reply took to synthesize. Only tests — and a daemon whose worker cannot
 * start — run it in-process.
 */

import { createLogger } from '@bendyline/gezel';
import { type LoadTransformersEnv, pinTransformersCacheDir } from '../../transformers-cache.js';
import { KokoroFrontend } from './kokoro-frontend.js';

const log = createLogger('audio');

export const KOKORO_HF_REPO = 'onnx-community/Kokoro-82M-v1.0-ONNX';

/**
 * Subset of the kokoro-js public API we depend on. Kept narrow so
 * tests can mock it without pulling in Transformers.js, and so an
 * upstream shape change surfaces as a concrete TypeScript error
 * rather than a runtime mystery.
 */
export interface KokoroJsModule {
  KokoroTTS: {
    from_pretrained(
      modelId: string,
      opts?: { dtype?: string; device?: string },
    ): Promise<KokoroTTSInstance>;
  };
  /**
   * Sentence splitter for {@link KokoroTTSInstance.stream}. Unused: the
   * engine splits and phonemizes text itself.
   */
  TextSplitterStream?: new () => KokoroTextSplitterStream;
}

export interface KokoroTextSplitterStream {
  push(...text: string[]): void;
  close(): void;
}

/**
 * `@huggingface/transformers`'s Tensor, narrowed to the one shape we build.
 * Declared structurally so tests can supply a stub without the real package.
 */
export interface KokoroTensorConstructor {
  new (type: 'int64', data: BigInt64Array, dims: readonly number[]): KokoroInputIds;
}

/** Opaque to us; kokoro-js only reads `dims` before handing it to ONNX. */
export interface KokoroInputIds {
  readonly dims: readonly number[];
}

export interface KokoroTTSInstance {
  generate(text: string, opts?: { voice?: string; speed?: number }): Promise<KokoroAudioOutput>;
  /**
   * Synthesize from phoneme ids. This is the entry point Gezel uses: it skips
   * kokoro-js's own text handling, which reaches for eSpeak NG through
   * `phonemizer`. See kokoro-frontend.ts.
   */
  generate_from_ids(
    inputIds: KokoroInputIds,
    opts?: { voice?: string; speed?: number },
  ): Promise<KokoroAudioOutput>;
  stream?(
    text: string | KokoroTextSplitterStream,
    opts?: { voice?: string; speed?: number; split_pattern?: RegExp | null },
  ): AsyncIterable<{ text: string; phonemes: string; audio: KokoroAudioOutput }>;
  // kokoro-js exposes voices as a getter on the prototype; `list_voices()`
  // exists but only `console.table()`s and returns undefined, so we never
  // call it.
  voices?: Record<string, { name?: string; language?: string; gender?: string }>;
}

export interface KokoroAudioOutput {
  audio: Float32Array;
  sampling_rate: number;
  /**
   * kokoro-js v1.2+ inherits `toWav()` from @huggingface/transformers's
   * `RawAudio`. It returns an `ArrayBuffer` (not a `Uint8Array`) — the
   * earlier shape was wrong and crashed `audioToWav` at runtime with
   * "first argument must be ... Received undefined" when we tried to
   * read `.buffer` / `.byteOffset` off an ArrayBuffer.
   */
  toWav?: () => ArrayBuffer;
  save?: (path: string) => Promise<void>;
}

/** The voices a loaded model carries, as plain data that survives a worker hop. */
export type KokoroVoiceTable = Record<
  string,
  { name?: string; language?: string; gender?: string }
>;

/** One synthesized utterance: 16-bit little-endian mono PCM. */
export interface KokoroUtteranceAudio {
  pcm: Uint8Array;
  sampleRate: number;
  /** Source characters the utterance covered, for progress reporting. */
  characters: number;
}

export interface KokoroSynthesisRequest {
  text: string;
  voice: string;
  speed: number;
}

export interface KokoroSynthesisHooks {
  /** Checked between utterances; an ONNX run cannot be interrupted mid-sentence. */
  cancelled(): boolean;
  onUtterance(audio: KokoroUtteranceAudio): void | Promise<void>;
}

/** Where synthesis runs: the worker thread, or in-process for tests and fallback. */
export interface KokoroBackend {
  /** Load the model, downloading it if needed. `deadline: false` is for pulls. */
  load(opts: { deadline: boolean }): Promise<KokoroVoiceTable | undefined>;
  synthesize(
    request: KokoroSynthesisRequest,
    signal: AbortSignal | undefined,
    onUtterance: (audio: KokoroUtteranceAudio) => void | Promise<void>,
  ): Promise<void>;
  /** Drop the loaded model; the next call reloads it. */
  unload(): Promise<void>;
  shutdown(): Promise<void>;
}

/** Settings the worker needs; plain data, because it crosses `workerData`. */
export interface KokoroEngineConfig {
  cacheDir: string;
  lexiconDir?: string;
  dtype: 'q4' | 'q8' | 'fp16' | 'fp32';
  inferenceTimeoutMs: number;
  loadTimeoutMs: number;
}

/** Loader seams. Functions cannot cross a worker boundary, so these force in-process. */
export interface KokoroEngineLoaders {
  loadKokoroJs?: () => Promise<KokoroJsModule>;
  loadTransformers?: () => Promise<{ Tensor: KokoroTensorConstructor }>;
  loadTransformersEnv?: LoadTransformersEnv;
}

/**
 * Raised when the engine stops producing audio within its watchdog
 * budget. Distinct from a generic Error so callers can tell "wedged
 * engine" apart from "bad input" — the route layer turns both into a
 * 500, but the message is what reaches the user.
 */
export class KokoroTimeoutError extends Error {
  readonly isTimeout = true;
  constructor(message: string) {
    super(message);
    this.name = 'KokoroTimeoutError';
  }
}

/**
 * Reject with {@link KokoroTimeoutError} if `operation` hasn't settled
 * within `ms`.
 *
 * Two properties this relies on:
 *
 * - `Promise.race` attaches handlers to every input, so a rejection that
 *   arrives *after* we've given up is still considered handled and won't
 *   trip an unhandledRejection.
 * - The timer is `unref`'d so a pending watchdog never by itself keeps
 *   the daemon (or a test worker) alive.
 *
 * It can only fire while this thread's event loop is free, so it catches an
 * asynchronous stall (a load waiting on the network) but not an ONNX run
 * that has wedged the thread. The worker host's own watchdog covers that.
 */
export async function withTimeout<T>(
  operation: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new KokoroTimeoutError(message)), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The message both watchdogs use when an utterance never finishes. */
export function kokoroStallMessage(timeoutMs: number, completedChunks: number): string {
  return `Kokoro produced no audio for ${Math.round(timeoutMs / 1000)}s after ${completedChunks} chunk(s) — giving up so the request doesn't hang. Retry, and restart the Gezel service if it persists.`;
}

/** The message both watchdogs use when the model never finishes loading. */
export function kokoroLoadStallMessage(timeoutMs: number): string {
  return `Loading the Kokoro model timed out after ${Math.round(timeoutMs / 1000)}s. If the weights are being re-downloaded this may just be a slow connection — retry, or re-pull the model from Settings → Audio.`;
}

/** Samples in [-1, 1] as 16-bit little-endian PCM, the body of a WAV. */
export function pcm16leFromFloat32(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i] ?? 0;
    view.setInt16(i * 2, Math.round((s > 1 ? 1 : s < -1 ? -1 : s) * 32767), true);
  }
  return out;
}

export class KokoroEngine {
  private readonly frontend: KokoroFrontend;
  private readonly loadKokoroJs: () => Promise<KokoroJsModule>;
  private readonly loadTransformers: () => Promise<{ Tensor: KokoroTensorConstructor }>;
  private readonly loadTransformersEnv: LoadTransformersEnv | undefined;
  private cachedModule: KokoroJsModule | null = null;
  private cachedTensor: Promise<KokoroTensorConstructor> | null = null;
  private cachedTts: KokoroTTSInstance | null = null;
  private loading: Promise<KokoroTTSInstance> | null = null;

  constructor(
    private readonly config: KokoroEngineConfig,
    loaders: KokoroEngineLoaders = {},
  ) {
    this.frontend = new KokoroFrontend(
      config.lexiconDir === undefined ? {} : { lexiconDir: config.lexiconDir },
    );
    this.loadKokoroJs = loaders.loadKokoroJs ?? defaultKokoroLoader;
    this.loadTransformers =
      loaders.loadTransformers ??
      (async () =>
        (await import('@huggingface/transformers')) as unknown as {
          Tensor: KokoroTensorConstructor;
        });
    this.loadTransformersEnv = loaders.loadTransformersEnv;
  }

  async load(opts: { deadline: boolean }): Promise<KokoroVoiceTable | undefined> {
    return voiceTable(await this.ensureLoaded(opts.deadline));
  }

  unload(): void {
    this.cachedTts = null;
    this.loading = null;
  }

  /**
   * Kokoro reads phoneme ids. `kokoro-js` will derive them itself, but only
   * through `phonemizer`, which embeds eSpeak NG — GPL-3 code that cannot
   * ship inside an MIT app on the app stores. So the text is phonemized by
   * the shared frontend (the same one the mobile host runs, against the same
   * dictionary) and fed to `generate_from_ids` one sentence at a time.
   */
  async synthesize(request: KokoroSynthesisRequest, hooks: KokoroSynthesisHooks): Promise<void> {
    const tts = await this.ensureLoaded(true);
    const utterances = await this.frontend.plan(request.text, request.voice);
    const Tensor = await this.tensorConstructor();
    let completed = 0;
    for (const utterance of utterances) {
      if (hooks.cancelled()) return;
      // The model wants int64 ids shaped [batch, tokens].
      const inputIds = new Tensor(
        'int64',
        BigInt64Array.from(utterance.tokens, (id) => BigInt(id)),
        [1, utterance.tokens.length],
      );
      // Each sentence keeps its own watchdog so one stall cannot pin the
      // request open forever.
      const audio = await withTimeout(
        tts.generate_from_ids(inputIds, { voice: request.voice, speed: request.speed }),
        this.config.inferenceTimeoutMs,
        kokoroStallMessage(this.config.inferenceTimeoutMs, completed),
      );
      if (hooks.cancelled()) return;
      completed += 1;
      await hooks.onUtterance({
        pcm: pcm16leFromFloat32(audio.audio),
        sampleRate: audio.sampling_rate,
        characters: utterance.text.length,
      });
      // Yield before the next sentence: on the worker this is when a cancel
      // message gets read; in-process it lets the event loop catch up before
      // the CPU is saturated again.
      await new Promise<void>((r) => setImmediate(r));
    }
  }

  private async module(): Promise<KokoroJsModule> {
    this.cachedModule ??= await this.loadKokoroJs();
    return this.cachedModule;
  }

  /** Resolve the tensor constructor once; the import is heavy. */
  private tensorConstructor(): Promise<KokoroTensorConstructor> {
    if (!this.cachedTensor) {
      const pending = this.loadTransformers().then((mod) => mod.Tensor);
      // A failed import must not be cached as a permanent failure.
      void pending.catch(() => {
        this.cachedTensor = null;
      });
      this.cachedTensor = pending;
    }
    return this.cachedTensor;
  }

  private async ensureLoaded(deadline: boolean): Promise<KokoroTTSInstance> {
    if (this.cachedTts) return this.cachedTts;
    if (this.loading) return this.loading;

    this.loading = (async () => {
      // kokoro-js's `from_pretrained` doesn't accept a cache_dir option —
      // it delegates to @huggingface/transformers, whose cache dir is
      // pinned here (see transformers-cache.ts for why this is mandatory).
      await pinTransformersCacheDir(this.config.cacheDir, this.loadTransformersEnv);
      const mod = await this.module();
      const loading = mod.KokoroTTS.from_pretrained(KOKORO_HF_REPO, { dtype: this.config.dtype });
      // A pull downloads ~88 MB of weights; a deadline there would only
      // punish a slow connection.
      const tts = deadline
        ? await withTimeout(
            loading,
            this.config.loadTimeoutMs,
            kokoroLoadStallMessage(this.config.loadTimeoutMs),
          )
        : await loading;
      this.cachedTts = tts;
      return tts;
    })()
      .catch((err: unknown) => {
        log.error(
          `kokoro model load failed (cacheDir=${this.config.cacheDir}): ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
        );
        throw err;
      })
      .finally(() => {
        this.loading = null;
      });

    return this.loading;
  }
}

function voiceTable(tts: KokoroTTSInstance): KokoroVoiceTable | undefined {
  // kokoro-js exposes voices as a prototype getter over a frozen dict.
  const raw = tts.voices;
  if (!raw) return undefined;
  const out: KokoroVoiceTable = {};
  for (const [id, info] of Object.entries(raw)) {
    out[id] = {
      ...(info?.name ? { name: info.name } : {}),
      ...(info?.language ? { language: info.language } : {}),
      ...(info?.gender ? { gender: info.gender } : {}),
    };
  }
  return out;
}

async function defaultKokoroLoader(): Promise<KokoroJsModule> {
  // Imported via dynamic specifier so unit tests can run without
  // kokoro-js being installed (mocked via `loadKokoroJs`). The cast
  // assumes upstream's CommonJS-flavored module shape — kokoro-js
  // re-exports `KokoroTTS` directly.
  try {
    return (await import('kokoro-js')) as unknown as KokoroJsModule;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (detail.includes('kokoro-js')) {
      throw new Error(
        'Local text-to-speech is an optional npm feature. Install kokoro-js@^1.2.1 and @huggingface/transformers@^4.3.1 alongside @bendyline/gezel-service (see the service README).',
      );
    }
    throw err;
  }
}

/** Synthesis on the calling thread. Tests use it, and so does a daemon whose worker cannot run. */
export class InProcessKokoroBackend implements KokoroBackend {
  private readonly engine: KokoroEngine;

  constructor(config: KokoroEngineConfig, loaders: KokoroEngineLoaders = {}) {
    this.engine = new KokoroEngine(config, loaders);
  }

  load(opts: { deadline: boolean }): Promise<KokoroVoiceTable | undefined> {
    return this.engine.load(opts);
  }

  synthesize(
    request: KokoroSynthesisRequest,
    signal: AbortSignal | undefined,
    onUtterance: (audio: KokoroUtteranceAudio) => void | Promise<void>,
  ): Promise<void> {
    return this.engine.synthesize(request, {
      cancelled: () => signal?.aborted ?? false,
      onUtterance,
    });
  }

  async unload(): Promise<void> {
    this.engine.unload();
  }

  async shutdown(): Promise<void> {
    this.engine.unload();
  }
}
