import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  KOKORO_DEFAULT_MODEL_ID,
  type KokoroAudioOutput,
  type KokoroInputIds,
  type KokoroJsModule,
  KokoroProvider,
  type KokoroProviderOptions,
  type KokoroTensorConstructor,
  KokoroTimeoutError,
} from './kokoro.js';

/**
 * Gezel never lets kokoro-js turn text into phonemes: that path runs
 * `phonemizer`, which embeds GPL-3 eSpeak NG and so cannot ship. The daemon
 * phonemizes with the shared frontend and calls `generate_from_ids`. These
 * tests hold that line — a mock whose `generate()` is called fails loudly.
 *
 * The old splitter-deadlock regressions are gone with the splitter: the
 * provider no longer calls `stream()`, so kokoro-js can no longer build the
 * unclosed internal splitter those tests guarded against.
 */

function audio(length: number): KokoroAudioOutput {
  return { audio: new Float32Array(length).fill(0.5), sampling_rate: 24_000 };
}

/** The shape kokoro-js reads off a tensor before handing it to ONNX. */
class FakeTensor implements KokoroInputIds {
  readonly dims: readonly number[];
  readonly data: BigInt64Array;
  constructor(_type: 'int64', data: BigInt64Array, dims: readonly number[]) {
    this.data = data;
    this.dims = dims;
  }
}
const Tensor = FakeTensor as unknown as KokoroTensorConstructor;

interface Recorded {
  readonly ids: number[];
  readonly dims: readonly number[];
  readonly voice: string | undefined;
  readonly speed: number | undefined;
}

function makeModule(opts: { stall?: boolean; perCallMs?: number } = {}): {
  module: KokoroJsModule;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const instance = {
    async generate(): Promise<KokoroAudioOutput> {
      throw new Error('generate() reaches eSpeak NG through phonemizer; it must never be called');
    },
    async generate_from_ids(
      inputIds: KokoroInputIds,
      options?: { voice?: string; speed?: number },
    ): Promise<KokoroAudioOutput> {
      const tensor = inputIds as unknown as FakeTensor;
      calls.push({
        ids: [...tensor.data].map(Number),
        dims: tensor.dims,
        voice: options?.voice,
        speed: options?.speed,
      });
      if (opts.stall) return new Promise<never>(() => {});
      if (opts.perCallMs) await new Promise((r) => setTimeout(r, opts.perCallMs));
      return audio(600);
    },
  };
  return { module: { KokoroTTS: { from_pretrained: async () => instance } }, calls };
}

