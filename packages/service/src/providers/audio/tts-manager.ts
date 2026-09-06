/**
 * TextToSpeechProviderManager — owns the active TTS provider's
 * lifecycle. Mirrors `SpeechToTextProviderManager` and
 * `ImageProviderManager`.
 */

import { createLogger } from '@bendyline/gezel';
import type { RemotesRegistry } from '../../remotes/registry.js';
import { ProviderLifecycle } from '../provider-lifecycle.js';
import { type RemoteTarget, resolveRemoteTarget } from '../remote/resolve.js';
import { RemoteTtsProvider } from './remote-tts.js';
import { createTextToSpeechProvider } from './tts-factory.js';
import type { TextToSpeechProvider } from './types.js';

const log = createLogger('audio');

export interface TextToSpeechManagerOptions {
  home: string;
  env?: NodeJS.ProcessEnv;
}

export class TextToSpeechProviderManager {
  private readonly home: string;
  private readonly env: NodeJS.ProcessEnv | undefined;

  private readonly local = new ProviderLifecycle<TextToSpeechProvider>(new Set(['synthesize']));
  private remotes: RemotesRegistry | undefined;
  private machineEngineRemoteId?: () => string | null;
  private readonly remoteCache = new Map<
    string,
    { connectionKey: string; provider: RemoteTtsProvider }
  >();

  constructor(opts: TextToSpeechManagerOptions) {
    this.home = opts.home;
    this.env = opts.env;
  }

  setRemotes(remotes: RemotesRegistry): void {
    this.remotes = remotes;
  }

  setMachineEngineRemoteResolver(resolve: (() => string | null) | undefined): void {
    this.machineEngineRemoteId = resolve;
  }

  /** Route `remote:<id>/…` TTS models to the hosting server; else local. */
  async providerForModel(model?: string): Promise<TextToSpeechProvider> {
    const target = resolveRemoteTarget(model, this.remotes);
    if (!target) return this.current();
    return this.providerForRemoteTarget(target);
  }

  private providerForRemoteTarget(target: RemoteTarget): TextToSpeechProvider {
    const { remote, fetch } = target;
    const connectionKey = `${remote.baseUrl}\0${remote.token}\0${remote.pinnedIdentityFingerprint}`;
    let cached = this.remoteCache.get(remote.remoteId);
    if (!cached || cached.connectionKey !== connectionKey) {
      cached = {
        connectionKey,
        provider: new RemoteTtsProvider({
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

  async current(): Promise<TextToSpeechProvider> {
    const machineRemoteId = this.machineEngineRemoteId?.();
    if (machineRemoteId && usesMachineTextToSpeech(this.env ?? process.env)) {
      const target = resolveRemoteTarget(undefined, this.remotes, machineRemoteId);
      if (target) return this.providerForRemoteTarget(target);
    }
    return this.local.current(async () => {
      return createTextToSpeechProvider({
        home: this.home,
        ...(this.env ? { env: this.env } : {}),
      });
    });
  }

  async reset(): Promise<void> {
    await this.local.reset().catch((err: unknown) => {
      log.warn(
        '[tts-provider] shutdown during reset failed:',
        err instanceof Error ? err.message : String(err),
      );
    });
  }

  async retireLocalForMachineBroker(): Promise<void> {
    if (usesMachineTextToSpeech(this.env ?? process.env)) await this.local.retireForMachineBroker();
  }

  async shutdown(): Promise<void> {
    await this.reset();
  }
}

/** Mock mode is an effective provider override and must stay user-local. */
export function usesMachineTextToSpeech(env: NodeJS.ProcessEnv): boolean {
  return env.GEZEL_MOCK_PROVIDER !== '1';
}
