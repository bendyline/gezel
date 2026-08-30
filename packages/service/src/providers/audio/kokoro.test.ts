import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  KOKORO_DEFAULT_MODEL_ID,
  type KokoroAudioOutput,
  type KokoroJsModule,
  KokoroProvider,
  type KokoroProviderOptions,
  type KokoroTextSplitterStream,
  KokoroTimeoutError,
} from './kokoro.js';

/**
 * Faithful stand-in for kokoro-js's TextSplitterStream: it holds the
 * trailing sentence back until `close()` is called. That buffering is
 * what makes an unclosed splitter deadlock the consumer, so the fake
 * has to reproduce it for the regression test to mean anything.
 */
class FakeSplitter implements KokoroTextSplitterStream {
  closed = false;
  readonly pushed: string[] = [];
  push(...text: string[]): void {
    if (this.closed) throw new Error('push after close');
    this.pushed.push(...text);
  }
  close(): void {
    this.closed = true;
  }
  sentences(): string[] {
    return this.pushed
      .join('')
      .split(/(?<=[.!?])\s+/)
      .filter((s) => s.trim().length > 0);
  }
}

function audio(length: number): KokoroAudioOutput {
  return { audio: new Float32Array(length).fill(0.5), sampling_rate: 24_000 };
}

function makeModule(opts: { withSplitter: boolean }): {
  module: KokoroJsModule;
  calls: { generate: number; splitters: FakeSplitter[] };
} {
  const calls = { generate: 0, splitters: [] as FakeSplitter[] };
  const instance = {
    async generate(): Promise<KokoroAudioOutput> {
      calls.generate++;
      return audio(1200);
    },
    async *stream(text: string | KokoroTextSplitterStream) {
      // kokoro-js 1.2.1 accepts a bare string here and builds an
      // internal splitter it never closes — a permanent hang. Our
      // provider must never take that path.
      if (typeof text === 'string') {
        throw new Error('stream() was handed a bare string — this deadlocks in kokoro-js');
      }
      const splitter = text as FakeSplitter;
      if (!splitter.closed) {
        throw new Error('stream() was handed an unclosed splitter — this deadlocks in kokoro-js');
      }
      for (const sentence of splitter.sentences()) {
        yield { text: sentence, phonemes: sentence, audio: audio(600) };
      }
    },
  };
  const module: KokoroJsModule = {
    KokoroTTS: { from_pretrained: async () => instance },
    ...(opts.withSplitter
      ? {
          TextSplitterStream: class extends FakeSplitter {
            constructor() {
              super();
              calls.splitters.push(this);
            }
          },
        }
      : {}),
  };
  return { module, calls };
}

