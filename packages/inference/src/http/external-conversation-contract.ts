import type { ProviderName } from '@bendyline/gezel';
export interface ExternalTranscriptToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ExternalTranscriptMessage {
  role: 'system' | 'developer' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: ExternalTranscriptToolCall[];
  toolCallId?: string;
}

export interface BeginExternalConversationInput {
  sourceId: string;
  sourceName: string;
  externalConversationId: string;
  workingDirectory?: string;
  projectHint?: string;
  gezelId: string;
  providerName: ProviderName;
  model?: string;
  messages: ExternalTranscriptMessage[];
  /** Effective prompt and tool roster that were actually supplied this request. */
  effectiveSystemMessage: string;
  toolNames: string[];
  /** Receipt block injected into the model-facing final tool result, when any. */
  actionLedger?: string;
}

export interface ResolveExternalConversationInput {
  sourceId: string;
  gezelId: string;
  messages: ExternalTranscriptMessage[];
  /** Unique id for a genuinely new thread, normally the caller's request id. */
  fallbackExternalConversationId: string;
}

export interface ExternalConversationFinish {
  content: string;
  reasoning?: string;
  finishReason: 'stop' | 'tool_calls' | 'length';
}

export interface ExternalConversationTurn {
  sessionId: string;
  projectId: string;
  onContentDelta(content: string): void;
  onReasoningDelta(content: string): void;
  onToolArgsDelta(name: string, content: string): void;
  finish(result: ExternalConversationFinish): Promise<void>;
  fail(error: unknown): Promise<void>;
}
