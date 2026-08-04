/**
 * TextToSpeechProviderManager — owns the active TTS provider's
 * lifecycle. Mirrors `SpeechToTextProviderManager` and
 * `ImageProviderManager`.
 */

import { createLogger } from '@bendyline/gezel';
import type { RemotesRegistry } from '../../remotes/registry.js';
import { resolveRemoteTarget } from '../remote/resolve.js';
import { ProviderRetirementGate, trackProviderOperations } from '../retirement-gate.js';
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

  private current_: TextToSpeechProvider | null = null;
  private currentView_: TextToSpeechProvider | null = null;
  private retiring_: TextToSpeechProvider | null = null;
  private buildPromise: Promise<TextToSpeechProvider> | null = null;
  private machineRetirement: Promise<void> | null = null;
  private readonly activity = new ProviderRetirementGate();
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
    const target = resolveRemoteTarget(model, this.remotes, this.machineEngineRemoteId?.());
    if (!target) return this.current();
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
    if (this.machineEngineRemoteId?.()) return this.providerForModel(undefined);
    if (this.current_) return this.currentView_ ?? this.current_;
    if (this.buildPromise) return this.buildPromise;
    this.buildPromise = (async () => {
      const provider = await createTextToSpeechProvider({
        home: this.home,
        ...(this.env ? { env: this.env } : {}),
      });
      this.current_ = provider;
      this.currentView_ = trackProviderOperations(provider, this.activity, new Set(['synthesize']));
      return this.currentView_;
    })().finally(() => {
      this.buildPromise = null;
    });
    return this.buildPromise;
  }

  async reset(): Promise<void> {
    const prev = this.current_;
    this.current_ = null;
    this.currentView_ = null;
    if (prev?.shutdown) {
      await prev.shutdown().catch((err: unknown) => {
        log.warn(
          '[tts-provider] shutdown during reset failed:',
          err instanceof Error ? err.message : String(err),
        );
      });
    }
  }

  async retireLocalForMachineBroker(): Promise<void> {
    if (this.machineRetirement) return this.machineRetirement;
    const run = (async () => {
      this.activity.beginRetirement();
      await this.buildPromise;
      this.retiring_ ??= this.current_;
      this.current_ = null;
      this.currentView_ = null;
      await this.activity.waitForIdle();
      if (this.retiring_?.shutdown) await this.retiring_.shutdown();
      this.retiring_ = null;
    })();
    this.machineRetirement = run;
    try {
      await run;
    } catch (error) {
      if (this.machineRetirement === run) this.machineRetirement = null;
      throw error;
    }
  }

  async shutdown(): Promise<void> {
    await this.reset();
  }
}
