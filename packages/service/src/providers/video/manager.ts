/**
 * VideoProviderManager — owns the active video provider's lifecycle.
 * Mirrors `ImageProviderManager`: lazy build, dedupe concurrent builds
 * via one in-flight promise, `reset()` tears down the cached instance so
 * the next `current()` rebuilds from fresh config.
 */

import { createLogger } from '@bendyline/gezel';
import type { CatalogService } from '@bendyline/gezel-catalog';
import type { Store } from '../../fs/store.js';
import type { UvRuntime } from '../../python/uv-runtime.js';
import type { RemotesRegistry } from '../../remotes/registry.js';
import type { GpuArbiter } from '../gpu-arbiter.js';
import { resolveRemoteTarget } from '../remote/resolve.js';
import { createVideoProvider } from './factory.js';
import { RemoteVideoProvider } from './remote-video.js';
import type { VideoProvider } from './types.js';

const log = createLogger('video');

export interface VideoProviderManagerOptions {
  home: string;
  store: Store;
  catalog: CatalogService;
  uvRuntime: UvRuntime;
  /** Override env for tests. */
  env?: NodeJS.ProcessEnv;
  /**
   * Cross-engine GPU coordinator. Forwarded into the factory so the
   * supervised diffusers engine registers its `'video'` evictor and
   * acquires the slot before each generate.
   */
  arbiter?: GpuArbiter;
}

export class VideoProviderManager {
  private readonly home: string;
  private readonly store: Store;
  private readonly catalog: CatalogService;
  private readonly uvRuntime: UvRuntime;
  private readonly env: NodeJS.ProcessEnv | undefined;
  private readonly arbiter: GpuArbiter | undefined;

  private current_: VideoProvider | null = null;
  private buildPromise: Promise<VideoProvider> | null = null;
  private remotes: RemotesRegistry | undefined;
  private machineEngineRemoteId?: () => string | null;
  private readonly remoteCache = new Map<
    string,
    { connectionKey: string; provider: RemoteVideoProvider }
  >();

  setRemotes(remotes: RemotesRegistry): void {
    this.remotes = remotes;
  }

  setMachineEngineRemoteResolver(resolve: (() => string | null) | undefined): void {
    this.machineEngineRemoteId = resolve;
  }

  /** Route `remote:<id>/…` video models to the hosting server; else local. */
  async providerForModel(model?: string): Promise<VideoProvider> {
    const target = resolveRemoteTarget(model, this.remotes, this.machineEngineRemoteId?.());
    if (!target) return this.current();
    const { remote, fetch } = target;
    const connectionKey = `${remote.baseUrl}\0${remote.token}\0${remote.pinnedIdentityFingerprint}`;
    let cached = this.remoteCache.get(remote.remoteId);
    if (!cached || cached.connectionKey !== connectionKey) {
      cached = {
        connectionKey,
        provider: new RemoteVideoProvider({
          remoteId: remote.remoteId,
          label: remote.displayName,
          baseUrl: remote.baseUrl,
          token: remote.token,
          fetch,
        }),
      };
      this.remoteCache.set(remote.remoteId, cached);
    }
    return cached.provider;
  }

  constructor(opts: VideoProviderManagerOptions) {
    this.home = opts.home;
    this.store = opts.store;
    this.catalog = opts.catalog;
    this.uvRuntime = opts.uvRuntime;
    this.env = opts.env;
    this.arbiter = opts.arbiter;
  }

  async current(): Promise<VideoProvider> {
    if (this.machineEngineRemoteId?.()) return this.providerForModel(undefined);
    if (this.current_) return this.current_;
    if (this.buildPromise) return this.buildPromise;
    this.buildPromise = (async () => {
      const config = await this.store.readConfig();
      const provider = await createVideoProvider({
        home: this.home,
        catalog: this.catalog,
        uvRuntime: this.uvRuntime,
        ...(this.env ? { env: this.env } : {}),
        config,
        ...(this.arbiter ? { arbiter: this.arbiter } : {}),
      });
      this.current_ = provider;
      return provider;
    })().finally(() => {
      this.buildPromise = null;
    });
    return this.buildPromise;
  }

  async reset(): Promise<void> {
    const prev = this.current_;
    this.current_ = null;
    if (prev?.shutdown) {
      await prev.shutdown().catch((err: unknown) => {
        log.warn(
          '[video-provider] shutdown during reset failed:',
          err instanceof Error ? err.message : String(err),
        );
      });
    }
  }

  async shutdown(): Promise<void> {
    await this.reset();
  }
}
