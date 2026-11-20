import { mobileQueryModels, queryModelStoreId } from './catalog.js';
import type { GezelKnowledgePlugin } from './definitions.js';
import { GezelKnowledge } from './manager.js';
import { createQueryEmbedder } from './query-model.js';

/**
 * One embedding profile's model on this device, for an app that embeds its
 * own text: semantic search over a person's notes, say. It is the same model
 * a catalog's searches use (installed into the same store), so a device that
 * already downloaded it for knowledge has nothing to download.
 *
 * Vectors match the desktop embedder's for the profile: queries get the
 * profile's query instruction here, and passages are embedded exactly as
 * given, because their embed input already carries their instruction.
 */
export interface MobileTextEmbedderStatus {
  readonly state: 'ready' | 'download-required' | 'downloading' | 'unavailable';
  readonly receivedBytes: number;
  readonly totalBytes: number;
  /** Why the last download stopped, in plain words; null otherwise. */
  readonly error: string | null;
}

export interface MobileTextEmbedder {
  readonly profileId: string;
  readonly dimensions: number;
  status(): Promise<MobileTextEmbedderStatus>;
  /** Download the model; single-flight. Resolves once every file is installed. */
  install(): Promise<void>;
  /** One unit vector per text, in order. */
  embed(kind: 'passage' | 'query', texts: readonly string[]): Promise<Float32Array[]>;
  /** The profile's tokenizer files as text, so the app chunks in the model's tokens. */
  tokenizer(): Promise<{ definition: string; config: string }>;
}

export interface MobileTextEmbedderOptions {
  /** Default `bge-small-en-v1.5@1`. */
  readonly profileId?: string;
  readonly plugin?: GezelKnowledgePlugin;
  /** Waits before each retry of an interrupted download that saved no new bytes. */
  readonly downloadRetryDelaysMs?: readonly number[];
}

const RETRY_DELAYS_MS = [2_000, 5_000, 10_000, 20_000, 30_000];

const sdkCode = (error: unknown) =>
  error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : '';

export function createMobileTextEmbedder(
  options: MobileTextEmbedderOptions = {},
): MobileTextEmbedder {
  const plugin = options.plugin ?? GezelKnowledge;
  const profileId = options.profileId ?? 'bge-small-en-v1.5@1';
  const model = mobileQueryModels.find((entry) => entry.id === profileId);
  if (!model) throw new Error(`No mobile model for ${profileId}`);
  const storeId = queryModelStoreId(model.id);
  const totalBytes = model.files.reduce((sum, file) => sum + file.size, 0);
  let baseUrl: Promise<string> | undefined;
  const embedder = createQueryEmbedder(plugin, () => {
    baseUrl ??= plugin.info().then((info) => info.baseUrl);
    return baseUrl;
  });
  let installing: Promise<void> | null = null;
  let received = 0;
  let lastError: string | null = null;

  const installed = async () => {
    const files = (await plugin.info()).catalogs.find((entry) => entry.id === storeId)?.files;
    return !!files && model.files.every((file) => files.includes(file.name));
  };

  const install = (): Promise<void> => {
    installing ??= (async () => {
      lastError = null;
      received = 0;
      const listener = await plugin.addListener('knowledgeDownload', (event) => {
        if (event.id === storeId) received = event.receivedBytes;
      });
      try {
        let saved = 0;
        let stalled = 0;
        while (true) {
          try {
            await plugin.installModel({ id: storeId, files: model.files });
            return;
          } catch (error) {
            if (received > saved) {
              saved = received;
              stalled = 0;
            }
            const delay = (options.downloadRetryDelaysMs ?? RETRY_DELAYS_MS)[stalled++];
            if (sdkCode(error) !== 'interrupted' || delay === undefined) {
              lastError =
                sdkCode(error) === 'cancelled'
                  ? null
                  : sdkCode(error) === 'storage'
                    ? 'The search model could not be saved. Free up storage on this device and try again.'
                    : 'The search model download stopped. Try again to continue where it stopped.';
              throw error;
            }
            await new Promise((resolve) => setTimeout(resolve, delay));
          }
        }
      } finally {
        await listener.remove();
      }
    })().finally(() => {
      installing = null;
    });
    return installing;
  };

  return {
    profileId: model.id,
    dimensions: model.dimensions,
    async status() {
      if (installing) {
        return { state: 'downloading', receivedBytes: received, totalBytes, error: null };
      }
      try {
        return (await installed())
          ? { state: 'ready', receivedBytes: totalBytes, totalBytes, error: null }
          : { state: 'download-required', receivedBytes: 0, totalBytes, error: lastError };
      } catch {
        return { state: 'unavailable', receivedBytes: 0, totalBytes, error: null };
      }
    },
    install,
    async embed(kind, texts) {
      const vectors: Float32Array[] = [];
      // One native call per text; the store serializes model use anyway.
      for (const text of texts) {
        vectors.push(
          kind === 'query'
            ? await embedder.embed(model.id, text)
            : await embedder.embedPassage(model.id, text),
        );
      }
      return vectors;
    },
    tokenizer: () => embedder.tokenizerFiles(model.id),
  };
}
