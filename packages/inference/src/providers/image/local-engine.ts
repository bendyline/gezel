import type { GezelConfig } from '@bendyline/gezel';
import type { CatalogService } from '@bendyline/gezel-catalog';
import type { GpuArbiter } from '../gpu-arbiter.js';
import { ProviderLifecycle } from '../provider-lifecycle.js';
import { createLocalImageProvider } from './local-factory.js';
import { ImageModelPullRegistry } from './pull-registry.js';
import type { ImageProvider } from './types.js';

export interface LocalImageEngineOptions {
  home: string;
  catalog: CatalogService;
  arbiter: GpuArbiter;
  readConfig: () => Promise<Pick<GezelConfig, 'defaultImageModel'>>;
  /** Override for tests. */
  env?: NodeJS.ProcessEnv;
  /** Test seam: a provider in place of the local engine. */
  provider?: ImageProvider;
}

/**
 * Hosted inference's image engine: the local sd-server provider, built on
 * first use, plus the pulls that install its models. Reset drains in-flight
 * renders before an engine binary swap takes effect.
 */
export class LocalImageEngine {
  readonly pulls: ImageModelPullRegistry;
  // Only promise-returning operations can be tracked; a pull is an async
  // iterable and is cancelled through its own registry instead.
  private readonly lifecycle = new ProviderLifecycle<ImageProvider>(
    new Set(['generate', 'deleteModel']),
  );

  constructor(private readonly opts: LocalImageEngineOptions) {
    this.pulls = new ImageModelPullRegistry({ imageProvider: this, catalog: opts.catalog });
  }

  /** Whether this host can render at all: an engine binary, a server URL, or the mock. */
  available(): boolean {
    if (this.opts.provider) return true;
    const env = this.opts.env ?? process.env;
    return Boolean(
      env.GEZEL_MOCK_PROVIDER === '1' || env.GEZEL_SD_SERVER_BIN || env.GEZEL_SD_SERVER_URL,
    );
  }

  current(): Promise<ImageProvider> {
    return this.lifecycle.current(async () => {
      if (this.opts.provider) return this.opts.provider;
      const config = await this.opts.readConfig().catch(() => ({}) as Partial<GezelConfig>);
      const defaultModelId = config.defaultImageModel?.['sd-cpp'];
      return createLocalImageProvider({
        home: this.opts.home,
        arbiter: this.opts.arbiter,
        ...(this.opts.env ? { env: this.opts.env } : {}),
        ...(defaultModelId ? { defaultModelId } : {}),
      });
    }, false);
  }

  reset(): Promise<void> {
    return this.lifecycle.reset();
  }

  async shutdown(): Promise<void> {
    this.pulls.clear();
    await this.lifecycle.reset();
  }
}
