import { isEngagementAllowed } from '../engagement.js';
import type { SystemPromptLayers } from '../local-loop/engine-host.js';
import {
  LlamaCppSession,
  constrainedToolNoSignalMsForModel,
} from '../local-loop/llama-cpp-session.js';
import type { TerminalToolPolicy } from '../local-loop/provider-contract.js';
import {
  buildToolEvidenceReplay,
  toolEvidenceBudgetChars,
} from '../local-loop/tool-evidence-replay.js';
import { UnresolvedToolFailureLedger } from '../local-loop/unresolved-tool-failure-ledger.js';
import type { PortableInference } from '../mobile/inference.js';
import type { ResolvedModelProfile } from '../model-profile/types.js';
import { spliceIntoText } from '../recognition/digest.js';
import type { ChatMessage, ChatMessageToolCall } from '../schemas/gezel.js';
import type { MobileEnginePhaseEvent } from '../schemas/mobile-provider.js';
import type { ChatSession } from '../schemas/session.js';
import { GEZEL_TOOL_DESCRIPTIONS } from '../tools/gezel-tool-descriptions.js';
import { stripReasoningTags } from '../transform/reasoning.js';
import { turnCancelledMessage } from '../turn-cancel.js';
import {
  LOCAL_TURN_TIMEOUT_MS,
  NATIVE_ENGINE_BASE_URL,
  type PortableEngineHost,
  PortableToolExecutor,
  nativeChatFetch,
} from './local-loop-host.js';
import { type PortableToolActions, PortableToolArgumentError } from './product-tools.js';
import type { PortableStore } from './store.js';
import type { PortableToolSpec, StructuredChatSettings } from './tool-loop.js';
import { recordPortableToolCall } from './tool-loop.js';

/** The desktop's llama.cpp watchdogs; phones get the slow-host prefill allowance. */
const STREAMING_IDLE_MS = 300_000;
const PRE_FIRST_BYTE_IDLE_MS = 1_500_000;
const POST_REASONING_WATCHDOG_MS = 30_000;

export interface SharedLoopTurnOptions {
  store: PortableStore;
  inference: PortableInference;
  host: PortableEngineHost;
  session: ChatSession;
  requestId: string;
  modelId: string;
  /** The model's catalog id, which keys per-model loop limits as on the desktop. */
  catalogId?: string;
  contextSize: number;
  structuredChat: StructuredChatSettings;
  /** The model's resolved behaviors, as the desktop resolves them. */
  profile?: ResolvedModelProfile;
  /** Whether this gezel is the Meester, which some tool wrappers branch on. */
  isMeester: boolean;
  systemMessage: string;
  /** The desktop builder's volatile band, sent as a second system message as there. */
  volatileContext?: string;
  systemPromptLayers?: SystemPromptLayers;
  /** The conversation before this turn, as stored. */
  history: readonly ChatMessage[];
  prompt: string;
  /** Tools whose success ends the turn, as the desktop sets them (a game's move). */
  terminalToolPolicy?: TerminalToolPolicy;
  /** The turn's first request must call this tool (a reaction's `turn`). */
  requiredTool?: string;
  tools: readonly PortableToolSpec[];
  actions: PortableToolActions;
  signal: AbortSignal;
  cancelled(): boolean;
  checkpoint(message: ChatMessage): Promise<void>;
  tool(call: ChatMessageToolCall): void;
  delta(text: string): void;
  phase?(
    phase: MobileEnginePhaseEvent['phase'],
    detail?: Omit<MobileEnginePhaseEvent, 'requestId' | 'phase'>,
  ): void;
}

export interface SharedLoopTurnResult {
  text: string;
  stopReason: 'stop' | 'length' | 'cancelled';
  message?: ChatMessage;
  streamed: boolean;
  reasoning?: string;
  reasoningDurationMs?: number;
  warnings?: string[];
}

const ENGINE_PHASES = new Set<MobileEnginePhaseEvent['phase']>([
  'loading_model',
  'prefill',
  'generating',
]);

/**
 * One phone turn through the desktop's own llama.cpp loop. The session is
 * rebuilt from the stored conversation each turn, replaying tool evidence the
 * way the desktop reseeds a stateless session, so the phone's store stays the
 * only source of truth.
 */
