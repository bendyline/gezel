/**
 * ImageProviderManager — owns the active image provider's lifecycle.
 *
 * Why a manager instead of a raw provider on the context: cloud
 * providers are credentialled, swappable at runtime, and may not have a
 * key configured at boot. Building one eagerly fights both ergonomics
 * (a missing key shouldn't block service start) and correctness
 * (changing the provider in Settings needs to tear down the old one and
 * pick the new factory branch on the next call).
 *
 * Design mirrors `ChatManager.ensureProvider` / `resetClient` for the
 * LLM side: lazy build, dedupe concurrent builds via a single in-flight
 * promise, `reset()` shuts down the cached instance and clears state so
 * the next `current()` rebuilds from fresh config + secrets.
 */

import { createLogger } from '@bendyline/gezel';
import type { Store } from '../../fs/store.js';
import type { RemotesRegistry } from '../../remotes/registry.js';
import type { SecretStore } from '../../secrets/types.js';
import type { GpuArbiter } from '../gpu-arbiter.js';
import { resolveRemoteTarget } from '../remote/resolve.js';
import { createImageProvider } from './factory.js';
import { RemoteImageProvider } from './remote-image.js';

const log = createLogger('image');
import type { ImageProvider } from './types.js';

export interface ImageProviderManagerOptions {
  home: string;
  store: Store;
  secrets: SecretStore;
  /** Ignore cloud provider config; used by the machine-only engine broker. */
  localOnly?: boolean;
  /** Override env for tests. */
  env?: NodeJS.ProcessEnv;
  /**
   * Cross-engine GPU coordinator. Forwarded into the factory so the
   * supervised sd-cpp branch can register its evictor and acquire
   * the `'image'` slot before each generate. Optional: the cloud
   * branches and tests don't need it.
   */
  arbiter?: GpuArbiter;
}

export class ImageProviderManager {
  private readonly home: string;
  private readonly store: Store;
  private readonly secrets: SecretStore;
  private readonly env: NodeJS.ProcessEnv | undefined;
  private readonly arbiter: GpuArbiter | undefined;
  private readonly localOnly: boolean;

  private current_: ImageProvider | null = null;
  private buildPromise: Promise<ImageProvider> | null = null;
  private remotes: RemotesRegistry | undefined;
  private machineEngineRemoteId?: () => string | null;
  private readonly remoteCache = new Map<
    string,
    { connectionKey: string; provider: RemoteImageProvider }
  >();

  constructor(opts: ImageProviderManagerOptions) {
    this.home = opts.home;
    this.store = opts.store;
    this.secrets = opts.secrets;
    this.env = opts.env;
    this.arbiter = opts.arbiter;
    this.localOnly = opts.localOnly ?? false;
  }

  /** Wire the paired-servers registry so `remote:<id>/…` image models route
   *  to the hosting server. Injected by `service.ts`. */
  setRemotes(remotes: RemotesRegistry): void {
    this.remotes = remotes;
  }

  setMachineEngineRemoteResolver(resolve: (() => string | null) | undefined): void {
    this.machineEngineRemoteId = resolve;
  }

  /**
   * Resolve the provider for a specific model id: a `remote:<remoteId>/…` id
   * routes to a cached {@link RemoteImageProvider} for the hosting server;
   * everything else uses the local {@link current} provider. The image-gen
   * route calls this with the request's model so GPU-heavy generation runs on
   * the paired server while the artifact still persists into A's project.
   */
  async providerForModel(model?: string): Promise<ImageProvider> {
    const target = resolveRemoteTarget(model, this.remotes, this.machineEngineRemoteId?.());
    if (!target) return this.current();
    const { remote, fetch } = target;
    const connectionKey = `${remote.baseUrl}\0${remote.token}\0${remote.pinnedIdentityFingerprint}`;
    let cached = this.remoteCache.get(remote.remoteId);
    if (!cached || cached.connectionKey !== connectionKey) {
      cached = {
        connectionKey,
        provider: new RemoteImageProvider({
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

  /**
   * Resolve (and cache) the current image provider. Concurrent calls
   * share a single in-flight build to avoid duplicate factory work and
   * a leaked provider that never gets `shutdown()`.
   */
  async current(): Promise<ImageProvider> {
    if (this.machineEngineRemoteId?.()) return this.providerForModel(undefined);
    if (this.current_) return this.current_;
    if (this.buildPromise) return this.buildPromise;
    this.buildPromise = (async () => {
      const config = await this.store.readConfig();
      const provider = await createImageProvider({
        home: this.home,
        ...(this.env ? { env: this.env } : {}),
        config,
        secrets: this.secrets,
        localOnly: this.localOnly,
        ...(this.arbiter ? { arbiter: this.arbiter } : {}),
      });
      this.current_ = provider;
      return provider;
    })().finally(() => {
      this.buildPromise = null;
    });
    return this.buildPromise;
  }

  /**
   * Tear down the cached provider so the next `current()` rebuilds.
   * Called when image-related config or credentials change.
   */
  async reset(): Promise<void> {
    const prev = this.current_;
    this.current_ = null;
    if (prev?.shutdown) {
      await prev.shutdown().catch((err: unknown) => {
        log.warn(
          '[image-provider] shutdown during reset failed:',
          err instanceof Error ? err.message : String(err),
        );
      });
    }
  }

  async shutdown(): Promise<void> {
    await this.reset();
  }
}
