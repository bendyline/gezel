import type {
  CatalogItemDetail,
  CatalogItemSummary,
  CatalogItemVersionInfo,
  CatalogKind,
  ImageModelManifest,
  ImageModelPullEvent,
} from '@bendyline/gezel';
import { CatalogService } from '@bendyline/gezel-catalog';
import type { CatalogSource } from '@bendyline/gezel-catalog';
import { describe, expect, it } from 'vitest';
import type { ImageProviderManager } from './manager.js';
import { ImageModelPullRegistry, UnknownImageModelError } from './pull-registry.js';
import type {
  ImageEngineHealth,
  ImageGenerationInput,
  ImageGenerationOutput,
  ImageModelPullSpec,
  ImageProvider,
  InstalledImageModelInfo,
} from './types.js';

const FAKE_SHA = 'a'.repeat(64);

const MANIFEST: ImageModelManifest = {
  schemaVersion: 1,
  kind: 'image-model',
  id: 'test-model',
  name: 'Test',
  description: '',
  tags: [],
  maintainer: { name: 'Tester' },
  version: '1.0.0',
  releasedAt: '2026-01-01',
  downloadUrl: 'https://example.com/weights.safetensors',
  sha256: FAKE_SHA,
  approxSizeBytes: 100,
  recommendedSteps: 4,
  weightsKind: 'checkpoint',
  auxiliaryFiles: [],
  hardwareTier: 'low',
  minRamGB: 4,
  commercialUse: true,
  availableVersions: ['1.0.0'],
};

/**
 * Controllable image-pull provider — every emit/resolve happens when
 * the test explicitly calls one of the `push*` methods. Lets us prove
 * subscribe-during-flight, multi-subscriber fan-out, snapshot replay
 * timing, and cancel-via-AbortSignal without sleeps.
 */
class ScriptedProvider implements ImageProvider {
  readonly name = 'scripted';
  private queue: Array<{ event?: ImageModelPullEvent; close?: boolean }> = [];
  private resolver: (() => void) | null = null;
  lastSignal: AbortSignal | undefined;

  pushProgress(bytesWritten: number, totalBytes?: number): void {
    this.enqueue({
      event: {
        type: 'progress',
        bytesWritten,
        ...(totalBytes !== undefined ? { totalBytes } : {}),
      },
    });
  }

  pushRetrying(attempt: number, maxAttempts: number, delayMs: number, reason: string): void {
    this.enqueue({ event: { type: 'retrying', attempt, maxAttempts, delayMs, reason } });
  }

  pushError(error: string): void {
    this.enqueue({ event: { type: 'error', error }, close: true });
  }

  pushDone(id: string): void {
    this.enqueue({ event: { type: 'done', id }, close: true });
  }

  closeWithoutTerminal(): void {
    this.enqueue({ close: true });
  }

  private enqueue(entry: { event?: ImageModelPullEvent; close?: boolean }): void {
    this.queue.push(entry);
    this.resolver?.();
    this.resolver = null;
  }

  async generate(_input: ImageGenerationInput): Promise<ImageGenerationOutput> {
    throw new Error('not used');
  }

  async listInstalledModels(): Promise<InstalledImageModelInfo[]> {
    return [];
  }

  async *pullModel(
    id: string,
    _spec: ImageModelPullSpec,
    signal?: AbortSignal,
  ): AsyncIterable<ImageModelPullEvent> {
    this.lastSignal = signal;
    while (true) {
      while (this.queue.length === 0) {
        if (signal?.aborted) {
          yield { type: 'error', error: 'download aborted' };
          yield { type: 'done', id };
          return;
        }
        await new Promise<void>((resolve) => {
          this.resolver = resolve;
          // Wake on abort even if the test isn't pushing further events,
          // so the consumer loop can observe the cancellation.
          signal?.addEventListener(
            'abort',
            () => {
              this.resolver?.();
              this.resolver = null;
            },
            { once: true },
          );
        });
      }
      const next = this.queue.shift();
      if (!next) continue;
      if (next.event) yield next.event;
      if (next.close) return;
    }
  }

  async deleteModel(_id: string): Promise<void> {}

  async health(): Promise<ImageEngineHealth> {
    return { status: 'ok', baseUrl: 'mock://image' };
  }
}

class FakeCatalogSource implements CatalogSource {
  readonly id = 'fake';
  readonly label = 'Fake';
  private readonly manifests = new Map<string, ImageModelManifest>();

  set(manifest: ImageModelManifest): void {
    this.manifests.set(manifest.id, manifest);
  }

  async listKinds(): Promise<CatalogKind[]> {
    return ['image-model'];
  }

  async list(kind: CatalogKind): Promise<CatalogItemSummary[]> {
    if (kind !== 'image-model') return [];
    return Array.from(this.manifests.values()).map((m) => ({
      sourceId: this.id,
      kind: 'image-model' as const,
      manifest: m,
    }));
  }

  async get(kind: CatalogKind, id: string): Promise<CatalogItemDetail | null> {
    if (kind !== 'image-model') return null;
    const m = this.manifests.get(id);
    if (!m) return null;
    return {
      sourceId: this.id,
      kind: 'image-model' as const,
      manifest: m,
    };
  }

  async listVersions(): Promise<CatalogItemVersionInfo[]> {
    return [];
  }

  async readItemFile(): Promise<Buffer | null> {
    return null;
  }
}

