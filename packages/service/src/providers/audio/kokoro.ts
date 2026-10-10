/**
 * KokoroProvider — local TTS via the Apache 2.0 Kokoro-82M model,
 * driven through `kokoro-js` (Transformers.js + ONNX runtime under the
 * hood). There is no native subprocess and no `NativeEngineSupervisor`
 * involvement, unlike whisper.cpp: inference runs on a worker thread of the
 * daemon (kokoro-worker.ts), because an ONNX run blocks the thread it is on.
 * The engine itself is kokoro-engine.ts; this file is the provider surface —
 * install records, voices, progress, and WAV assembly.
 *
 * Model layout on disk:
 *
 *   <home>/engines/kokoro/models/<id>/
 *   ├── manifest.json          (id, name, modelRepo, dtype, installedAt)
 *   ├── onnx/model_quantized.onnx (hard link into the shared speech cache)
 *   ├── voices/*.bin              (verified shared English voice vectors)
 *   └── *.json                    (bundled model/tokenizer metadata)
 *
 * Production q8 loads this complete pinned local directory without network.
 * Explicit alternative quantizations retain the Transformers.js cache path.
 */

import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  KOKORO_MODEL_ID,
  KOKORO_TRANSFORMERS_METADATA,
  type SpeechAssetOptions,
  SpeechAssetStore,
  catalogEntry,
} from '@bendyline/gezel/speech-models';
import { resolveModelDirectory } from '../../models/model-id.js';
import type { LoadTransformersEnv } from '../../transformers-cache.js';
import {
  InProcessKokoroBackend,
  KOKORO_HF_REPO,
  type KokoroBackend,
  type KokoroEngineConfig,
  type KokoroJsModule,
  type KokoroTensorConstructor,
  type KokoroVoiceTable,
} from './kokoro-engine.js';
import { KokoroWorkerBackend } from './kokoro-worker-host.js';
import {
  ensureSpeechModel,
  sharedSpeechModelInfo,
  speechPullEvents,
  writeSpeechMetadata,
} from './managed-speech-model.js';
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

export {
  type KokoroAudioOutput,
  type KokoroInputIds,
  type KokoroJsModule,
  type KokoroTensorConstructor,
  type KokoroTextSplitterStream,
  KokoroTimeoutError,
  type KokoroTTSInstance,
} from './kokoro-engine.js';

export interface KokoroProviderOptions {
  /** Absolute path to `~/.gezel/engines/kokoro/models`. */
  modelsRoot: string;
  /** Shared pinned q8 model storage. Other quantizations retain their existing loader. */
  assets?: SpeechAssetOptions;
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
   *
   * Injecting this, or either loader below, runs synthesis in-process:
   * functions cannot cross into the worker thread.
   */
  loadKokoroJs?: () => Promise<KokoroJsModule>;
  /** Directory holding the staged pronunciation dictionaries. */
  lexiconDir?: string;
  /**
   * Lazy loader for the tensor constructor. Deferred for the same reason as
   * kokoro-js: importing Transformers.js costs tens of megabytes of heap.
   */
  loadTransformers?: () => Promise<{ Tensor: KokoroTensorConstructor }>;
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
  /**
   * Watchdog for a *single* sentence's inference. Deliberately per-chunk
   * rather than a budget for the whole call: narrating a long reply is
   * legitimately slow, so a whole-operation deadline would have to be
   * enormous and a wedged engine would take that long to surface. Kokoro
   * truncates each inference at 510 tokens, so one chunk is bounded work no
   * matter how much text was handed in. Defaults to 60s — roughly 50x the
   * observed ~600ms/sentence on an M-series laptop.
   */
  inferenceTimeoutMs?: number;
  /**
   * Watchdog for `from_pretrained`. Separate and far larger than
   * {@link inferenceTimeoutMs} because a cleared transformers cache
   * makes this re-download ~88 MB of ONNX weights. Defaults to 5min.
   */
  loadTimeoutMs?: number;
}

const DEFAULT_INFERENCE_TIMEOUT_MS = 60_000;
const DEFAULT_LOAD_TIMEOUT_MS = 300_000;

