/**
 * RemoteGezelProvider — Device A's `LLMProvider` for models hosted on ONE
 * paired server (Device B). Structurally mirrors the cloud providers: the
 * agentic turn loop + tools stay local (a per-session `McpBridgePool` built on
 * A), and only the model forward-pass is remoted. One instance per paired
 * server; ChatManager keys them by `remoteId` parsed from the model ref.
 */

import { createLogger } from '@bendyline/gezel';
import { McpBridgePool } from '../mcp-bridge-pool.js';
import { ProviderQueue } from '../queue.js';
import type { LLMProvider, LLMSession, ModelInfo, SessionOpts } from '../types.js';
import { makeRemoteModelId, parseRemoteModelId } from './model-id.js';
import { RemoteSession } from './session.js';
import { RemoteModelsResponseSchema } from './wire.js';

/**
 * Generous per-turn ceiling for remote inference — an 80B on a paired server
 * is legitimately slow (cold load + prefill), so remote turns get the
 * local-engine-class timeout, not the tight cloud one.
 */
export const REMOTE_TURN_TIMEOUT_MS = 20 * 60 * 1000;

export interface RemoteGezelProviderOpts {
  /** Stable id of the paired server this provider talks to. */
  remoteId: string;
  /** Display label for logs/UI. */
  label: string;
  baseUrl: string;
  /** B-issued bearer token (scope `remote-inference`). */
  token: string;
  /** Cert-pinned fetch to B (see remotes/pinned-fetch.ts). */
  fetch: typeof fetch;
  /** B's models captured at pairing/discovery, already namespaced for A. */
  models?: ModelInfo[];
  /** A-side admission cap on concurrent sockets to B. */
  concurrency?: number;
}

export class RemoteGezelProvider implements LLMProvider {
  readonly name = 'remote' as const;
  readonly queue: ProviderQueue;
  /** A's RemoteSession runs its OWN local tool loop, so this provider is not
   *  in capture-and-return mode from the caller's perspective. */
  readonly supportsExternalTools = false;
  private readonly log = createLogger('remote-provider');
  private cachedModels: ModelInfo[] | null = null;

  constructor(private readonly opts: RemoteGezelProviderOpts) {
    this.queue = new ProviderQueue({ concurrency: opts.concurrency ?? 8 });
  }

  async initialize(): Promise<void> {
    /* nothing to boot — the pinned fetch is ready at construction */
  }

  async shutdown(): Promise<void> {
    /* no owned remote resources */
  }

  getEffectiveModelId(): string | undefined {
    return this.opts.models?.[0]?.id;
  }

  async listModels(): Promise<ModelInfo[]> {
    if (this.opts.models) return this.opts.models;
    if (this.cachedModels) return this.cachedModels;
    try {
      const res = await this.opts.fetch(`${this.opts.baseUrl}/v1/remote/models`, {
        headers: { Authorization: `Bearer ${this.opts.token}` },
      });
      if (!res.ok) return [];
      const parsed = RemoteModelsResponseSchema.parse(await res.json());
      // Surface only chat models here (multimodal flows through the remote
      // image/video/audio providers). Re-namespace each B id for A.
      this.cachedModels = parsed.models
        .filter((m) => m.modality === 'chat')
        .map((m) => ({
          id: makeRemoteModelId(this.opts.remoteId, m.id),
          name: m.name,
          ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
          ...(m.supportsTools !== undefined ? { supportsTools: m.supportsTools } : {}),
          ...(m.supportsReasoning !== undefined ? { supportsReasoning: m.supportsReasoning } : {}),
          ...(m.parameterSize ? { parameterSize: m.parameterSize } : {}),
        }));
      return this.cachedModels;
    } catch (err) {
      this.log.warn(`[remote-provider] listModels(${this.opts.label}) failed: ${String(err)}`);
      return [];
    }
  }

  async createSession(opts: SessionOpts): Promise<LLMSession> {
    const bridges = await McpBridgePool.fromSessionOpts(opts, `[remote:${this.opts.label}]`);
    const requested = opts.model ?? this.getEffectiveModelId() ?? '';
    const bLocal = parseRemoteModelId(requested)?.modelId ?? requested;
    this.log.info(`[remote-provider] session on ${this.opts.label} model=${bLocal}`);
    return new RemoteSession({
      baseUrl: this.opts.baseUrl,
      token: this.opts.token,
      fetch: this.opts.fetch,
      queue: this.queue,
      bridges,
      systemMessage: opts.systemMessage,
      model: bLocal,
      ...(opts.systemPromptLayers ? { systemPromptLayers: opts.systemPromptLayers } : {}),
      ...(opts.volatileContext ? { volatileContext: opts.volatileContext } : {}),
      ...(opts.reasoningEffort ? { reasoningEffort: opts.reasoningEffort } : {}),
      ...(opts.tuning ? { tuning: opts.tuning as unknown as Record<string, unknown> } : {}),
      priorMessages: opts.priorMessages ?? [],
      timeoutMs: REMOTE_TURN_TIMEOUT_MS,
    });
  }
}
