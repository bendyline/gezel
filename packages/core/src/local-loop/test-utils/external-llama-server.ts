/**
 * The daemon's `LlamaCppProvider` in external-base-URL mode, reduced to what a
 * `LlamaCppSession` reads, so the session's tests can live beside it in core.
 *
 * `createSession` passes the same deps and defaults the provider's does (see
 * `LlamaCppProvider.createSession` in the service). What only a supervised
 * engine has is absent, as it is for the provider pointed at an external
 * server: no GPU lease, no supervisor exit correlation, no cache adapter. The
 * engine host is the portable runtime's, which keeps the desktop provider's
 * grammar-floor and forced-tool-choice semantics. Sessions start with no tools;
 * tests that need them replace `deps.bridges`.
 */
import { PortableEngineHost } from '../../runtime/local-loop-host.js';
import {
  DEFAULT_NUM_CTX,
  type DisableThinkingRequestShape,
  LlamaCppSession,
  type LlamaCppSessionDeps,
  type ReasoningEffortRequestShape,
  constrainedToolNoSignalMsForModel,
} from '../llama-cpp-session.js';

export interface ExternalLlamaServerOptions {
  baseUrl: string;
  defaultModel?: string;
  numCtx?: number;
  includeUsageInStream?: boolean;
  replayReasoningContent?: boolean;
  visionEnabled?: boolean;
  disableThinkingRequestShape?: DisableThinkingRequestShape;
  reasoningEffortRequestShape?: ReasoningEffortRequestShape;
  streamingIdleMs?: number;
  preFirstByteIdleMs?: number;
  postReasoningWatchdogMs?: number;
  constrainedToolNoSignalMs?: number;
  fetchImpl?: typeof fetch;
}

export type ExternalLlamaSessionOptions = Partial<
  Pick<
    LlamaCppSessionDeps,
    | 'reasoningEffort'
    | 'systemPromptLayers'
    | 'volatileContext'
    | 'priorMessages'
    | 'externalTools'
    | 'requestCompaction'
    | 'forceDirectFileWork'
    | 'directFileWorkTargetPath'
    | 'profile'
    | 'activeCraftbookStep'
    | 'tuning'
    | 'terminalToolPolicy'
  >
> & {
  systemMessage: string;
  model?: string;
};

const NO_TOOLS: LlamaCppSessionDeps['bridges'] = {
  isEmpty: () => true,
  getOpenAITools: () => [],
  hasTool: () => false,
  callTool: async (name) => {
    throw new Error(`tool "${name}" is not available in this session`);
  },
  stop: async () => {},
};

export class ExternalLlamaServer {
  readonly host = new PortableEngineHost();
  private readonly baseUrl: string;
  private readonly defaultModel: string;
  private readonly numCtx: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: ExternalLlamaServerOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.defaultModel = opts.defaultModel ?? 'llama-cpp';
    this.numCtx = opts.numCtx ?? DEFAULT_NUM_CTX;
    // Read once, as the provider does: a test that swaps `globalThis.fetch`
    // after construction is testing a request the provider would not make.
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** The provider's shutdown stops a supervised engine; an external server has none. */
  async shutdown(): Promise<void> {}

  async createSession(session: ExternalLlamaSessionOptions): Promise<LlamaCppSession> {
    const { opts } = this;
    return new LlamaCppSession({
      resolveBaseUrl: async () => this.baseUrl,
      markUsed: () => {},
      fetchImpl: this.fetchImpl,
      model: session.model ?? this.defaultModel,
      numCtx: this.numCtx,
      includeUsageInStream: opts.includeUsageInStream ?? false,
      replayReasoningContent: opts.replayReasoningContent ?? false,
      visionEnabled: opts.visionEnabled ?? false,
      disableThinkingRequestShape: opts.disableThinkingRequestShape ?? 'chat-template',
      reasoningEffortRequestShape: opts.reasoningEffortRequestShape ?? 'none',
      ...(session.reasoningEffort ? { reasoningEffort: session.reasoningEffort } : {}),
      reasoningBudgetOverride: () => process.env.GEZEL_LLAMA_REASONING_BUDGET_TOKENS,
      systemMessage: session.systemMessage,
      ...(session.systemPromptLayers ? { systemPromptLayers: session.systemPromptLayers } : {}),
      ...(session.volatileContext ? { volatileContext: session.volatileContext } : {}),
      priorMessages: session.priorMessages ?? [],
      bridges: NO_TOOLS,
      queue: this.host.queue,
      provider: this.host,
      streamingIdleMs: opts.streamingIdleMs ?? 300_000,
      preFirstByteIdleMs: opts.preFirstByteIdleMs ?? 600_000,
      postReasoningWatchdogMs: opts.postReasoningWatchdogMs ?? 30_000,
      constrainedToolNoSignalMs:
        opts.constrainedToolNoSignalMs ?? constrainedToolNoSignalMsForModel(this.defaultModel),
      ...(session.externalTools && session.externalTools.length > 0
        ? { externalTools: session.externalTools }
        : {}),
      ...(session.requestCompaction ? { requestCompaction: session.requestCompaction } : {}),
      ...(session.forceDirectFileWork ? { forceDirectFileWork: true } : {}),
      ...(session.directFileWorkTargetPath
        ? { directFileWorkTargetPath: session.directFileWorkTargetPath }
        : {}),
      ...(session.profile ? { profile: session.profile } : {}),
      ...(session.activeCraftbookStep ? { activeCraftbookStep: session.activeCraftbookStep } : {}),
      ...(session.tuning ? { tuning: session.tuning } : {}),
      ...(session.terminalToolPolicy ? { terminalToolPolicy: session.terminalToolPolicy } : {}),
    });
  }
}