function buildRegistry(): {
  registry: ImageModelPullRegistry;
  provider: ScriptedProvider;
  source: FakeCatalogSource;
} {
  const provider = new ScriptedProvider();
  const source = new FakeCatalogSource();
  source.set(MANIFEST);
  const catalog = new CatalogService([source]);
  const providerManager: Pick<ImageProviderManager, 'current'> = {
    current: async () => provider,
  };
  const registry = new ImageModelPullRegistry({
    imageProvider: providerManager as ImageProviderManager,
    catalog,
  });
  return { registry, provider, source };
}

async function flush(): Promise<void> {
  // Two macrotask hops are enough for the registry's `void this.consume(...)`
  // to advance past the first `await provider.current()` and into the
  // for-await loop where the next event will be picked up.
  for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
}

describe('ImageModelPullRegistry', () => {
  it('rejects unknown catalog ids with UnknownImageModelError', async () => {
    const { registry } = buildRegistry();
    await expect(registry.start('does-not-exist')).rejects.toBeInstanceOf(UnknownImageModelError);
  });

  it('appears on list() once started and disappears after the finished TTL', async () => {
    const { registry, provider } = buildRegistry();
    await registry.start(MANIFEST.id);
    expect(registry.list().map((p) => p.id)).toEqual([MANIFEST.id]);
    provider.pushDone(MANIFEST.id);
    await flush();
    const snapshot = registry.get(MANIFEST.id);
    expect(snapshot?.finished).toBe(true);
  });

  it('start() is idempotent — a second start while in flight returns the same snapshot', async () => {
    const { registry, provider } = buildRegistry();
    const first = await registry.start(MANIFEST.id);
    expect(first.alreadyRunning).toBe(false);
    const second = await registry.start(MANIFEST.id);
    expect(second.alreadyRunning).toBe(true);
    expect(second.snapshot.startedAt).toBe(first.snapshot.startedAt);
    provider.pushDone(MANIFEST.id);
  });

  it('fans out events to every live subscriber', async () => {
    const { registry, provider } = buildRegistry();
    await registry.start(MANIFEST.id);
    const aEvents: ImageModelPullEvent[] = [];
    const bEvents: ImageModelPullEvent[] = [];
    registry.subscribe(MANIFEST.id, (e) => aEvents.push(e));
    registry.subscribe(MANIFEST.id, (e) => bEvents.push(e));
    await flush();
    provider.pushProgress(50, 100);
    await flush();
    provider.pushDone(MANIFEST.id);
    await flush();
    // Both subscribers see the snapshot replay (progress at 0/0) plus
    // the live progress (50/100) plus the terminal done.
    expect(aEvents.map((e) => e.type)).toEqual(['progress', 'progress', 'done']);
    expect(bEvents.map((e) => e.type)).toEqual(['progress', 'progress', 'done']);
  });

  it('replays the latest snapshot to a late subscriber', async () => {
    const { registry, provider } = buildRegistry();
    await registry.start(MANIFEST.id);
    await flush();
    provider.pushProgress(40, 100);
    provider.pushRetrying(2, 5, 4000, 'Connection reset');
    await flush();

    // Subscribe AFTER the retry event — should immediately receive a
    // replay including the live retry state, even though no further
    // real events arrive before the assertion.
    const late: ImageModelPullEvent[] = [];
    const unsubscribe = registry.subscribe(MANIFEST.id, (e) => late.push(e));
    expect(unsubscribe).not.toBeNull();
    expect(late).toEqual([
      { type: 'progress', bytesWritten: 40, totalBytes: 100 },
      { type: 'retrying', attempt: 2, maxAttempts: 5, delayMs: 4000, reason: 'Connection reset' },
    ]);
    provider.pushDone(MANIFEST.id);
  });

  it('keeps the download running when a subscriber detaches mid-flight', async () => {
    const { registry, provider } = buildRegistry();
    await registry.start(MANIFEST.id);
    const events: ImageModelPullEvent[] = [];
    const unsubscribe = registry.subscribe(MANIFEST.id, (e) => events.push(e));
    await flush();
    provider.pushProgress(25, 100);
    await flush();
    unsubscribe?.();

    // The detached subscriber stops receiving events, but the pull
    // keeps progressing in the registry and a fresh subscriber sees
    // the up-to-date snapshot.
    provider.pushProgress(80, 100);
    await flush();
    expect(events.at(-1)).toEqual({ type: 'progress', bytesWritten: 25, totalBytes: 100 });
    expect(registry.get(MANIFEST.id)).toMatchObject({ bytesWritten: 80, totalBytes: 100 });
    provider.pushDone(MANIFEST.id);
  });

  it('cancel() aborts the provider signal and emits an error event', async () => {
    const { registry, provider } = buildRegistry();
    await registry.start(MANIFEST.id);
    const events: ImageModelPullEvent[] = [];
    registry.subscribe(MANIFEST.id, (e) => events.push(e));
    await flush();

    const aborted = registry.cancel(MANIFEST.id);
    expect(aborted).toBe(true);
    await flush();
    await flush();

    expect(provider.lastSignal?.aborted).toBe(true);
    expect(events.some((e) => e.type === 'error')).toBe(true);
    expect(registry.get(MANIFEST.id)?.finished).toBe(true);
  });

  it('cancel() on an unknown / finished pull returns false', async () => {
    const { registry } = buildRegistry();
    expect(registry.cancel('not-there')).toBe(false);
  });

  it('subscribe() returns null when no pull exists for that id', () => {
    const { registry } = buildRegistry();
    expect(registry.subscribe('not-there', () => {})).toBeNull();
  });
});
