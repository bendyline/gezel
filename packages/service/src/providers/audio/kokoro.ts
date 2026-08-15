/**
 * KokoroProvider — local TTS via the Apache 2.0 Kokoro-82M model,
 * driven through `kokoro-js` (Transformers.js + ONNX runtime under the
 * hood). Inference runs in-process; there is no native subprocess and
 * no `NativeEngineSupervisor` involvement, unlike whisper.cpp.
 *
 * Why in-process: the audio-chat future requires streaming TTS, and
 * the chunked-output API is a first-class feature of `kokoro-js`. A
 * native HTTP shim would have to retrofit streaming later. See the
 * plan's "Architectural gaps to design around now (cheap) vs later
 * (expensive)" section.
 *
 * Model layout on disk:
 *
 *   <home>/engines/kokoro/models/<id>/
 *   ├── manifest.json          (id, name, modelRepo, dtype, installedAt)
 *   └── snapshots/<commit>/    (`kokoro-js`'s HF cache layout — ONNX +
 *                               voice .bin files extracted by Transformers.js)
 *
 * The provider pins `@huggingface/transformers`'s `env.cacheDir` to a
 * writable engine-scoped directory before each `from_pretrained()` call
 * (via the shared `pinTransformersCacheDir` — see transformers-cache.ts
 * for why this is mandatory). kokoro-js requires the same transformers
 * singleton, so the pin redirects its model download into our tree.
 */

import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createLogger } from '@bendyline/gezel';
import { resolveModelDirectory } from '../../models/model-id.js';
import { type LoadTransformersEnv, pinTransformersCacheDir } from '../../transformers-cache.js';
import type {
  AudioEngineHealth,
  AudioModelPullEvent,
  AudioModelPullSpec,
  AudioVoiceInfo,
  InstalledAudioModelInfo,
  SynthesizeInput,
  SynthesizeOutput,
  TextToSpeechProvider,
} from './types.js';

const log = createLogger('audio');

export interface KokoroProviderOptions {
  /** Absolute path to `~/.gezel/engines/kokoro/models`. */
  modelsRoot: string;
  /**
   * Writable directory to pin `@huggingface/transformers`'s `env.cacheDir`
   * to (see the file header for why this is mandatory). Defaults to a
   * sibling of `modelsRoot` under the engines tree when omitted.
   */
  cacheDir?: string;
  /**
   * Lazy loader for `kokoro-js`. Injected for tests. The default
   * `import('kokoro-js')` is deferred until first use because the
   * package pulls Transformers.js into memory (≈40 MB heap) and we
   * don't want every gezel boot to pay that cost.
   */
  loadKokoroJs?: () => Promise<KokoroJsModule>;
  /**
   * Lazy accessor for the transformers `env` singleton whose `cacheDir`
   * we pin. Injected for tests; the default imports the same
   * `@huggingface/transformers` build kokoro-js requires (ESM-node
   * resolution funnels both to one module instance, so the write lands
   * where the model loader reads).
   */
  loadTransformersEnv?: LoadTransformersEnv;
  /**
   * `'q4'` (smaller, faster) or `'q8'` (larger, higher quality).
   * Defaults to `q8` — Kokoro is small enough that quantization
   * differences are minor and quality matters for narration.
   */
  defaultDtype?: 'q4' | 'q8' | 'fp16' | 'fp32';
}

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
}

