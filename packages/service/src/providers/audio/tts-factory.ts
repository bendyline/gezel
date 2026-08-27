/**
 * Factory for the active text-to-speech provider.
 *
 * Selection rules (first-match):
 *   1. `GEZEL_MOCK_PROVIDER=1` → `MockTextToSpeechProvider`.
 *   2. Default: `KokoroProvider`. Always returned — health() reports
 *      `no-model` when nothing's been pulled yet, so the UI surfaces
 *      the install prompt rather than a generic unreachable error.
 *
 * Unlike STT (which has a `*_BIN` env-var branch that wires a native
 * subprocess), TTS is in-process via `kokoro-js`. There's no `*_BIN`
 * to wire — the cost of "lazy starting" is just the first
 * `from_pretrained` call, which the provider already gates with
 * `ensureLoaded()`.
 */

// patient-fetch-exempt: KokoroProvider runs the model in-process (ONNX), not over HTTP —
// there is no request for a fetch timeout to cut.
import { join } from 'node:path';
import { HF_CACHE_DIR_ENV, transformersCacheDir } from '../../transformers-cache.js';
import { KokoroProvider } from './kokoro.js';
import { MockTextToSpeechProvider } from './mock-tts.js';
import type { TextToSpeechProvider } from './types.js';

export interface TextToSpeechFactoryOptions {
  home: string;
  env?: NodeJS.ProcessEnv;
}

export async function createTextToSpeechProvider(
  opts: TextToSpeechFactoryOptions,
): Promise<TextToSpeechProvider> {
  const env = opts.env ?? process.env;
  const modelsRoot = join(opts.home, 'engines', 'kokoro', 'models');

  if (env.GEZEL_MOCK_PROVIDER === '1') {
    return new MockTextToSpeechProvider({ modelsRoot });
  }

  return new KokoroProvider({
    modelsRoot,
    cacheDir: env[HF_CACHE_DIR_ENV] ?? transformersCacheDir(opts.home),
  });
}
