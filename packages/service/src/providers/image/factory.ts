/**
 * Provider-selection helper for image generation.
 *
 * Selection rules (first-match):
 *   1. `GEZEL_MOCK_PROVIDER=1` → `MockImageProvider` (tests, CI).
 *   2. `config.imageProvider === 'google-ai'` → `GoogleAiImageProvider`
 *      with the SecretStore-stored Google AI Studio API key. A null
 *      key still returns the provider — `health()` reports
 *      `not-configured` so the UI can guide the user to add a key.
 *   3. `config.imageProvider === 'openai'` → `OpenAIImageProvider`
 *      (GPT Image 2). Same shape: lazy, missing key surfaces via
 *      `health()`.
 *   4. `config.imageProvider === 'mock'` → `MockImageProvider`.
 *   5. Otherwise the local engine, which inference owns so hosted inference
 *      serves the same provider (`createLocalImageProvider`).
 */
// patient-fetch-exempt: the local engine's builder (inference's createLocalImageProvider) passes patientFetch(); the cloud providers built here call remote APIs that should time out.

import type { GezelConfig } from '@bendyline/gezel';
import type { GpuArbiter } from '@bendyline/gezel-inference/internal/providers/gpu-arbiter';
import { createLocalImageProvider } from '@bendyline/gezel-inference/internal/providers/image/local-factory';
import type { SecretStore } from '@bendyline/gezel-inference/internal/secrets/types';
import { GoogleAiImageProvider } from './google-ai.js';
import { MockImageProvider } from './mock.js';
import { OpenAIImageProvider } from './openai-image.js';
import type { ImageProvider } from './types.js';

export {
  NoLocalImageModelError,
  type ResolvedInstalledModel,
  buildSdServerArgs,
  sdServerCapacity,
} from '@bendyline/gezel-inference/internal/providers/image/local-factory';

export interface ImageProviderFactoryOptions {
  home: string;
  /** Override for tests. */
  env?: NodeJS.ProcessEnv;
  /** Active config — drives the cloud-vs-local branch. Optional for legacy callers. */
  config?: GezelConfig;
  /** SecretStore the cloud branches read API keys from. Required for cloud providers. */
  secrets?: SecretStore;
  /** Force the native provider even when a legacy config selected cloud. */
  localOnly?: boolean;
  /**
   * Cross-engine GPU coordinator. Forwarded only to the supervised
   * sd-cpp branch — cloud providers and the user-runs-their-own
   * (`GEZEL_SD_SERVER_URL`) path don't manage VRAM tenancy.
   */
  arbiter?: GpuArbiter;
}

export async function createImageProvider(
  opts: ImageProviderFactoryOptions,
): Promise<ImageProvider> {
  const env = opts.env ?? process.env;
  if (env.GEZEL_MOCK_PROVIDER === '1') {
    return new MockImageProvider();
  }

  const choice = opts.localOnly ? undefined : opts.config?.imageProvider;
  if (choice === 'google-ai') {
    const apiKey = opts.secrets
      ? await opts.secrets.get({ kind: 'providerCredential', name: 'googleAiApiKey' })
      : null;
    return new GoogleAiImageProvider({ apiKey });
  }
  if (choice === 'openai') {
    const [apiKey, organization] = opts.secrets
      ? await Promise.all([
          opts.secrets.get({ kind: 'providerCredential', name: 'openaiApiKey' }),
          opts.secrets.get({ kind: 'providerCredential', name: 'openaiOrganization' }),
        ])
      : [null, null];
    return new OpenAIImageProvider({ apiKey, organization });
  }
  if (choice === 'mock') {
    return new MockImageProvider();
  }

  // The user's pick in Settings -> Image generation. Only meaningful for the
  // local engine; the cloud branches carry their own per-provider default.
  const defaultModelId = opts.config?.defaultImageModel?.['sd-cpp'];
  return createLocalImageProvider({
    home: opts.home,
    env,
    ...(defaultModelId ? { defaultModelId } : {}),
    ...(opts.arbiter ? { arbiter: opts.arbiter } : {}),
  });
}
