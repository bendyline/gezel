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
 * subprocess), TTS runs `kokoro-js` on a worker thread of the daemon.
 * There's no `*_BIN` to wire — the cost of "lazy starting" is the worker
 * spawn plus the first `from_pretrained` call, both deferred to the first
 * synthesis.
 */

// patient-fetch-exempt: KokoroProvider runs the model locally (ONNX on a worker thread), not
// over HTTP — there is no request for a fetch timeout to cut.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { speechAssetOptions } from '@bendyline/gezel/speech-models';
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

  const assets = speechAssetOptions({ home: opts.home, env });
  // kokoro-js already ships the voice vectors. Adopt their verified bytes
  // instead of fetching another copy just to make them available to embedders.
  let packagedVoices: string | undefined;
  try {
    packagedVoices = join(dirname(fileURLToPath(import.meta.resolve('kokoro-js'))), '..');
  } catch {
    /* Optional runtime absent. */
  }
  return new KokoroProvider({
    modelsRoot,
    assets: {
      ...assets,
      candidates: (model, file) => [
        ...(assets.candidates?.(model, file) ?? []),
        ...(packagedVoices && file.name.startsWith('voices/')
          ? [join(packagedVoices, ...file.name.split('/'))]
          : []),
      ],
    },
    cacheDir: env[HF_CACHE_DIR_ENV] ?? transformersCacheDir(opts.home),
  });
}