export async function runSharedLoopTurn(
  options: SharedLoopTurnOptions,
): Promise<SharedLoopTurnResult> {
  const { session } = options;
  let message: ChatMessage | undefined;
  const check = async () => {
    if (options.cancelled()) throw new Error('Response stopped');
    if (!isEngagementAllowed(await options.store.readConfig()))
      throw new Error('AI engagement is off');
  };
  const executor = new PortableToolExecutor({
    tools: options.tools.map((tool) => ({
      type: 'function' as const,
      name: tool.name,
      // The desktop's words for the tool; the phone's shorter listing is for
      // the text and system-model paths with 4K windows.
      description:
        (GEZEL_TOOL_DESCRIPTIONS as Record<string, string>)[tool.name] ?? tool.description,
      parameters: tool.parameters as Record<string, unknown>,
    })),
    ...(options.profile ? { profile: options.profile } : {}),
    modelTier: options.profile?.tier ?? 'tiny',
    isMeester: options.isMeester,
    ledger: new UnresolvedToolFailureLedger({
      hasTool: (name) => options.tools.some((tool) => tool.name === name),
    }),
    run: async (name, args) => {
      const { call, serialized, error } = await recordPortableToolCall(
        {
          store: options.store,
          session,
          providerId: 'llama-cpp',
          actions: options.actions,
          desktopResultText: true,
          contextWindow: options.contextSize,
          check,
          checkpoint: options.checkpoint,
          message: () => {
            message ??= {
              id: crypto.randomUUID(),
              role: 'assistant',
              content: '',
              at: new Date().toISOString(),
              status: 'streaming',
              providerId: 'llama-cpp',
              toolCalls: [],
            };
            return message;
          },
        },
        name,
        args,
      );
      options.tool(call);
      if (call.success) return { text: serialized, isError: false };
      return {
        text: call.errorMessage ?? 'The tool failed',
        isError: true,
        ...(error instanceof PortableToolArgumentError ? { validationIssues: error.issues } : {}),
      };
    },
  });
  const replay = buildToolEvidenceReplay(
    options.history
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({
        role: m.role as 'user' | 'assistant',
        ...(m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0
          ? { toolCalls: m.toolCalls }
          : {}),
        content:
          m.role === 'assistant'
            ? stripReasoningTags(m.content)
            : spliceIntoText(m.content, m.recognizedImages),
      })),
    toolEvidenceBudgetChars(options.contextSize),
  );
  const phase = options.phase;
  const llama = new LlamaCppSession({
    resolveBaseUrl: async () => NATIVE_ENGINE_BASE_URL,
    markUsed: () => {},
    fetchImpl: nativeChatFetch({
      inference: options.inference,
      modelId: options.modelId,
      contextSize: options.contextSize,
      ...(options.structuredChat.config ? { chatConfig: options.structuredChat.config } : {}),
      requestId: () => options.requestId,
      ...(phase
        ? {
            onPhase: ({ requestId: _requestId, phase: engine, ...detail }) => phase(engine, detail),
          }
        : {}),
    }),
    model: options.modelId,
    numCtx: options.contextSize,
    disableThinkingRequestShape: 'chat-template',
    reasoningEffortRequestShape: 'none',
    systemMessage: options.systemMessage,
    ...(options.volatileContext ? { volatileContext: options.volatileContext } : {}),
    ...(options.systemPromptLayers ? { systemPromptLayers: options.systemPromptLayers } : {}),
    priorMessages: replay.entries,
    bridges: executor,
    ...(options.terminalToolPolicy ? { terminalToolPolicy: options.terminalToolPolicy } : {}),
    queue: options.host.queue,
    provider: options.host,
    streamingIdleMs: STREAMING_IDLE_MS,
    preFirstByteIdleMs: PRE_FIRST_BYTE_IDLE_MS,
    postReasoningWatchdogMs: POST_REASONING_WATCHDOG_MS,
    constrainedToolNoSignalMs: constrainedToolNoSignalMsForModel(
      options.catalogId ?? options.modelId,
    ),
    ...(options.structuredChat.tuning ? { tuning: options.structuredChat.tuning } : {}),
    ...(options.profile ? { profile: options.profile } : {}),
  });
  let streamed = false;
  const warnings: string[] = [];
  let reasoningStartedAt = 0;
  let reasoningEndedAt = 0;
  const unsubscribe = [
    llama.onReasoningDelta(() => {
      reasoningEndedAt = Date.now();
      reasoningStartedAt ||= reasoningEndedAt;
    }),
    llama.onDelta((chunk) => {
      streamed = true;
      options.delta(chunk);
    }),
    llama.onWarning((warning) => warnings.push(warning)),
    llama.onEnginePhase((event) => {
      const engine = event.phase as MobileEnginePhaseEvent['phase'];
      if (!phase || !ENGINE_PHASES.has(engine)) return;
      phase(engine, {
        ...(event.progress !== undefined ? { progress: event.progress } : {}),
        ...(event.outputTokens !== undefined ? { outputTokens: event.outputTokens } : {}),
        ...(event.tokensPerSec !== undefined ? { tokensPerSec: event.tokensPerSec } : {}),
      });
    }),
  ];
  const finish = (text: string, stopReason: SharedLoopTurnResult['stopReason']) => {
    const reasoning = llama.getLastTurnReasoning();
    return {
      text,
      stopReason,
      ...(message ? { message } : {}),
      streamed,
      ...(reasoning ? { reasoning } : {}),
      ...(reasoning && reasoningStartedAt
        ? { reasoningDurationMs: reasoningEndedAt - reasoningStartedAt }
        : {}),
      ...(warnings.length ? { warnings } : {}),
    };
  };
  try {
    const text = await llama.sendAndWait(options.prompt, {
      timeoutMs: LOCAL_TURN_TIMEOUT_MS,
      ...(options.requiredTool ? { requiredTool: options.requiredTool } : {}),
      queue: {
        lane: 'interactive',
        sessionId: session.id,
        signal: options.signal,
        bypassQueue: true,
      },
    });
    return finish(text, 'stop');
  } catch (error) {
    if (options.cancelled() || (error instanceof Error && error.message === turnCancelledMessage()))
      return finish('', 'cancelled');
    // The loop names llama-server's address when a request cannot start; on a
    // phone that is the in-app engine refusing (too warm, low on memory), whose
    // own sentence is the one to show.
    const refused =
      error instanceof Error
        ? error.message.match(/unreachable at gezel-native:\/\/llama-cpp: ([\s\S]+)$/)
        : null;
    if (refused?.[1]) throw new Error(refused[1], { cause: error });
    throw error;
  } finally {
    for (const off of unsubscribe) off();
    await llama.disconnect().catch(() => {});
  }
}
