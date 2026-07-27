import type { ImageRecognition, RecognitionHealth, RecognitionMode } from '@bendyline/gezel';
import { createRecognitionProvider } from './factory.js';
import { RecognitionCache } from './store.js';
import type { RecognitionProvider, RecognizeInput } from './types.js';

/**
 * Owns the recognition provider's lifecycle and the result cache.
 *
 * Same shape as `SttManager`: build lazily on first use, dedupe concurrent
 * builds, and `reset()` when config changes so a model swap in Settings takes
 * effect without a daemon restart.
 */

export interface RecognitionManagerOptions {
  home: string;
  modelId?: string;
  provider?: RecognitionProvider;
  cache?: RecognitionCache;
  env?: NodeJS.ProcessEnv;
}

export class RecognitionManager {
  private readonly home: string;
  private readonly env?: NodeJS.ProcessEnv;
  private readonly cache: RecognitionCache;
  private modelId?: string;
  private provider: RecognitionProvider | null;
  private building: Promise<RecognitionProvider> | null = null;
  /** In-flight recognitions keyed by cache key — see {@link recognize}. */
  private readonly inFlight = new Map<string, Promise<ImageRecognition>>();

  constructor(opts: RecognitionManagerOptions) {
    this.home = opts.home;
    this.modelId = opts.modelId;
    this.provider = opts.provider ?? null;
    this.cache = opts.cache ?? new RecognitionCache({ home: opts.home });
    this.env = opts.env;
  }

  async current(): Promise<RecognitionProvider> {
    if (this.provider) return this.provider;
    if (!this.building) {
      this.building = createRecognitionProvider({
        home: this.home,
        ...(this.modelId ? { modelId: this.modelId } : {}),
        ...(this.env ? { env: this.env } : {}),
      })
        .then((p) => {
          this.provider = p;
          return p;
        })
        .finally(() => {
          this.building = null;
        });
    }
    return this.building;
  }

  /** Drop the built provider so the next call picks up new config. */
  async reset(modelId?: string): Promise<void> {
    const previous = this.provider;
    this.provider = null;
    this.building = null;
    if (modelId !== undefined) this.modelId = modelId;
    await previous?.shutdown().catch(() => {});
  }

  async health(): Promise<RecognitionHealth> {
    const provider = await this.current();
    return provider.health();
  }

  /** Cheap enough to call on every turn — `health()` never spawns the engine. */
  async isAvailable(): Promise<boolean> {
    try {
      return (await this.health()).state === 'ok';
    } catch {
      return false;
    }
  }

  /**
   * Recognize with caching and single-flight.
   *
   * Single-flight matters more than it looks: two sessions pasting the same
   * screenshot, or a re-send after an edit, would otherwise each pay a full
   * decode on a one-slot engine — the second one queued behind the first for
   * an identical answer.
   */
  async recognize(
    input: Omit<RecognizeInput, 'mode'> & { mode: RecognitionMode },
  ): Promise<ImageRecognition> {
    const provider = await this.current();
    const key = this.cache.keyFor({
      bytes: input.bytes,
      mode: input.mode,
      modelId: this.modelId ?? provider.name,
    });

    const cached = await this.cache.get(key);
    if (cached) return cached;

    const running = this.inFlight.get(key);
    if (running) return running;

    const run = provider
      .recognize(input)
      .then(async (result) => {
        // Only durable outcomes are cached. A capacity denial or a crashed
        // engine must not pin `static-only` for that image forever.
        if (result.status === 'ok' || result.status === 'partial') {
          await this.cache.put(key, result);
        }
        return result;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });
    this.inFlight.set(key, run);
    return run;
  }

  /** Drop every cached description. Surfaced in Settings. */
  async clearCache(): Promise<void> {
    await this.cache.clear();
  }

  async shutdown(): Promise<void> {
    await this.provider?.shutdown().catch(() => {});
  }
}
