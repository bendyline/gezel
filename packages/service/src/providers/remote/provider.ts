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
import {
  PROTOCOL_VERSION,
  RemoteAdmissionResponseSchema,
  RemoteModelsResponseSchema,
} from './wire.js';

/**
 * Generous per-turn ceiling for remote inference — an 80B on a paired server
 * is legitimately slow (cold load + prefill), so remote turns get the
 * local-engine-class timeout, not the tight cloud one.
 */
export const REMOTE_TURN_TIMEOUT_MS = 20 * 60 * 1000;

/**
 * Mixed-version safety floor. Brokers predating `/v1/remote/admit` cannot
 * reveal their live capacity clamp, so A deliberately assumes a small window
 * and applies the coordinator/tool diet. This may under-use an old broker,
 * but it cannot recreate the first-turn OOM class during rolling upgrades.
 */
export const LEGACY_REMOTE_CONTEXT_WINDOW = 8_192;

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
  /** Resolve rotated runtime-managed broker connection details on demand. */
  resolveConnection?: () => { baseUrl: string; token: string; fetch: typeof fetch };
  /**
   * Engine namespace to add to ordinary model ids. The automatic machine
   * broker uses this because the user-facing session remains `llama-cpp`,
   * `mlx`, or `ds4` while B's inference wire requires `<provider>:<model>`.
   */
  modelPrefix?: string;
  /** B-native model selected when the provider was constructed. */
  defaultModel?: string;
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
  readonly supportsPriorMessages = true;
  private readonly log = createLogger('remote-provider');
  private cachedModels: ModelInfo[] | null = null;
  private readonly admittedContextWindows = new Map<string, number>();
  private lastAdmittedContextWindow: number | undefined;

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
    return this.opts.models?.[0]?.id ?? this.opts.defaultModel;
  }

  getContextWindow(): number | undefined {
    return this.lastAdmittedContextWindow;
  }

  /** Resolve A's model spelling to the B-native `<provider>:<model>` id. */
  private brokerModel(model?: string): string {
    const requested = model ?? this.opts.defaultModel ?? this.getEffectiveModelId() ?? '';
    const remoteLocal = parseRemoteModelId(requested)?.modelId ?? requested;
    return this.opts.modelPrefix &&
      remoteLocal &&
      !remoteLocal.startsWith(`${this.opts.modelPrefix}:`)
      ? `${this.opts.modelPrefix}:${remoteLocal}`
      : remoteLocal;
  }

  async prepareContextWindow(model?: string): Promise<number | undefined> {
    const bLocal = this.brokerModel(model);
    if (!bLocal) return undefined;
    const connection = this.opts.resolveConnection?.() ?? this.opts;
    // A broker restart rotates URL/token and may admit a different window
    // under the machine's new live pressure. Never carry the prior process's
    // clamp across that identity boundary.
    const admissionKey = `${connection.baseUrl}\0${connection.token}\0${bLocal}`;
    const cached = this.admittedContextWindows.get(admissionKey);
    if (cached !== undefined) {
      this.lastAdmittedContextWindow = cached;
      return cached;
    }

    const res = await connection.fetch(`${connection.baseUrl}/v1/remote/admit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${connection.token}`,
      },
      body: JSON.stringify({ protocolVersion: PROTOCOL_VERSION, model: bLocal }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      let code: string | undefined;
      try {
        code = (JSON.parse(detail) as { error?: string }).error;
      } catch {
        /* old brokers commonly return a plain 404 body */
      }
      if (res.status === 404 && code !== 'model_not_loaded') {
        this.log.warn(
          `[remote-provider] ${this.opts.label} predates context admission; using conservative ${LEGACY_REMOTE_CONTEXT_WINDOW}-token window for ${bLocal}`,
        );
        this.admittedContextWindows.set(admissionKey, LEGACY_REMOTE_CONTEXT_WINDOW);
        this.lastAdmittedContextWindow = LEGACY_REMOTE_CONTEXT_WINDOW;
        return LEGACY_REMOTE_CONTEXT_WINDOW;
      }
      throw new Error(
        `[remote] /v1/remote/admit returned HTTP ${res.status}${detail ? ` ${detail}` : ''}`,
      );
    }
    const admitted = RemoteAdmissionResponseSchema.parse(await res.json()).contextWindow;
    this.admittedContextWindows.set(admissionKey, admitted);
    this.lastAdmittedContextWindow = admitted;
    return admitted;
  }

  async listModels(): Promise<ModelInfo[]> {
    if (this.opts.models) return this.opts.models;
    if (this.cachedModels) return this.cachedModels;
    try {
      const connection = this.opts.resolveConnection?.() ?? this.opts;
      const res = await connection.fetch(`${connection.baseUrl}/v1/remote/models`, {
        headers: { Authorization: `Bearer ${connection.token}` },
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
    const numCtx = (await this.prepareContextWindow(opts.model)) ?? LEGACY_REMOTE_CONTEXT_WINDOW;
    const bridges = await McpBridgePool.fromSessionOpts(opts, `[remote:${this.opts.label}]`);
    const bLocal = this.brokerModel(opts.model);
    this.log.info(`[remote-provider] session on ${this.opts.label} model=${bLocal}`);
    return new RemoteSession({
      baseUrl: this.opts.baseUrl,
      token: this.opts.token,
      fetch: this.opts.fetch,
      ...(this.opts.resolveConnection ? { resolveConnection: this.opts.resolveConnection } : {}),
      queue: this.queue,
      bridges,
      systemMessage: opts.systemMessage,
      model: bLocal,
      ...(opts.systemPromptLayers ? { systemPromptLayers: opts.systemPromptLayers } : {}),
      ...(opts.volatileContext ? { volatileContext: opts.volatileContext } : {}),
      ...(opts.reasoningEffort ? { reasoningEffort: opts.reasoningEffort } : {}),
      ...(opts.tuning ? { tuning: opts.tuning as unknown as Record<string, unknown> } : {}),
      priorMessages: opts.priorMessages ?? [],
      numCtx,
      ...(opts.requestCompaction ? { requestCompaction: opts.requestCompaction } : {}),
      timeoutMs: REMOTE_TURN_TIMEOUT_MS,
    });
  }
}
