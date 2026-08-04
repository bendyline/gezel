import type { LlamaCppProvider } from '../llama-cpp/index.js';
import type { LlamaCppLogFile } from '../llama-cpp/log.js';
import type { LLMProvider, LLMSession, ModelInfo, SessionOpts } from '../types.js';
import type { Ds4CacheAdapter } from './cache-adapter.js';

/**
 * ds4 (DwarfStar) provider — antirez's DeepSeek-V4-specific inference
 * engine. `ds4-server` speaks the *identical* OpenAI-compatible
 * `/v1/chat/completions` SSE dialect as `llama-server`, and ds4 models
 * are GGUF, so rather than duplicate the ~4000-line llama.cpp turn loop
 * (request shaping, SSE pump, tool-call accumulation, reasoning-channel
 * parsing, idle watchdogs, queue) we COMPOSE: a {@link Ds4Provider}
 * wraps an inner {@link LlamaCppProvider} configured to drive a ds4
 * supervisor (or external URL), and only relabels its identity to
 * `'ds4'` so engine-key routing, the pool, and the capacity broker see
 * a first-class engine.
 *
 * What ds4 does NOT share with llama-server is process management: the
 * launch args (`--metal`, `--ssd-streaming`, `--ssd-streaming-cache-experts`,
 * `--kv-disk-dir`) and readiness probe (`GET /v1/models` — ds4 has no
 * `/health`) live in `buildDs4Provider` (chat/manager.ts), which hands
 * this class a ready-built `LlamaCppProvider`.
 *
 * The inner session emits llama.cpp-tagged telemetry; ChatManager relabels
 * those events from the owning session's `providerName` before publishing,
 * so the global engine pill and queue surfaces correctly identify DS4 without
 * forking the mature llama.cpp turn loop. Routing/eviction key directly off
 * this class's `name`.
 */
export class Ds4Provider implements LLMProvider {
  readonly name = 'ds4' as const;
  /** Inner llama.cpp-compatible engine driving the ds4-server process. */
  private readonly inner: LlamaCppProvider;
  /**
   * The ds4 cache adapter — held HERE, never forwarded to the inner
   * llama provider. The inner send path calls llama-specific adapter
   * methods (slot allocation, prepareForSend); the ds4 adapter is a
   * different shape (warm-only, no slots) and is reached exclusively
   * through `getCacheAdapter()` by `prewarmSession` and the controller.
   */
  private cacheAdapter: Ds4CacheAdapter | null = null;

  constructor(opts: { inner: LlamaCppProvider }) {
    this.inner = opts.inner;
  }

  setCacheAdapter(adapter: Ds4CacheAdapter): void {
    this.cacheAdapter = adapter;
  }

  getCacheAdapter(): Ds4CacheAdapter | null {
    return this.cacheAdapter;
  }

  /** The wrapped engine — exposed so the cache adapter / freeze hook in
   * `buildDs4Provider` can reach the same instance this provider drives. */
  get llamaCpp(): LlamaCppProvider {
    return this.inner;
  }

  initialize(): Promise<void> {
    return this.inner.initialize();
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }

  createSession(opts: SessionOpts): Promise<LLMSession> {
    return this.inner.createSession(opts);
  }

  listModels(): Promise<ModelInfo[]> {
    return this.inner.listModels();
  }

  getEffectiveModelId(): string | undefined {
    return this.inner.getEffectiveModelId();
  }

  getContextWindow(): number | undefined {
    return this.inner.getContextWindow();
  }

  /** Persistent ds4-server stdout/stderr, exposed to diagnostics/routes. */
  getLogFile(): LlamaCppLogFile | undefined {
    return this.inner.getLogFile();
  }

  get queue(): LLMProvider['queue'] {
    return this.inner.queue;
  }

  get batch(): LLMProvider['batch'] {
    return this.inner.batch;
  }

  get supportsExternalTools(): LLMProvider['supportsExternalTools'] {
    return this.inner.supportsExternalTools;
  }

  get supportsPriorMessages(): LLMProvider['supportsPriorMessages'] {
    return this.inner.supportsPriorMessages;
  }
}