export interface KokoroTTSInstance {
  generate(text: string, opts?: { voice?: string; speed?: number }): Promise<KokoroAudioOutput>;
  /**
   * Sentence-level streaming variant. Each yielded `audio` is a small
   * RawAudio chunk (~1-2s of speech) instead of one mega-inference for
   * the entire text. We prefer this in `synthesize` so the event loop
   * gets to drain between sentences — in Electron's embedded mode the
   * service shares the main process thread, and a multi-sentence
   * one-shot freezes the UI for the entire inference window.
   */
  stream?(
    text: string,
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

export const KOKORO_DEFAULT_MODEL_ID = 'kokoro-82m-v1.0';
const KOKORO_HF_REPO = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const KOKORO_APPROX_BYTES_BY_ID: Readonly<Record<string, number>> = {
  [KOKORO_DEFAULT_MODEL_ID]: 95_000_000,
};

type ModuleResolver = (specifier: string) => string;

/**
 * Whether this service installation can actually load the optional Kokoro
 * runtime. Keep this as a resolution-only check: importing either package
 * starts the sizeable ONNX/phonemizer stack, which catalog reads must not do.
 */
export function isKokoroRuntimeAvailable(
  resolveModule: ModuleResolver = (specifier) => import.meta.resolve(specifier),
): boolean {
  try {
    resolveModule('kokoro-js');
    resolveModule('@huggingface/transformers');
    return true;
  } catch {
    return false;
  }
}

/**
 * Curated subset of Kokoro's 54 voices to surface in the picker.
 * `kokoro-js` exposes the full set via `instance.voices`; the UI uses
 * this list for the default dropdown and reveals the rest behind an
 * "advanced" disclosure. Names match the canonical kokoro-js IDs —
 * `<lang>_<gender>_<name>` (lowercase first letter is gender; `f` =
 * female, `m` = male).
 */
export const KOKORO_DEFAULT_VOICES: ReadonlyArray<AudioVoiceInfo> = [
  {
    id: 'af_heart',
    name: 'Heart (US Female)',
    language: 'en-US',
    gender: 'female',
    modelId: KOKORO_DEFAULT_MODEL_ID,
  },
  {
    id: 'af_bella',
    name: 'Bella (US Female)',
    language: 'en-US',
    gender: 'female',
    modelId: KOKORO_DEFAULT_MODEL_ID,
  },
  {
    id: 'af_nicole',
    name: 'Nicole (US Female)',
    language: 'en-US',
    gender: 'female',
    modelId: KOKORO_DEFAULT_MODEL_ID,
  },
  {
    id: 'am_adam',
    name: 'Adam (US Male)',
    language: 'en-US',
    gender: 'male',
    modelId: KOKORO_DEFAULT_MODEL_ID,
  },
  {
    id: 'am_michael',
    name: 'Michael (US Male)',
    language: 'en-US',
    gender: 'male',
    modelId: KOKORO_DEFAULT_MODEL_ID,
  },
  {
    id: 'bf_emma',
    name: 'Emma (UK Female)',
    language: 'en-GB',
    gender: 'female',
    modelId: KOKORO_DEFAULT_MODEL_ID,
  },
  {
    id: 'bm_george',
    name: 'George (UK Male)',
    language: 'en-GB',
    gender: 'male',
    modelId: KOKORO_DEFAULT_MODEL_ID,
  },
  {
    id: 'bm_lewis',
    name: 'Lewis (UK Male)',
    language: 'en-GB',
    gender: 'male',
    modelId: KOKORO_DEFAULT_MODEL_ID,
  },
];

const DEFAULT_VOICE_ID = 'af_heart';

export class KokoroProvider implements TextToSpeechProvider {
  readonly name = 'kokoro';
  private readonly modelsRoot: string;
  private readonly cacheDir: string;
  private readonly loadKokoroJs: () => Promise<KokoroJsModule>;
  private readonly loadTransformersEnv: LoadTransformersEnv | undefined;
  private readonly defaultDtype: 'q4' | 'q8' | 'fp16' | 'fp32';
  private cachedTts: KokoroTTSInstance | null = null;
  private loadingPromise: Promise<KokoroTTSInstance> | null = null;

  constructor(opts: KokoroProviderOptions) {
    this.modelsRoot = opts.modelsRoot;
    // `<engines>/hf-cache` (sibling of the per-engine `kokoro/` dir) so a
    // future in-process transformers.js user shares one managed HF cache.
    this.cacheDir = opts.cacheDir ?? join(dirname(dirname(opts.modelsRoot)), 'hf-cache');
    this.loadKokoroJs = opts.loadKokoroJs ?? defaultKokoroLoader;
    // Undefined → pinTransformersCacheDir uses its own default env loader.
    this.loadTransformersEnv = opts.loadTransformersEnv;
    this.defaultDtype = opts.defaultDtype ?? 'q8';
  }

  /** Point transformers.js at our writable cache dir before the first load. */
  private configureCache(): Promise<void> {
    return pinTransformersCacheDir(this.cacheDir, this.loadTransformersEnv);
  }

  async synthesize(input: SynthesizeInput): Promise<SynthesizeOutput> {
    const started = Date.now();
    const tts = await this.ensureLoaded();
    const voice = input.voice ?? DEFAULT_VOICE_ID;
    const speed = clamp(input.speed ?? 1, 0.5, 2);

    // Prefer the sentence-level streaming API when available — each
    // iteration runs ONNX inference on a single sentence, and the
    // `await new Promise(setImmediate)` between chunks lets the host
    // event loop drain so other timers / IO / IPC don't pile up.
    // Critical in Electron's embedded mode where this code runs on the
    // main process thread: a 30-sentence reply via `generate()` would
    // freeze the window for the full inference duration.
    let chunks: Float32Array[];
    let sampleRate: number | undefined;
    if (typeof tts.stream === 'function') {
      chunks = [];
      for await (const piece of tts.stream(input.text, { voice, speed })) {
        chunks.push(piece.audio.audio);
        sampleRate ??= piece.audio.sampling_rate;
        // Yield to the event loop before the next sentence's
        // inference starts. setImmediate sits after IO/timers in the
        // Node event loop, which is what we want — UI ticks and
        // pending HTTP work catch up before we re-saturate the CPU.
        await new Promise<void>((r) => setImmediate(r));
      }
    } else {
      // Older kokoro-js without the stream API — fall back to the
      // one-shot path. The freeze it causes is the known issue this
      // streaming branch fixes; keep the fallback so a downgraded
      // upstream still works (degraded UX).
      const result = await tts.generate(input.text, { voice, speed });
      chunks = [result.audio];
      sampleRate = result.sampling_rate;
    }

    if (chunks.length === 0 || sampleRate === undefined) {
      throw new Error('kokoro stream produced no audio (empty text?)');
    }
    const combined = concatFloat32(chunks);
    const wav = encodeWavPcm16(combined, sampleRate);
    const durationSeconds = combined.length / sampleRate;
    return {
      wav,
      meta: {
        voice,
        model: input.model ?? KOKORO_DEFAULT_MODEL_ID,
        sampleRate,
        durationSeconds,
        durationMs: Date.now() - started,
      },
    };
  }

  async listInstalledModels(): Promise<InstalledAudioModelInfo[]> {
    let entries: string[] = [];
    try {
      entries = await readdir(this.modelsRoot);
    } catch {
      return [];
    }
    const out: InstalledAudioModelInfo[] = [];
    for (const id of entries) {
      try {
        const raw = await readFile(join(this.modelsRoot, id, 'manifest.json'), 'utf8');
        const parsed = JSON.parse(raw) as Partial<InstalledAudioModelInfo>;
        if (!parsed.id || !parsed.name || !parsed.installedAt) continue;
        // Older manifests recorded `approxSizeBytes: 0` because the
        // weights actually live in @huggingface/transformers's cache,
        // not in our managed dir. Backfill from the known catalog
        // size so the UI's "Installed (size)" label is honest without
        // requiring a re-pull.
        const declared = parsed.approxSizeBytes ?? 0;
        const approxSizeBytes =
          declared > 0 ? declared : (KOKORO_APPROX_BYTES_BY_ID[parsed.id] ?? 0);
        out.push({
          id: parsed.id,
          name: parsed.name,
          approxSizeBytes,
          installedAt: parsed.installedAt,
        });
      } catch {
        /* skip malformed */
      }
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  async *pullModel(id: string, spec: AudioModelPullSpec): AsyncIterable<AudioModelPullEvent> {
    // kokoro-js handles the actual download via Transformers.js's
    // own cache fetcher. We point it at our managed dir via
    // `cache_dir`, then drop a manifest so list/health agree on
    // "installed". Progress reporting is coarse — Transformers.js
    // doesn't expose per-byte progress through `from_pretrained`,
    // so we emit one start, one mid-pull tick, and a final done.
    const itemDir = join(this.modelsRoot, id);
    await mkdir(itemDir, { recursive: true });
    const totalBytes = spec.files.reduce((n, f) => n + f.approxSizeBytes, 0);
    yield { type: 'progress', bytesWritten: 0, totalBytes };

    try {
      await this.configureCache();
      const mod = await this.loadKokoroJs();
      // kokoro-js's `from_pretrained` doesn't accept a cache_dir option —
      // it delegates to @huggingface/transformers, whose cache dir we've
      // pinned via `configureCache()` above. We record the install in our
      // managed dir via the manifest below so listInstalledModels / health
      // agree on "installed"; the ONNX weights live in the pinned
      // transformers cache and are re-used on every subsequent load.
      this.cachedTts = await mod.KokoroTTS.from_pretrained(KOKORO_HF_REPO, {
        dtype: this.defaultDtype,
      });
    } catch (err) {
      log.error(
        `kokoro model load failed (cacheDir=${this.cacheDir}): ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
      );
      yield {
        type: 'error',
        error: `kokoro model load failed: ${err instanceof Error ? err.message : String(err)}`,
      };
      yield { type: 'done', id };
      return;
    }

    await writeFile(
      join(itemDir, 'manifest.json'),
      JSON.stringify(
        {
          id,
          name: spec.name,
          // Real weights live in the transformers cache, not itemDir, so
          // reporting `sumBytesRecursive(itemDir)` would always show ~0.
          // Use the spec's approxSizeBytes so the "Installed (size)" label
          // matches what the user just downloaded.
          approxSizeBytes: totalBytes,
          modelRepo: KOKORO_HF_REPO,
          dtype: this.defaultDtype,
          installedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      'utf8',
    );

    yield { type: 'progress', bytesWritten: totalBytes, totalBytes };
    yield { type: 'done', id };
  }

  async deleteModel(id: string): Promise<void> {
    const itemDir = resolveModelDirectory(this.modelsRoot, id);
    await rm(itemDir, { recursive: true, force: true });
    // If we deleted the loaded model out from under us, drop the cache
    // so the next synthesize re-loads (and fails loudly if no replacement
    // is installed).
    this.cachedTts = null;
    this.loadingPromise = null;
  }

  async listVoices(): Promise<AudioVoiceInfo[]> {
    if (!this.cachedTts) {
      // Engine isn't loaded yet — return the curated default list. The
      // real instance carries the full 54+ voices and replaces this on
      // first synthesize.
      return [...KOKORO_DEFAULT_VOICES];
    }
    // kokoro-js exposes voices as a prototype getter that always returns
    // the frozen VOICES dict. The sibling `list_voices()` method only
    // calls console.table() and returns undefined — never call it.
    const raw = this.cachedTts.voices ?? {};
    const out: AudioVoiceInfo[] = [];
    for (const [id, info] of Object.entries(raw)) {
      out.push({
        id,
        name: info?.name ?? friendlyVoiceName(id),
        language: info?.language ?? guessLanguage(id),
        gender: parseGender(info?.gender ?? id),
        modelId: KOKORO_DEFAULT_MODEL_ID,
      });
    }
    return out.length > 0 ? out : [...KOKORO_DEFAULT_VOICES];
  }

  async health(): Promise<AudioEngineHealth> {
    const installed = await this.listInstalledModels();
    if (installed.length === 0) {
      return {
        status: 'no-model',
        error: 'No TTS model is available locally. Download Kokoro from Settings → Audio.',
      };
    }
    return { status: 'ok' };
  }

  async shutdown(): Promise<void> {
    this.cachedTts = null;
    this.loadingPromise = null;
  }

  private async ensureLoaded(): Promise<KokoroTTSInstance> {
    if (this.cachedTts) return this.cachedTts;
    if (this.loadingPromise) return this.loadingPromise;

    this.loadingPromise = (async () => {
      // Require a manifest from a prior pull so synthesize doesn't silently
      // trigger a model download on the first turn. If none exists, surface
      // a clear error (the route layer turns this into a 503 the UI guides
      // on). The weights themselves live in @huggingface/transformers's
      // cache, not in our managed dir — see pullModel for context.
      const installed = await this.listInstalledModels();
      if (installed.length === 0) {
        throw new Error(
          'No TTS model is available locally. Download Kokoro from Settings → Audio before synthesizing.',
        );
      }
      await this.configureCache();
      const mod = await this.loadKokoroJs();
      const tts = await mod.KokoroTTS.from_pretrained(KOKORO_HF_REPO, {
        dtype: this.defaultDtype,
      });
      this.cachedTts = tts;
      return tts;
    })().finally(() => {
      this.loadingPromise = null;
    });

    return this.loadingPromise;
  }
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
        'Local text-to-speech is an optional npm feature. Install kokoro-js@^1.2.1 and @huggingface/transformers@^3.8.1 alongside @bendyline/gezel-service (see the service README).',
      );
    }
    throw err;
  }
}

/**
 * Concatenate the Float32 PCM chunks yielded by kokoro-js's stream API
 * into a single Float32Array we can hand to {@link encodeWavPcm16}.
 * One allocation up front beats N growing-buffer copies.
 */
function concatFloat32(chunks: ReadonlyArray<Float32Array>): Float32Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Float32Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/**
 * Encode a mono Float32 PCM stream (samples in [-1, 1]) to a
 * 16-bit PCM WAV buffer. Standard RIFF / "fmt " / "data" header.
 */
function encodeWavPcm16(samples: Float32Array, sampleRate: number): Buffer {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = samples.length * 2;
  const buf = Buffer.alloc(44 + dataSize);

  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); // fmt chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(numChannels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(bitsPerSample, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < samples.length; i++) {
    let s = samples[i] ?? 0;
    if (s > 1) s = 1;
    else if (s < -1) s = -1;
    buf.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
  }
  return buf;
}

function clamp(n: number, lo: number, hi: number): number {
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function friendlyVoiceName(id: string): string {
  // Kokoro voice ids look like `af_heart` — lang/gender prefix + name.
  const parts = id.split('_');
  const trailing = parts.slice(1).join(' ');
  return trailing ? trailing.charAt(0).toUpperCase() + trailing.slice(1) : id;
}

function guessLanguage(id: string): string {
  if (id.startsWith('a')) return 'en-US';
  if (id.startsWith('b')) return 'en-GB';
  if (id.startsWith('e')) return 'es';
  if (id.startsWith('f')) return 'fr';
  if (id.startsWith('h')) return 'hi';
  if (id.startsWith('i')) return 'it';
  if (id.startsWith('j')) return 'ja';
  if (id.startsWith('p')) return 'pt';
  if (id.startsWith('z')) return 'zh';
  return 'unknown';
}

function parseGender(s: string): 'female' | 'male' | 'neutral' | undefined {
  const lower = s.toLowerCase();
  if (lower.includes('female') || /^[a-z]f/.test(lower)) return 'female';
  if (lower.includes('male') || /^[a-z]m/.test(lower)) return 'male';
  return undefined;
}
