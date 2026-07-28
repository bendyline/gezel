import { join } from 'node:path';
import { Agent, fetch as undiciFetch } from 'undici';
import { modelStorageRoots } from '../../models/storage-roots.js';
import { pickFreePort } from '../native/port.js';
import { NativeEngineSupervisor } from '../native/supervisor.js';
import { DEFAULT_RECOGNITION_MODEL_ID } from './catalog.js';
import { LlamaVisionProvider } from './llama-vision.js';
import { MockRecognitionProvider } from './mock.js';
import type { RecognitionProvider } from './types.js';

/**
 * Selection ladder, mirroring `stt-factory.ts`:
 *   mock → external URL → supervised local binary → unconfigured stub.
 *
 * The unconfigured stub is not a failure mode — its `health()` tells the user
 * what to install, and the chat path degrades to static image metadata rather
 * than dropping the turn.
 */

export interface RecognitionFactoryOptions {
  home: string;
  modelId?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Node's default fetch aborts after 5 minutes of header silence. A cold vision
 * model load on a weak box legitimately exceeds that, and the failure looks
 * like a hang rather than a timeout. Same dispatcher the STT factory uses.
 */
let cachedPatientFetch: typeof fetch | undefined;
function patientFetch(): typeof fetch {
  if (!cachedPatientFetch) {
    const dispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 });
    cachedPatientFetch = ((
      url: Parameters<typeof undiciFetch>[0],
      init?: Parameters<typeof undiciFetch>[1],
    ) => undiciFetch(url, { ...init, dispatcher })) as unknown as typeof fetch;
  }
  return cachedPatientFetch;
}

export function recognitionModelsRoot(home: string): string {
  return join(home, 'engines', 'recognition', 'models');
}

export async function createRecognitionProvider(
  opts: RecognitionFactoryOptions,
): Promise<RecognitionProvider> {
  const env = opts.env ?? process.env;
  const storageRoots = modelStorageRoots({ home: opts.home, engine: 'recognition', env });
  const modelsRoot = storageRoots.writableRoot;
  const modelId = opts.modelId ?? DEFAULT_RECOGNITION_MODEL_ID;

  if (env.GEZEL_MOCK_PROVIDER === '1') {
    return new MockRecognitionProvider();
  }

  if (env.GEZEL_RECOGNITION_SERVER_URL) {
    return new LlamaVisionProvider({
      baseUrl: env.GEZEL_RECOGNITION_SERVER_URL,
      modelsRoot,
      storageRoots,
      modelId,
      fetchImpl: patientFetch(),
    });
  }

  const binary = env.GEZEL_LLAMA_SERVER_BIN;
  if (binary) {
    let cachedPort: number | undefined;
    const supervisor = new NativeEngineSupervisor({
      logPrefix: '[vision-server]',
      startupTimeoutMs: 3 * 60 * 1000,
      // Much shorter than chat's 30 minutes: holding ~3 GB resident after one
      // pasted screenshot is antisocial on a box also running a chat model.
      idleTimeoutMs: 5 * 60 * 1000,
      resolveLaunch: async () => {
        const port = cachedPort ?? (await pickFreePort());
        cachedPort = port;
        const provider = new LlamaVisionProvider({
          baseUrl: '',
          modelsRoot,
          storageRoots,
          modelId,
        });
        const installed = await provider.listInstalledModels();
        const chosen = installed.find((m) => m.id === modelId) ?? installed[0];
        if (!chosen?.weightsPath || !chosen.mmprojPath) {
          throw new Error(
            'No image-recognition model is installed. Download one from Settings → Workloads → Image recognition.',
          );
        }
        return {
          command: binary,
          args: [
            '--host',
            '127.0.0.1',
            '--port',
            String(port),
            '--model',
            chosen.weightsPath,
            '--mmproj',
            chosen.mmprojPath,
            // One image at a time; a bigger window buys nothing for a
            // single-shot decode and costs resident memory.
            '--ctx-size',
            '8192',
            '--parallel',
            '1',
          ],
          baseUrl: `http://127.0.0.1:${port}`,
        };
      },
    });
    return new LlamaVisionProvider({
      baseUrl: 'http://127.0.0.1:9084',
      modelsRoot,
      storageRoots,
      modelId,
      supervisor,
      fetchImpl: patientFetch(),
    });
  }

  return new LlamaVisionProvider({
    baseUrl: 'http://127.0.0.1:9084',
    modelsRoot,
    storageRoots,
    modelId,
    configured: false,
  });
}
