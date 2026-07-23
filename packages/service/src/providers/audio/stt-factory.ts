/**
 * Factory for the active speech-to-text provider.
 *
 * Selection rules (first-match):
 *   1. `GEZEL_MOCK_PROVIDER=1` → `MockSpeechToTextProvider`.
 *   2. `GEZEL_WHISPER_SERVER_URL` present → `WhisperCppProvider`
 *      pointed at that URL, no supervisor (user-runs-their-own mode).
 *   3. `GEZEL_WHISPER_SERVER_BIN` present → `WhisperCppProvider`
 *      backed by a `NativeEngineSupervisor` that spawns the binary
 *      on-demand at an ephemeral port.
 *   4. Fallback: `WhisperCppProvider` with `configured: false` so
 *      `health()` returns `not-configured` and the UI guides the
 *      user to enable it.
 *
 * Mirrors `image/factory.ts`'s shape exactly so the symmetry between
 * image and audio engines is preserved.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Agent, fetch as undiciFetch } from 'undici';
import { pickFreePort } from '../native/port.js';
import { NativeEngineSupervisor } from '../native/supervisor.js';
import { MockSpeechToTextProvider } from './mock-stt.js';
import type { SpeechToTextProvider } from './types.js';
import { WhisperCppProvider } from './whisper-cpp.js';

let cachedPatientFetch: typeof fetch | undefined;
function patientFetch(): typeof fetch {
  if (!cachedPatientFetch) {
    // Long-running transcriptions on a slow machine can hold the HTTP
    // request open well past Node's default 5-minute fetch timeout.
    // Disable both undici timeouts and let our own
    // `WhisperCppProviderOptions.timeoutMs` enforce the limit.
    const dispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 });
    cachedPatientFetch = ((
      url: Parameters<typeof undiciFetch>[0],
      init?: Parameters<typeof undiciFetch>[1],
    ) => undiciFetch(url, { ...init, dispatcher })) as unknown as typeof fetch;
  }
  return cachedPatientFetch;
}

export interface SpeechToTextFactoryOptions {
  home: string;
  env?: NodeJS.ProcessEnv;
}

export async function createSpeechToTextProvider(
  opts: SpeechToTextFactoryOptions,
): Promise<SpeechToTextProvider> {
  const env = opts.env ?? process.env;
  const modelsRoot = join(opts.home, 'engines', 'whisper-cpp', 'models');

  if (env.GEZEL_MOCK_PROVIDER === '1') {
    return new MockSpeechToTextProvider({ modelsRoot });
  }

  if (env.GEZEL_WHISPER_SERVER_URL) {
    return new WhisperCppProvider({
      baseUrl: env.GEZEL_WHISPER_SERVER_URL,
      modelsRoot,
      fetchImpl: patientFetch(),
    });
  }

  if (env.GEZEL_WHISPER_SERVER_BIN) {
    const binary = env.GEZEL_WHISPER_SERVER_BIN;
    let cachedPort: number | undefined;
    const supervisor = new NativeEngineSupervisor({
      logPrefix: '[whisper-server]',
      // whisper-server exposes a real /health, so the default readiness
      // path works — no readyOnAnyResponse needed unlike sd-server.
      startupTimeoutMs: 2 * 60 * 1000,
      resolveLaunch: async () => {
        const port = cachedPort ?? (await pickFreePort());
        cachedPort = port;
        const firstModel = await findFirstInstalledWhisperModel(modelsRoot);
        if (!firstModel) {
          throw new Error(
            'No STT model is available locally. Download one from Settings → Audio before transcribing.',
          );
        }
        return {
          command: binary,
          args: ['--host', '127.0.0.1', '--port', String(port), '--model', firstModel.weightsPath],
          baseUrl: `http://127.0.0.1:${port}`,
        };
      },
    });
    return new WhisperCppProvider({
      baseUrl: 'http://127.0.0.1:9082',
      modelsRoot,
      supervisor,
      fetchImpl: patientFetch(),
    });
  }

  return new WhisperCppProvider({
    baseUrl: 'http://127.0.0.1:9082',
    modelsRoot,
    configured: false,
  });
}

interface ResolvedWhisperModel {
  id: string;
  name: string;
  weightsPath: string;
}

async function findFirstInstalledWhisperModel(
  modelsRoot: string,
): Promise<ResolvedWhisperModel | undefined> {
  let entries: string[] = [];
  try {
    entries = await readdir(modelsRoot);
  } catch {
    return undefined;
  }
  entries.sort();
  for (const id of entries) {
    try {
      const raw = await readFile(join(modelsRoot, id, 'manifest.json'), 'utf8');
      const parsed = JSON.parse(raw) as {
        id?: string;
        name?: string;
        files?: Array<{ role?: string; filename?: string }>;
      };
      if (!parsed.id || !parsed.name || !Array.isArray(parsed.files)) continue;
      const weightsFile = parsed.files.find((f) => f.role === 'weights' && f.filename);
      if (!weightsFile?.filename) continue;
      return {
        id: parsed.id,
        name: parsed.name,
        weightsPath: join(modelsRoot, id, weightsFile.filename),
      };
    } catch {
      /* skip malformed */
    }
  }
  return undefined;
}
