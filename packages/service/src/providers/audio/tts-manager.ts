/**
 * TextToSpeechProviderManager — owns the active TTS provider's
 * lifecycle. Mirrors `SpeechToTextProviderManager` and
 * `ImageProviderManager`.
 */

import { createLogger } from '@bendyline/gezel';
import type { RemotesRegistry } from '../../remotes/registry.js';
import { resolveRemoteTarget } from '../remote/resolve.js';
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
  private buildPromise: Promise<TextToSpeechProvider> | null = null;
  private remotes: RemotesRegistry | undefined;
  private readonly remoteCache = new Map<string, RemoteTtsProvider>();

  constructor(opts: TextToSpeechManagerOptions) {
    this.home = opts.home;
    this.env = opts.env;
  }

  setRemotes(remotes: RemotesRegistry): void {
    this.remotes = remotes;
  }

  /** Route `remote:<id>/…` TTS models to the hosting server; else local. */
  async providerForModel(model?: string): Promise<TextToSpeechProvider> {
    const target = resolveRemoteTarget(model, this.remotes);
    if (!target) return this.current();
    const { remote, fetch } = target;
    let provider = this.remoteCache.get(remote.remoteId);
    if (!provider) {
      provider = new RemoteTtsProvider({
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

  async current(): Promise<TextToSpeechProvider> {
    if (this.current_) return this.current_;
    if (this.buildPromise) return this.buildPromise;
    this.buildPromise = (async () => {
      const provider = await createTextToSpeechProvider({
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
          '[tts-provider] shutdown during reset failed:',
          err instanceof Error ? err.message : String(err),
        );
      });
    }
  }

  async shutdown(): Promise<void> {
    await this.reset();
  }
}
