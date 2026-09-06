/**
 * SpeechToTextProviderManager — owns the active STT provider's
 * lifecycle. Lazy build, dedupe concurrent builds, `reset()` for
 * config changes. Same shape as `ImageProviderManager`.
 */

import { createLogger } from '@bendyline/gezel';
import type { ConfigStore } from '../../fs/config-store.js';
import type { RemotesRegistry } from '../../remotes/registry.js';
import { ProviderLifecycle } from '../provider-lifecycle.js';
import { type RemoteTarget, resolveRemoteTarget } from '../remote/resolve.js';
import { RemoteSttProvider } from './remote-stt.js';
import { createSpeechToTextProvider } from './stt-factory.js';
import type { SpeechToTextProvider } from './types.js';

const log = createLogger('audio');

export interface SpeechToTextManagerOptions {
  home: string;
  env?: NodeJS.ProcessEnv;
  /**
   * Read on every build so the engine launches with the user's configured
   * `defaultSttModel`. Optional: tests and the machine-engine broker build a
   * manager with no store and get the first-installed fallback.
   */
  store?: Pick<ConfigStore, 'readConfig'>;
}

export class SpeechToTextProviderManager {
  private readonly home: string;
  private readonly env: NodeJS.ProcessEnv | undefined;
  private readonly store: Pick<ConfigStore, 'readConfig'> | undefined;

  private readonly local = new ProviderLifecycle<SpeechToTextProvider>(new Set(['transcribe']));
  private remotes: RemotesRegistry | undefined;
  private machineEngineRemoteId?: () => string | null;
  private readonly remoteCache = new Map<
    string,
    { connectionKey: string; provider: RemoteSttProvider }
  >();

  constructor(opts: SpeechToTextManagerOptions) {
    this.home = opts.home;
    this.env = opts.env;
    this.store = opts.store;
  }

  setRemotes(remotes: RemotesRegistry): void {
    this.remotes = remotes;
  }

  setMachineEngineRemoteResolver(resolve: (() => string | null) | undefined): void {
    this.machineEngineRemoteId = resolve;
  }

  /** Route `remote:<id>/…` STT models to the hosting server; else local. */
  async providerForModel(model?: string): Promise<SpeechToTextProvider> {
    const target = resolveRemoteTarget(model, this.remotes);
    if (!target) return this.current();
    return this.providerForRemoteTarget(target);
  }

  private providerForRemoteTarget(target: RemoteTarget): SpeechToTextProvider {
    const { remote, fetch } = target;
    const connectionKey = `${remote.baseUrl}\0${remote.token}\0${remote.pinnedIdentityFingerprint}`;
    let cached = this.remoteCache.get(remote.remoteId);
    if (!cached || cached.connectionKey !== connectionKey) {
      cached = {
        connectionKey,
        provider: new RemoteSttProvider({
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

  async current(): Promise<SpeechToTextProvider> {
    const machineRemoteId = this.machineEngineRemoteId?.();
    if (machineRemoteId && usesMachineSpeechToText(this.env ?? process.env)) {
      const target = resolveRemoteTarget(undefined, this.remotes, machineRemoteId);
      if (target) return this.providerForRemoteTarget(target);
    }
    return this.local.current(async () => {
      const defaultModelId = this.store
        ? (await this.store.readConfig()).defaultSttModel
        : undefined;
      return createSpeechToTextProvider({
        home: this.home,
        ...(this.env ? { env: this.env } : {}),
        ...(defaultModelId ? { defaultModelId } : {}),
      });
    });
  }

  async reset(): Promise<void> {
    await this.local.reset().catch((err: unknown) => {
      log.warn(
        '[stt-provider] shutdown during reset failed:',
        err instanceof Error ? err.message : String(err),
      );
    });
  }

  async retireLocalForMachineBroker(): Promise<void> {
    if (usesMachineSpeechToText(this.env ?? process.env)) await this.local.retireForMachineBroker();
  }

  async shutdown(): Promise<void> {
    await this.reset();
  }
}

/** Explicit local/test transports win over machine-broker adoption. */
export function usesMachineSpeechToText(env: NodeJS.ProcessEnv): boolean {
  return env.GEZEL_MOCK_PROVIDER !== '1' && !env.GEZEL_WHISPER_SERVER_URL;
}