export const KOKORO_DEFAULT_MODEL_ID = 'kokoro-82m-v1.0';
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
  private readonly assets?: SpeechAssetStore;
  private readonly cacheDir: string;
  private readonly defaultDtype: 'q4' | 'q8' | 'fp16' | 'fp32';
  private readonly backend: KokoroBackend;
  private voices: KokoroVoiceTable | undefined;
  private installVerified = false;

  constructor(opts: KokoroProviderOptions) {
    this.modelsRoot = opts.modelsRoot;
    // `<engines>/hf-cache` (sibling of the per-engine `kokoro/` dir) so a
    // future in-process transformers.js user shares one managed HF cache.
    this.cacheDir = opts.cacheDir ?? join(dirname(dirname(opts.modelsRoot)), 'hf-cache');
    this.defaultDtype = opts.defaultDtype ?? 'q8';
    if (opts.assets && this.defaultDtype === 'q8') this.assets = new SpeechAssetStore(opts.assets);
    const config: KokoroEngineConfig = {
      cacheDir: this.cacheDir,
      ...(this.assets ? { modelDirectory: join(this.modelsRoot, KOKORO_MODEL_ID) } : {}),
      dtype: this.defaultDtype,
      inferenceTimeoutMs: opts.inferenceTimeoutMs ?? DEFAULT_INFERENCE_TIMEOUT_MS,
      loadTimeoutMs: opts.loadTimeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS,
      ...(opts.lexiconDir === undefined ? {} : { lexiconDir: opts.lexiconDir }),
    };
    const injected = opts.loadKokoroJs ?? opts.loadTransformers ?? opts.loadTransformersEnv;
    // Vitest cannot load a `.ts` worker entry, so tests always run in-process.
    this.backend =
      injected || process.env.VITEST
        ? new InProcessKokoroBackend(config, {
            ...(opts.loadKokoroJs ? { loadKokoroJs: opts.loadKokoroJs } : {}),
            ...(opts.loadTransformers ? { loadTransformers: opts.loadTransformers } : {}),
            ...(opts.loadTransformersEnv ? { loadTransformersEnv: opts.loadTransformersEnv } : {}),
          })
        : new KokoroWorkerBackend(config);
  }

  async synthesize(input: SynthesizeInput): Promise<SynthesizeOutput> {
    const started = Date.now();
    const totalCharacters = input.text.length;
    let completedCharacters = 0;
    let completedChunks = 0;
    const report = (phase: 'loading' | 'synthesizing' | 'encoding') =>
      input.onProgress?.({ phase, completedCharacters, totalCharacters, completedChunks });
    input.signal?.throwIfAborted();
    await report('loading');
    await this.ensureInstalled();
    this.voices = (await this.backend.load({ deadline: true })) ?? this.voices;
    input.signal?.throwIfAborted();
    await report('synthesizing');
    const voice = input.voice ?? DEFAULT_VOICE_ID;
    const speed = clamp(input.speed ?? 1, 0.5, 2);

    const parts: Uint8Array[] = [];
    let sampleRate: number | undefined;
    await this.backend.synthesize(
      { text: input.text, voice, speed },
      input.signal,
      async (audio) => {
        parts.push(audio.pcm);
        sampleRate ??= audio.sampleRate;
        completedCharacters = Math.min(totalCharacters, completedCharacters + audio.characters);
        completedChunks += 1;
        await report('synthesizing');
        await input.onChunk?.({
          index: completedChunks - 1,
          wav: wavFromPcm16le([audio.pcm], audio.sampleRate),
          sampleRate: audio.sampleRate,
          durationSeconds: audio.pcm.byteLength / 2 / audio.sampleRate,
        });
      },
    );
    input.signal?.throwIfAborted();

    if (parts.length === 0 || sampleRate === undefined) {
      throw new Error('kokoro stream produced no audio (empty text?)');
    }
    completedCharacters = totalCharacters;
    await report('encoding');
    const wav = wavFromPcm16le(parts, sampleRate);
    const durationSeconds = (wav.length - WAV_HEADER_BYTES) / 2 / sampleRate;
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
    if (this.assets) {
      const info = await sharedSpeechModelInfo(
        this.assets,
        catalogEntry(KOKORO_MODEL_ID)!,
        this.modelsRoot,
      );
      return info ? [info] : [];
    }
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
    if (this.assets) {
      if (id !== KOKORO_MODEL_ID) throw new Error(`Unknown pinned Kokoro model: ${id}`);
      yield* speechPullEvents(id, async (progress) => {
        await ensureSpeechModel(this.assets!, catalogEntry(id)!, this.modelsRoot, true, progress);
        await this.prepareMetadata();
        this.voices = (await this.backend.load({ deadline: true })) ?? this.voices;
        this.installVerified = true;
      });
      return;
    }
    // kokoro-js handles the actual download via Transformers.js's
    // own cache fetcher, into the cache dir the engine pins. We then
    // drop a manifest so list/health agree on "installed". Progress
    // reporting is coarse — Transformers.js doesn't expose per-byte
    // progress through `from_pretrained`, so we emit one start and a
    // final done.
    const itemDir = join(this.modelsRoot, id);
    await mkdir(itemDir, { recursive: true });
    const totalBytes = spec.files.reduce((n, f) => n + f.approxSizeBytes, 0);
    yield { type: 'progress', bytesWritten: 0, totalBytes };

    try {
      this.voices = (await this.backend.load({ deadline: false })) ?? this.voices;
    } catch (err) {
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
    this.installVerified = true;

    yield { type: 'progress', bytesWritten: totalBytes, totalBytes };
    yield { type: 'done', id };
  }

  async deleteModel(id: string): Promise<void> {
    const itemDir = resolveModelDirectory(this.modelsRoot, id);
    this.installVerified = false;
    this.voices = undefined;
    await this.backend.unload();
    await rm(itemDir, { recursive: true, force: true });
    if (this.assets && id === KOKORO_MODEL_ID) {
      for (const file of catalogEntry(id)!.files) await this.assets.collect(file);
    }
  }

  async listVoices(): Promise<AudioVoiceInfo[]> {
    // Before the first load, the curated default list. The loaded model
    // carries the full 54+ voices and replaces it.
    const raw = this.voices;
    if (!raw) return [...KOKORO_DEFAULT_VOICES];
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
    this.voices = undefined;
    await this.backend.shutdown();
  }

  /** Shipped metadata keeps adoption and model loading entirely offline. */
  private async prepareMetadata(): Promise<void> {
    const directory = join(this.modelsRoot, KOKORO_MODEL_ID);
    for (const [name, bytes] of Object.entries(KOKORO_TRANSFORMERS_METADATA)) {
      await writeSpeechMetadata(directory, name, bytes);
    }
  }

  private async ensureInstalled(): Promise<void> {
    if (this.assets) {
      if (
        !(await ensureSpeechModel(
          this.assets,
          catalogEntry(KOKORO_MODEL_ID)!,
          this.modelsRoot,
          false,
        ))
      ) {
        throw new Error('Download or update Kokoro from Settings → Audio before synthesizing.');
      }
      await this.prepareMetadata();
      return;
    }
    if (this.installVerified) return;
    const installed = await this.listInstalledModels();
    if (installed.length === 0) {
      throw new Error(
        'No TTS model is available locally. Download Kokoro from Settings → Audio before synthesizing.',
      );
    }
    this.installVerified = true;
  }
}

const WAV_HEADER_BYTES = 44;

/**
 * A mono 16-bit PCM WAV from little-endian sample data, in one allocation.
 * Standard RIFF / "fmt " / "data" header.
 */
function wavFromPcm16le(parts: ReadonlyArray<Uint8Array>, sampleRate: number): Buffer {
  let dataSize = 0;
  for (const part of parts) dataSize += part.byteLength;
  const numChannels = 1;
  const bitsPerSample = 16;
  const buf = Buffer.alloc(WAV_HEADER_BYTES + dataSize);

  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); // fmt chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(numChannels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * numChannels * (bitsPerSample / 8), 28);
  buf.writeUInt16LE(numChannels * (bitsPerSample / 8), 32);
  buf.writeUInt16LE(bitsPerSample, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);

  let offset = WAV_HEADER_BYTES;
  for (const part of parts) {
    buf.set(part, offset);
    offset += part.byteLength;
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