describe('KokoroProvider.synthesize', () => {
  let home: string;
  let modelsRoot: string;

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
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  function provider(module: KokoroJsModule): KokoroProvider {
    return new KokoroProvider({
      modelsRoot,
      loadKokoroJs: async () => module,
      loadTransformersEnv: async () => ({
        cacheDir: '',
        useFSCache: true,
        allowRemoteModels: false,
      }),
    });
  }

  it('drives the stream API through a splitter it closes itself', async () => {
    const { module, calls } = makeModule({ withSplitter: true });
    const out = await provider(module).synthesize({
      text: 'One two three. Four five six.',
    });

    expect(calls.splitters).toHaveLength(1);
    expect(calls.splitters[0]?.closed).toBe(true);
    expect(calls.generate).toBe(0);
    // Two sentences streamed → both chunks concatenated into one WAV.
    expect(out.meta.sampleRate).toBe(24_000);
    expect(out.wav.length).toBe(44 + 1200 * 2);
  });

  it('synthesizes a single sentence — the case an unclosed splitter never yields at all', async () => {
    const { module, calls } = makeModule({ withSplitter: true });
    const out = await provider(module).synthesize({
      text: 'The quick brown fox jumps over the lazy dog.',
    });

    expect(calls.splitters[0]?.closed).toBe(true);
    expect(out.wav.length).toBe(44 + 600 * 2);
    expect(out.meta.durationSeconds).toBeGreaterThan(0);
  });

  it('falls back to one-shot generate when the splitter export is missing', async () => {
    const { module, calls } = makeModule({ withSplitter: false });
    const out = await provider(module).synthesize({ text: 'Hello there.' });

    expect(calls.generate).toBe(1);
    expect(out.wav.length).toBe(44 + 1200 * 2);
  });

  it('carries the resolved voice and default model into the output metadata', async () => {
    const { module } = makeModule({ withSplitter: true });
    const out = await provider(module).synthesize({ text: 'Hi.', voice: 'bm_george' });

    expect(out.meta.voice).toBe('bm_george');
    expect(out.meta.model).toBe(KOKORO_DEFAULT_MODEL_ID);
  });

  it('does not load the model for an already-cancelled request', async () => {
    const { module, calls } = makeModule({ withSplitter: true });
    const controller = new AbortController();
    controller.abort();

    await expect(
      provider(module).synthesize({ text: 'Never spoken.', signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls.splitters).toHaveLength(0);
    expect(calls.generate).toBe(0);
  });
});

describe('KokoroProvider watchdog', () => {
  let home: string;
  let modelsRoot: string;

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
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  function provider(module: KokoroJsModule, timeouts: Partial<KokoroProviderOptions> = {}) {
    return new KokoroProvider({
      modelsRoot,
      loadKokoroJs: async () => module,
      loadTransformersEnv: async () => ({
        cacheDir: '',
        useFSCache: true,
        allowRemoteModels: false,
      }),
      inferenceTimeoutMs: 200,
      loadTimeoutMs: 200,
      ...timeouts,
    });
  }

  const never = new Promise<never>(() => {});

  /** Module whose stream reproduces the kokoro-js 1.2.1 deadlock exactly. */
  function deadlockingModule(): KokoroJsModule {
    return {
      KokoroTTS: {
        from_pretrained: async () => ({
          generate: async () => never,
          async *stream() {
            await never;
            yield undefined as never; // unreachable: the await above never settles
          },
        }),
      },
      TextSplitterStream: FakeSplitter,
    };
  }

  it('aborts a stream that never yields instead of hanging forever', async () => {
    await expect(
      provider(deadlockingModule()).synthesize({ text: 'The quick brown fox.' }),
    ).rejects.toThrow(KokoroTimeoutError);
  });

  it('reports how far it got before the stall', async () => {
    await expect(
      provider(deadlockingModule()).synthesize({ text: 'The quick brown fox.' }),
    ).rejects.toThrow(/after 0 chunk\(s\)/);
  });

  it('aborts a wedged one-shot generate too', async () => {
    const module: KokoroJsModule = {
      KokoroTTS: { from_pretrained: async () => ({ generate: async () => never }) },
    };
    await expect(provider(module).synthesize({ text: 'Hello.' })).rejects.toThrow(
      KokoroTimeoutError,
    );
  });

  it('aborts a model load that never resolves', async () => {
    const module: KokoroJsModule = {
      KokoroTTS: { from_pretrained: () => never },
      TextSplitterStream: FakeSplitter,
    };
    await expect(provider(module).synthesize({ text: 'Hello.' })).rejects.toThrow(
      /Loading the Kokoro model timed out/,
    );
  });

  it('does not abort slow-but-progressing narration whose total exceeds one chunk budget', async () => {
    const perChunkMs = 80;
    const module: KokoroJsModule = {
      KokoroTTS: {
        from_pretrained: async () => ({
          generate: async () => audio(10),
          async *stream(text: string | KokoroTextSplitterStream) {
            for (const sentence of (text as FakeSplitter).sentences()) {
              await new Promise((r) => setTimeout(r, perChunkMs));
              yield { text: sentence, phonemes: sentence, audio: audio(600) };
            }
          },
        }),
      },
      TextSplitterStream: FakeSplitter,
    };

    // 5 chunks x 80ms = 400ms total, well past the 200ms budget, but no
    // single chunk comes close to it. A whole-operation deadline would
    // have killed this; a per-chunk watchdog must not.
    const out = await provider(module, { inferenceTimeoutMs: 200 }).synthesize({
      text: 'One. Two. Three. Four. Five.',
    });

    expect(out.wav.length).toBe(44 + 600 * 5 * 2);
  });
});
