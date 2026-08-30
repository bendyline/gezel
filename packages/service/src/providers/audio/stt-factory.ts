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

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type ModelStorageRoots,
  findModelRoot,
  listOverlayModelIds,
  modelStorageRoots,
  verifyReadOnlyModelPayload,
} from '../../models/storage-roots.js';
import { pickFreePort } from '../native/port.js';
import { NativeEngineSupervisor } from '../native/supervisor.js';
import { patientFetch } from '../patient-fetch.js';
import { MockSpeechToTextProvider } from './mock-stt.js';
import type { SpeechToTextProvider } from './types.js';
import { WhisperCppProvider } from './whisper-cpp.js';

export interface SpeechToTextFactoryOptions {
  home: string;
  env?: NodeJS.ProcessEnv;
  /**
   * The user's configured default model (`config.defaultSttModel`,
   * Settings -> Audio). whisper-server binds one model per process, so this
   * is the model it launches with. An id that is no longer installed falls
   * through to the first installed model by id.
   */
  defaultModelId?: string;
}

export async function createSpeechToTextProvider(
  opts: SpeechToTextFactoryOptions,
): Promise<SpeechToTextProvider> {
  const env = opts.env ?? process.env;
  const storageRoots = modelStorageRoots({ home: opts.home, engine: 'whisper-cpp', env });
  const modelsRoot = storageRoots.writableRoot;

  if (env.GEZEL_MOCK_PROVIDER === '1') {
    return new MockSpeechToTextProvider({ modelsRoot });
  }

  if (env.GEZEL_WHISPER_SERVER_URL) {
    return new WhisperCppProvider({
      baseUrl: env.GEZEL_WHISPER_SERVER_URL,
      modelsRoot,
      storageRoots,
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
        const model = await selectWhisperModel(storageRoots, opts.defaultModelId);
        if (!model) {
          throw new Error(
            'No STT model is available locally. Download one from Settings → Audio before transcribing.',
          );
        }
        return {
          command: binary,
          args: ['--host', '127.0.0.1', '--port', String(port), '--model', model.weightsPath],
          baseUrl: `http://127.0.0.1:${port}`,
        };
      },
    });
    return new WhisperCppProvider({
      baseUrl: 'http://127.0.0.1:9082',
      modelsRoot,
      storageRoots,
      supervisor,
      fetchImpl: patientFetch(),
    });
  }

  return new WhisperCppProvider({
    baseUrl: 'http://127.0.0.1:9082',
    modelsRoot,
    storageRoots,
    configured: false,
  });
}

export interface ResolvedWhisperModel {
  id: string;
  name: string;
  weightsPath: string;
}

/**
 * The model whisper-server should launch with: the user's configured default
 * when it is still installed, else the first installed model by id — which is
 * what every install did before `config.defaultSttModel` existed.
 */
export async function selectWhisperModel(
  storageRoots: ModelStorageRoots,
  defaultModelId?: string,
): Promise<ResolvedWhisperModel | undefined> {
  const configured = defaultModelId
    ? await resolveWhisperModel(storageRoots, defaultModelId)
    : undefined;
  return configured ?? (await findFirstInstalledWhisperModel(storageRoots));
}

/** Read one installed whisper model's launch info, or undefined when it is
 *  absent, malformed, or fails the read-only payload check. */
async function resolveWhisperModel(
  storageRoots: ModelStorageRoots,
  id: string,
): Promise<ResolvedWhisperModel | undefined> {
  try {
    const root = await findModelRoot(storageRoots, id);
    if (!root) return undefined;
    const raw = await readFile(join(root, id, 'manifest.json'), 'utf8');
    const parsed = JSON.parse(raw) as {
      id?: string;
      name?: string;
      files?: Array<{ role?: string; filename?: string }>;
      fileSha256?: Record<string, string>;
    };
    if (!parsed.id || !parsed.name || !Array.isArray(parsed.files)) return undefined;
    if (!(await verifyReadOnlyModelPayload(storageRoots, root, id, parsed.fileSha256))) {
      return undefined;
    }
    const weightsFile = parsed.files.find((f) => f.role === 'weights' && f.filename);
    if (!weightsFile?.filename) return undefined;
    return {
      id: parsed.id,
      name: parsed.name,
      weightsPath: join(root, id, weightsFile.filename),
    };
  } catch {
    return undefined;
  }
}

async function findFirstInstalledWhisperModel(
  storageRoots: ModelStorageRoots,
): Promise<ResolvedWhisperModel | undefined> {
  const entries = await listOverlayModelIds(storageRoots);
  entries.sort();
  for (const id of entries) {
    const model = await resolveWhisperModel(storageRoots, id);
    if (model) return model;
  }
  return undefined;
}
