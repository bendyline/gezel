/**
 * SpeechToTextProviderManager — owns the active STT provider's
 * lifecycle. Lazy build, dedupe concurrent builds, `reset()` for
 * config changes. Same shape as `ImageProviderManager`.
 */

import { createLogger } from '@bendyline/gezel';
import type { RemotesRegistry } from '../../remotes/registry.js';
import { type RemoteTarget, resolveRemoteTarget } from '../remote/resolve.js';
import { ProviderRetirementGate, trackProviderOperations } from '../retirement-gate.js';
import { RemoteSttProvider } from './remote-stt.js';
import { createSpeechToTextProvider } from './stt-factory.js';
import type { SpeechToTextProvider } from './types.js';

const log = createLogger('audio');

export interface SpeechToTextManagerOptions {
  home: string;
  env?: NodeJS.ProcessEnv;
}

export class SpeechToTextProviderManager {
  private readonly home: string;
  private readonly env: NodeJS.ProcessEnv | undefined;

  private current_: SpeechToTextProvider | null = null;
  private currentView_: SpeechToTextProvider | null = null;
  private retiring_: SpeechToTextProvider | null = null;
  private buildPromise: Promise<SpeechToTextProvider> | null = null;
  private machineRetirement: Promise<void> | null = null;
  private readonly activity = new ProviderRetirementGate();
  private remotes: RemotesRegistry | undefined;
  private machineEngineRemoteId?: () => string | null;
  private readonly remoteCache = new Map<
    string,
    { connectionKey: string; provider: RemoteSttProvider }
  >();

  constructor(opts: SpeechToTextManagerOptions) {
    this.home = opts.home;
    this.env = opts.env;
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
    if (this.current_) return this.currentView_ ?? this.current_;
    if (this.buildPromise) return this.buildPromise;
    this.buildPromise = (async () => {
      const provider = await createSpeechToTextProvider({
        home: this.home,
        ...(this.env ? { env: this.env } : {}),
      });
      this.current_ = provider;
      this.currentView_ = trackProviderOperations(provider, this.activity, new Set(['transcribe']));
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
          '[stt-provider] shutdown during reset failed:',
          err instanceof Error ? err.message : String(err),
        );
      });
    }
  }

  async retireLocalForMachineBroker(): Promise<void> {
    if (this.machineRetirement) return this.machineRetirement;
    const run = (async () => {
      if (!usesMachineSpeechToText(this.env ?? process.env)) return;
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

/** Explicit local/test transports win over machine-broker adoption. */
export function usesMachineSpeechToText(env: NodeJS.ProcessEnv): boolean {
  return env.GEZEL_MOCK_PROVIDER !== '1' && !env.GEZEL_WHISPER_SERVER_URL;
}
