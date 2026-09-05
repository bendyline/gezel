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

import { type GezelConfig, createLogger } from '@bendyline/gezel';
import type { ConfigStore } from '../../fs/config-store.js';
import type { RemotesRegistry } from '../../remotes/registry.js';
import type { SecretStore } from '../../secrets/types.js';
import type { GpuArbiter } from '../gpu-arbiter.js';
import { ProviderLifecycle } from '../provider-lifecycle.js';
import { type RemoteTarget, resolveRemoteTarget } from '../remote/resolve.js';
import { createImageProvider } from './factory.js';
import { RemoteImageProvider } from './remote-image.js';

const log = createLogger('image');
import type { ImageProvider } from './types.js';

export interface ImageProviderManagerOptions {
  home: string;
  store: Pick<ConfigStore, 'readConfig'>;
  secrets?: SecretStore;
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
  private readonly store: Pick<ConfigStore, 'readConfig'>;
  private readonly secrets: SecretStore | undefined;
  private readonly env: NodeJS.ProcessEnv | undefined;
  private readonly arbiter: GpuArbiter | undefined;
  private readonly localOnly: boolean;

  private readonly local = new ProviderLifecycle<ImageProvider>(new Set(['generate']));
  private remotes: RemotesRegistry | undefined;
  private machineEngineRemoteId?: () => string | null;
  private readonly remoteCache = new Map<
    string,
    { connectionKey: string; provider: RemoteImageProvider }
  >();

  constructor(opts: ImageProviderManagerOptions) {
    if (!opts.localOnly && !opts.secrets)
      throw new Error('Product image providers require a credential store');
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
   * everything else uses the configured {@link current} provider. For a local
   * sd-cpp selection, `current()` delegates to the machine broker when one is
   * available. Cloud selections remain in this user daemon so their user-owned
   * credentials never cross the machine-service boundary.
   */
  async providerForModel(model?: string): Promise<ImageProvider> {
    // An explicit remote model always wins. Do not pass the machine broker as
    // a preferred target here: resolveRemoteTarget would otherwise wrap every
    // ordinary cloud model id (and undefined) as `remote:this-machine/…`
    // before config.imageProvider was consulted.
    const target = resolveRemoteTarget(model, this.remotes);
    if (!target) return this.current();
    return this.providerForRemoteTarget(target);
  }

  /**
   * Whether the configured image provider belongs on the machine broker.
   * Shared with the HTTP management-route proxy so status/model operations and
   * generation use exactly the same cloud-vs-native decision.
   */
  async usesMachineEngine(): Promise<boolean> {
    if (!this.machineEngineRemoteId?.()) return false;
    const config = await this.store.readConfig();
    return isMachineImageProvider(config, this.env ?? process.env);
  }

  private providerForRemoteTarget(target: RemoteTarget): ImageProvider {
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
    const config = await this.store.readConfig();
    const machineRemoteId = this.machineEngineRemoteId?.();
    if (machineRemoteId && isMachineImageProvider(config, this.env ?? process.env)) {
      const target = resolveRemoteTarget(undefined, this.remotes, machineRemoteId);
      if (target) return this.providerForRemoteTarget(target);
    }
    return this.local.current(
      async () => {
        return createImageProvider({
          home: this.home,
          ...(this.env ? { env: this.env } : {}),
          config,
          ...(this.secrets ? { secrets: this.secrets } : {}),
          localOnly: this.localOnly,
          ...(this.arbiter ? { arbiter: this.arbiter } : {}),
        });
      },
      isMachineImageProvider(config, this.env ?? process.env),
    );
  }

  async reset(): Promise<void> {
    await this.local.reset().catch((err: unknown) => {
      log.warn(
        '[image-provider] shutdown during reset failed:',
        err instanceof Error ? err.message : String(err),
      );
    });
  }

  async retireLocalForMachineBroker(): Promise<void> {
    const config = await this.store.readConfig();
    if (isMachineImageProvider(config, this.env ?? process.env))
      await this.local.retireForMachineBroker();
  }

  async shutdown(): Promise<void> {
    await this.reset();
  }
}

/**
 * Only native sd-cpp work belongs on the shared engine broker. Mock mode is an
 * effective provider override (factory rule #1), so it must stay local just
 * like explicit cloud/mock config instead of being mistaken for default
 * sd-cpp during tests and headless flows.
 */
function isMachineImageProvider(config: GezelConfig, env: NodeJS.ProcessEnv): boolean {
  if (env.GEZEL_MOCK_PROVIDER === '1') return false;
  return (config.imageProvider ?? 'sd-cpp') === 'sd-cpp';
}