describe('KokoroProvider.synthesize', () => {
  let home: string;
  let modelsRoot: string;
  let lexiconDir: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'gezel-kokoro-'));
    modelsRoot = join(home, 'engines', 'kokoro', 'models');
    await mkdir(join(modelsRoot, KOKORO_DEFAULT_MODEL_ID), { recursive: true });
    await writeFile(
      join(modelsRoot, KOKORO_DEFAULT_MODEL_ID, 'manifest.json'),
      JSON.stringify({
        id: KOKORO_DEFAULT_MODEL_ID,
        name: 'Kokoro 82M v1.0',
        approxSizeBytes: 95_000_000,
        installedAt: new Date().toISOString(),
      }),
      'utf8',
    );
    // A miniature voice pack in the real format: word, then phoneme symbols.
    lexiconDir = join(home, 'kokoro-lexicon');
    await mkdir(lexiconDir, { recursive: true });
    const american = ['hello h ə l ˈ O', 'world w ˈ ɜ ɹ l d', 'cat k ˈ æ t', 'one w ˈ ʌ n'].join(
      '\n',
    );
    const british = ['hello h ə l ˈ Q', 'world w ˈ ɜ ː l d', 'cat k ˈ a t', 'one w ˈ ʌ n'].join(
      '\n',
    );
    await writeFile(join(lexiconDir, 'lexicon-us-en.txt.gz'), gzipSync(Buffer.from(american)));
    await writeFile(join(lexiconDir, 'lexicon-gb-en.txt.gz'), gzipSync(Buffer.from(british)));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  function provider(module: KokoroJsModule, overrides: Partial<KokoroProviderOptions> = {}) {
    return new KokoroProvider({
      modelsRoot,
      lexiconDir,
      loadKokoroJs: async () => module,
      loadTransformers: async () => ({ Tensor }),
      loadTransformersEnv: async () => ({
        cacheDir: '',
        useFSCache: true,
        allowRemoteModels: false,
      }),
      inferenceTimeoutMs: 200,
      loadTimeoutMs: 200,
      ...overrides,
    });
  }

  it('runs one inference per sentence and concatenates the audio', async () => {
    const { module, calls } = makeModule();
    const out = await provider(module).synthesize({ text: 'Hello world. Hello cat.' });
    expect(calls).toHaveLength(2);
    expect(out.meta.sampleRate).toBe(24_000);
    expect(out.wav.length).toBe(44 + 600 * 2 * 2);
  });

  it('sends padded phoneme ids shaped for the model, never text', async () => {
    const { module, calls } = makeModule();
    await provider(module).synthesize({ text: 'cat' });
    const call = calls[0];
    expect(call).toBeDefined();
    // Kokoro frames every utterance with the pad token.
    expect(call?.ids.at(0)).toBe(0);
    expect(call?.ids.at(-1)).toBe(0);
    // "cat" is k ˈ æ t — four phonemes between the two pads.
    expect(call?.ids).toHaveLength(6);
    expect(call?.dims).toEqual([1, 6]);
  });

  it('passes the requested voice and clamps speed', async () => {
    const { module, calls } = makeModule();
    await provider(module).synthesize({ text: 'cat', voice: 'am_michael', speed: 9 });
    expect(calls[0]?.voice).toBe('am_michael');
    expect(calls[0]?.speed).toBe(2);
  });

  it('reads a British voice from the British dictionary', async () => {
    const american = makeModule();
    await provider(american.module).synthesize({ text: 'hello', voice: 'af_heart' });
    const british = makeModule();
    await provider(british.module).synthesize({ text: 'hello', voice: 'bm_george' });
    // The packs give "hello" different vowels, so the ids must differ.
    expect(british.calls[0]?.ids).not.toEqual(american.calls[0]?.ids);
  });

  it('reports character progress after each synthesized sentence', async () => {
    const { module } = makeModule();
    const progress = vi.fn();
    const chunks = vi.fn();
    await provider(module).synthesize({
      text: 'Hello world. Hello cat.',
      onProgress: progress,
      onChunk: chunks,
    });
    expect(progress).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'synthesizing', completedChunks: 1 }),
    );
    expect(progress).toHaveBeenLastCalledWith(
      expect.objectContaining({ phase: 'encoding', completedChunks: 2 }),
    );
    expect(chunks).toHaveBeenCalledTimes(2);
    expect(chunks.mock.calls[0]?.[0]).toMatchObject({ index: 0, sampleRate: 24_000 });
    expect(chunks.mock.calls[0]?.[0].wav.subarray(0, 4).toString('ascii')).toBe('RIFF');
  });

  it('carries the resolved voice and default model into the output metadata', async () => {
    const { module } = makeModule();
    const out = await provider(module).synthesize({ text: 'Hi.', voice: 'bm_george' });
    expect(out.meta.voice).toBe('bm_george');
    expect(out.meta.model).toBe(KOKORO_DEFAULT_MODEL_ID);
  });

  it('does not load the model for an already-cancelled request', async () => {
    const { module, calls } = makeModule();
    const controller = new AbortController();
    controller.abort();
    await expect(
      provider(module).synthesize({ text: 'Never spoken.', signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toHaveLength(0);
  });

  it('explains a missing dictionary rather than failing obscurely', async () => {
    const { module } = makeModule();
    await expect(
      provider(module, { lexiconDir: join(home, 'absent') }).synthesize({ text: 'cat' }),
    ).rejects.toThrow(/pronunciation dictionary is missing/i);
  });

  it('refuses text with nothing speakable in it', async () => {
    const { module, calls } = makeModule();
    await expect(provider(module).synthesize({ text: '   ' })).rejects.toThrow(/no audio/i);
    expect(calls).toHaveLength(0);
  });
});

describe('KokoroProvider watchdog', () => {
  let home: string;
  let modelsRoot: string;
  let lexiconDir: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'gezel-kokoro-timeout-'));
    modelsRoot = join(home, 'engines', 'kokoro', 'models');
    await mkdir(join(modelsRoot, KOKORO_DEFAULT_MODEL_ID), { recursive: true });
    await writeFile(
      join(modelsRoot, KOKORO_DEFAULT_MODEL_ID, 'manifest.json'),
      JSON.stringify({
        id: KOKORO_DEFAULT_MODEL_ID,
        name: 'Kokoro 82M v1.0',
        approxSizeBytes: 95_000_000,
        installedAt: new Date().toISOString(),
      }),
      'utf8',
    );
    lexiconDir = join(home, 'kokoro-lexicon');
    await mkdir(lexiconDir, { recursive: true });
    const words = ['one w ˈ ʌ n', 'two t ˈ u', 'three θ ɹ ˈ i', 'four f ˈ ɔ ɹ', 'five f ˈ I v'];
    for (const file of ['lexicon-us-en.txt.gz', 'lexicon-gb-en.txt.gz'])
      await writeFile(join(lexiconDir, file), gzipSync(Buffer.from(words.join('\n'))));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  function provider(module: KokoroJsModule, overrides: Partial<KokoroProviderOptions> = {}) {
    return new KokoroProvider({
      modelsRoot,
      lexiconDir,
      loadKokoroJs: async () => module,
      loadTransformers: async () => ({ Tensor }),
      loadTransformersEnv: async () => ({
        cacheDir: '',
        useFSCache: true,
        allowRemoteModels: false,
      }),
      inferenceTimeoutMs: 200,
      loadTimeoutMs: 200,
      ...overrides,
    });
  }

  it('aborts an inference that never returns instead of hanging forever', async () => {
    const { module } = makeModule({ stall: true });
    await expect(provider(module).synthesize({ text: 'One two three.' })).rejects.toThrow(
      KokoroTimeoutError,
    );
  });

  it('reports how far it got before the stall', async () => {
    const { module } = makeModule({ stall: true });
    await expect(provider(module).synthesize({ text: 'One two three.' })).rejects.toThrow(
      /after 0 chunk\(s\)/,
    );
  });

  it('aborts a model load that never resolves', async () => {
    const module: KokoroJsModule = {
      KokoroTTS: { from_pretrained: () => new Promise<never>(() => {}) },
    };
    await expect(provider(module).synthesize({ text: 'One.' })).rejects.toThrow(
      /Loading the Kokoro model timed out/,
    );
  });

  it('does not abort slow-but-progressing narration whose total exceeds one chunk budget', async () => {
    // 5 sentences x 80ms = 400ms total, well past the 200ms budget, but no
    // single inference comes close to it. A whole-operation deadline would
    // have killed this; a per-utterance watchdog must not.
    const { module } = makeModule({ perCallMs: 80 });
    const out = await provider(module, { inferenceTimeoutMs: 200 }).synthesize({
      text: 'One. Two. Three. Four. Five.',
    });
    expect(out.wav.length).toBe(44 + 600 * 5 * 2);
  });
});
