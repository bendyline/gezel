/**
 * SpeechToTextProviderManager — owns the active STT provider's
 * lifecycle. Lazy build, dedupe concurrent builds, `reset()` for
 * config changes. Same shape as `ImageProviderManager`.
 */

import { createLogger } from '@bendyline/gezel';
import type { RemotesRegistry } from '../../remotes/registry.js';
import { resolveRemoteTarget } from '../remote/resolve.js';
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
  private buildPromise: Promise<SpeechToTextProvider> | null = null;
  private remotes: RemotesRegistry | undefined;
  private readonly remoteCache = new Map<string, RemoteSttProvider>();

  constructor(opts: SpeechToTextManagerOptions) {
    this.home = opts.home;
    this.env = opts.env;
  }

  setRemotes(remotes: RemotesRegistry): void {
    this.remotes = remotes;
  }

  /** Route `remote:<id>/…` STT models to the hosting server; else local. */
  async providerForModel(model?: string): Promise<SpeechToTextProvider> {
    const target = resolveRemoteTarget(model, this.remotes);
    if (!target) return this.current();
    const { remote, fetch } = target;
    let provider = this.remoteCache.get(remote.remoteId);
    if (!provider) {
      provider = new RemoteSttProvider({
        remoteId: remote.remoteId,
        label: remote.displayName,
        baseUrl: remote.baseUrl,
        token: remote.token,
        fetch,
      });
      this.remoteCache.set(remote.remoteId, provider);
    }
    return provider;
  }

  async current(): Promise<SpeechToTextProvider> {
    if (this.current_) return this.current_;
    if (this.buildPromise) return this.buildPromise;
    this.buildPromise = (async () => {
      const provider = await createSpeechToTextProvider({
        home: this.home,
        ...(this.env ? { env: this.env } : {}),
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
          '[stt-provider] shutdown during reset failed:',
          err instanceof Error ? err.message : String(err),
        );
      });
    }
  }

  async shutdown(): Promise<void> {
    await this.reset();
  }
}
