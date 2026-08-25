import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { isAbsolute, normalize } from 'node:path';
import type {
  ChatMessage,
  ChatMessageToolCall,
  ChatSession,
  ChatSessionSource,
  ExternalRequestDiagnostics,
  ProviderName,
} from '@bendyline/gezel';
import { KeyedLock, redactCredentials } from '@bendyline/gezel';
import type { Store } from '../fs/store.js';
import type { ChatEventBus, PublishScope } from './events.js';
import { externalUserMessageForDisplay } from './external-message-display.js';

const DEFAULT_PROJECT_ID = 'default';
const MAX_TOOL_RESULT_CHARS = 12_000;
const MAX_TOOL_ARGUMENT_CHARS = 100_000;
const MAX_DIAGNOSTIC_MESSAGE_CHARS = 12_000;
const MAX_DIAGNOSTIC_TOOL_ARGUMENT_CHARS = 20_000;
const MAX_DIAGNOSTIC_SYSTEM_CHARS = 100_000;
const MAX_DIAGNOSTIC_MESSAGES = 24;
const EXTERNAL_ACTIVITY_STALE_MS = 30 * 60_000;

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

export interface ExternalConversationActivity {
  sessionId: string;
  gezelId: string;
  projectId: string;
  providerName: ProviderName;
  model?: string;
  userText: string;
  startedAt: number;
  elapsedMs: number;
  lastProgressAgoMs: number;
}

interface ActiveExternalConversation
  extends Omit<ExternalConversationActivity, 'elapsedMs' | 'lastProgressAgoMs'> {
  lastProgressAt: number;
}

interface ExternalTurnDraft {
  turnKey: string;
  reasoning: string;
  reasoningNeedsBreak: boolean;
  publishedToolIds: Set<string>;
}

interface NormalizedExternalTranscript {
  /** Completed logical turns only. A trailing tool loop stays live until its final reply. */
  messages: Array<Omit<ChatMessage, 'at'>>;
  /** Assistant prose + completed tools accumulated after the latest user message. */
  openAssistant?: Omit<ChatMessage, 'at'>;
  /** Tool ids aligned with `openAssistant.toolCalls`. */
  openToolIds: string[];
}

interface ExternalConversationRecorderOptions {
  store: Store;
  events: ChatEventBus;
  onFinalTurn?: (sessionId: string) => void;
  now?: () => Date;
}

/**
 * Mirrors caller-owned chat loops into Gezel's ordinary session ledger.
 *
 * The external app remains authoritative: every inbound request carries its
 * full transcript, which is reconciled idempotently, and Gezel never executes
 * or infers the app's tool calls. Tool results become durable only after the
 * app sends them back on the next request.
 */
export class ExternalConversationRecorder {
  private readonly locks = new KeyedLock();
  private readonly active = new Map<string, ActiveExternalConversation>();
  private readonly drafts = new Map<string, ExternalTurnDraft>();
  private readonly now: () => Date;

  constructor(private readonly opts: ExternalConversationRecorderOptions) {
    this.now = opts.now ?? (() => new Date());
  }

  /**
   * Recover conversation affinity for clients that send the authoritative
   * transcript but no stable thread id (VS Code's native Custom Endpoint is
   * the current example).
   *
   * A prior external thread is reused only when every durable message in it
   * is an exact prefix of the incoming transcript. This continues tool rounds
   * and later user turns, while a new/branched chat whose transcript is
   * shorter or diverges receives the caller's fresh fallback id.
   */
  async resolveConversationId(input: ResolveExternalConversationInput): Promise<string> {
    const authoritative = normalizeTranscript(input.messages, input.sourceId).messages;
    if (!authoritative.some((message) => message.role === 'user')) {
      return input.fallbackExternalConversationId;
    }

    const summaries = await this.opts.store.listSessions({ gezelId: input.gezelId });
    let best: { externalConversationId: string; messageCount: number } | null = null;
    for (const summary of summaries) {
      const source = summary.source;
      if (source?.kind !== 'external' || source.appId !== input.sourceId) continue;
      const record = await this.opts.store.getSession(input.gezelId, summary.id);
      if (!record || !record.messages.some((message) => message.role === 'user')) continue;
      const existing = normalizeStoredMessagesForSource(record.messages, input.sourceId);
      if (existing.length > authoritative.length) continue;
      if (commonPrefixLength(existing, authoritative) !== existing.length) continue;
      if (!best || existing.length > best.messageCount) {
        best = {
          externalConversationId: source.externalConversationId,
          messageCount: existing.length,
        };
      }
    }
    return best?.externalConversationId ?? input.fallbackExternalConversationId;
  }

  async begin(input: BeginExternalConversationInput): Promise<ExternalConversationTurn> {
    const sessionId = externalSessionId(
      input.sourceId,
      input.externalConversationId,
      input.gezelId,
    );
    const normalized = normalizeTranscript(input.messages, input.sourceId);
    const turnKey = externalTurnKey(input.messages);
    const state = await this.withLock(sessionId, async () => {
      let record = await this.opts.store.getSession(input.gezelId, sessionId);
      const normalizedWorkingDirectory = normalizeWorkingDirectory(input.workingDirectory);
      if (!record) {
        const projectHint = input.projectHint?.trim() || undefined;
        const projectId = await this.resolveProjectId(normalizedWorkingDirectory, projectHint);
        const source: ChatSessionSource = {
          kind: 'external',
          appId: input.sourceId,
          appName: input.sourceName,
          externalConversationId: input.externalConversationId,
          readOnly: true,
          ...(normalizedWorkingDirectory ? { workingDirectory: normalizedWorkingDirectory } : {}),
          ...(projectHint ? { projectHint } : {}),
        };
        const createdAt = this.now().toISOString();
        record = {
          version: 1,
          id: sessionId,
          gezelId: input.gezelId,
          projectId,
          providerName: input.providerName,
          ...(input.model ? { model: input.model } : {}),
          title: externalThreadTitle(normalized.messages, input.sourceName),
          createdAt,
          lastActivityAt: createdAt,
          source,
          messages: [],
          providerState: {},
        };
      }

      // A deterministic id collision with an ordinary/local session should be
      // practically impossible, but provenance is still checked before write.
      if (
        record.source?.kind !== 'external' ||
        record.source.appId !== input.sourceId ||
        record.source.externalConversationId !== input.externalConversationId
      ) {
        throw new Error(`External conversation session collision for ${sessionId}`);
      }

      // Recompute from the normalized first request. Besides keeping titles
      // aligned with the visible transcript, this repairs VS Code mirrors
      // created before its XML-like prompt envelope was unwrapped.
      record.title = externalThreadTitle(normalized.messages, input.sourceName);

      let draft = this.drafts.get(sessionId);
      if (
        !draft ||
        draft.turnKey !== turnKey ||
        !isOrderedPrefix([...draft.publishedToolIds], normalized.openToolIds)
      ) {
        draft = {
          turnKey,
          reasoning: '',
          reasoningNeedsBreak: false,
          publishedToolIds: new Set(),
        };
        this.drafts.set(sessionId, draft);
      }

      // Pi's OpenAI loop represents every tool round as another assistant
      // message. In Gezel that is still ONE assistant turn: keep the trailing
      // tool loop out of the durable timeline until the final non-tool reply
      // arrives. Otherwise every reconciliation refresh produces another
      // bubble (and empty rounds render as "No written response").
      const authoritative = normalized.messages;
      const storedMessages = normalizeStoredMessagesForSource(record.messages, input.sourceId);
      const common = commonPrefixLength(storedMessages, authoritative);
      const nextMessages = storedMessages.slice(0, common);
      let nextAt = nextTimestamp(nextMessages.at(-1)?.at, this.now().getTime());
      for (let i = common; i < authoritative.length; i++) {
        const draft = authoritative[i]!;
        nextMessages.push({ ...draft, at: new Date(nextAt).toISOString() });
        nextAt += 1;
      }

      record.messages = nextMessages;
      if (record.extractedUpTo !== undefined) {
        // A Pi branch/retry can replace an already-recorded suffix. Anything
        // past the common prefix is no longer known to have been harvested.
        record.extractedUpTo = Math.min(record.extractedUpTo, common, nextMessages.length);
      }
      record.providerName = input.providerName;
      if (input.model) record.model = input.model;
      record.lastTurnError = undefined;
      record.lastTurnErrorDetail = undefined;
      record.externalRequestDiagnostics = captureExternalRequestDiagnostics(input, this.now());
      // Every caller-owned inference request is activity even when the
      // completed logical transcript did not change (the normal tool-result
      // continuation case).
      record.lastActivityAt = this.now().toISOString();
      await this.opts.store.writeSession(record);

      const scope = scopeFor(record);
      const changedMessages = nextMessages.slice(common);
      for (const message of changedMessages) this.publishCommitted(scope, message);

      // A tool-result continuation often adds no new user message. Seed the
      // live slot with the existing prompt so the next deltas attach to the
      // same visible turn; the UI deduplicates this exact timestamp.
      if (!changedMessages.some((message) => message.role === 'user')) {
        const latestUser = [...nextMessages].reverse().find((message) => message.role === 'user');
        if (latestUser)
          this.opts.events.publish(scope, { type: 'user_message', message: latestUser });
      }

      // The open tool loop is intentionally absent from `record.messages`,
      // but its completed calls still belong in the one live assistant card.
      // Tool ids make this idempotent across Pi's full-transcript requests.
      const openTools = normalized.openAssistant?.toolCalls ?? [];
      for (let index = 0; index < normalized.openToolIds.length; index++) {
        const toolId = normalized.openToolIds[index]!;
        const tool = openTools[index];
        if (!tool || draft.publishedToolIds.has(toolId)) continue;
        draft.publishedToolIds.add(toolId);
        this.publishTool(scope, tool);
      }
      return { record, scope, draft, openAssistant: normalized.openAssistant };
    });

    const nowMs = this.now().getTime();
    const existingActivity = this.active.get(sessionId);
    const latestUserText = [...normalized.messages]
      .reverse()
      .find((message) => message.role === 'user')?.content;
    this.active.set(sessionId, {
      sessionId,
      gezelId: state.record.gezelId,
      projectId: state.record.projectId,
      providerName: input.providerName,
      ...(input.model ? { model: input.model } : {}),
      userText: latestUserText ?? existingActivity?.userText ?? '',
      startedAt: existingActivity?.startedAt ?? nowMs,
      lastProgressAt: nowMs,
    });

    let settled = false;
    return {
      sessionId,
      projectId: state.record.projectId,
      onContentDelta: (content) => {
        if (!settled && content) {
          this.touch(sessionId);
          this.opts.events.publish(state.scope, { type: 'delta', content });
        }
      },
      onReasoningDelta: (content) => {
        if (!settled && content) {
          this.touch(sessionId);
          const currentDraft = this.drafts.get(sessionId);
          let visible = content;
          if (currentDraft === state.draft) {
            // A fresh inference after a tool result starts a new reasoning
            // paragraph, not a new chat card. Preserve that boundary inside
            // the single continuous Thinking trace.
            if (currentDraft.reasoningNeedsBreak && currentDraft.reasoning.trim().length > 0) {
              visible = `\n\n${visible}`;
            }
            currentDraft.reasoningNeedsBreak = false;
            currentDraft.reasoning += visible;
          }
          this.opts.events.publish(state.scope, { type: 'reasoning_delta', content: visible });
        }
      },
      onToolArgsDelta: (name, content) => {
        if (!settled && content) {
          this.touch(sessionId);
          this.opts.events.publish(state.scope, { type: 'tool_args_delta', name, content });
        }
      },
      finish: async (result) => {
        if (settled) return;
        settled = true;
        // A tool-call response is one inference iteration inside the
        // caller-owned turn, not a user-visible assistant reply. Keep its
        // activity registered while the external app runs the tool and sends
        // the next transcript-bearing request.
        if (result.finishReason === 'tool_calls') {
          const currentDraft = this.drafts.get(sessionId);
          if (currentDraft === state.draft && currentDraft.reasoning.trim().length > 0) {
            currentDraft.reasoningNeedsBreak = true;
          }
          this.touch(sessionId);
          return;
        }
        try {
          await this.withLock(sessionId, async () => {
            const record = await this.opts.store.getSession(input.gezelId, sessionId);
            if (!record) return;
            const content = joinAssistantContent(
              state.openAssistant?.content ?? '',
              result.content,
            );
            const currentDraft = this.drafts.get(sessionId);
            const capturedReasoning =
              currentDraft === state.draft ? currentDraft.reasoning.trim() : '';
            const reasoning = capturedReasoning || result.reasoning?.trim();
            const at = new Date(
              nextTimestamp(record.messages.at(-1)?.at, this.now().getTime()),
            ).toISOString();
            const assistant: ChatMessage = {
              role: 'assistant',
              content,
              at,
              ...(state.openAssistant?.toolCalls && state.openAssistant.toolCalls.length > 0
                ? { toolCalls: state.openAssistant.toolCalls }
                : {}),
              ...(reasoning ? { reasoning } : {}),
            };
            record.messages.push(assistant);
            record.lastActivityAt = at;
            record.lastTurnError = undefined;
            record.lastTurnErrorDetail = undefined;
            await this.opts.store.writeSession(record);
            this.opts.events.publish(scopeFor(record), { type: 'complete', message: assistant });
            this.opts.events.publish(scopeFor(record), { type: 'done' });
            if (result.finishReason === 'stop') this.opts.onFinalTurn?.(sessionId);
          });
        } finally {
          this.active.delete(sessionId);
          this.drafts.delete(sessionId);
        }
      },
      fail: async (error) => {
        if (settled) return;
        settled = true;
        try {
          await this.withLock(sessionId, async () => {
            const record = await this.opts.store.getSession(input.gezelId, sessionId);
            if (!record) return;
            const message = redactCredentials(
              error instanceof Error ? error.message : String(error),
            );
            record.lastTurnError = message;
            record.lastActivityAt = this.now().toISOString();
            await this.opts.store.writeSession(record);
            const scope = scopeFor(record);
            this.opts.events.publish(scope, { type: 'error', error: message });
            this.opts.events.publish(scope, { type: 'done' });
          });
        } finally {
          this.active.delete(sessionId);
          this.drafts.delete(sessionId);
        }
      },
    };
  }

  /**
   * Snapshot caller-owned turns alongside ChatManager's native sends. A stale
   * guard prevents an external app that disappears between tool rounds from
   * leaving permanent working indicators until the daemon restarts.
   */
  listActive(): ExternalConversationActivity[] {
    const nowMs = this.now().getTime();
    const out: ExternalConversationActivity[] = [];
    for (const [sessionId, activity] of this.active) {
      if (nowMs - activity.lastProgressAt > EXTERNAL_ACTIVITY_STALE_MS) {
        this.active.delete(sessionId);
        this.drafts.delete(sessionId);
        continue;
      }
      out.push({
        ...activity,
        elapsedMs: Math.max(0, nowMs - activity.startedAt),
        lastProgressAgoMs: Math.max(0, nowMs - activity.lastProgressAt),
      });
    }
    return out;
  }

  private touch(sessionId: string): void {
    const activity = this.active.get(sessionId);
    if (activity) activity.lastProgressAt = this.now().getTime();
  }

  private publishCommitted(scope: PublishScope, message: ChatMessage): void {
    if (message.role === 'user') {
      this.opts.events.publish(scope, { type: 'user_message', message });
      return;
    }
    for (const tool of message.toolCalls ?? []) this.publishTool(scope, tool);
    // `normalizeTranscript` withholds the trailing tool loop, so every
    // assistant message that reaches this path is already a completed logical
    // turn—even when it carries the tools that ran before its final prose.
    this.opts.events.publish(scope, { type: 'complete', message });
  }

  private publishTool(scope: PublishScope, tool: ChatMessageToolCall): void {
    this.opts.events.publish(scope, {
      type: 'tool',
      name: tool.name,
      durationMs: tool.durationMs,
      success: tool.success,
      ...(tool.errorMessage ? { errorMessage: tool.errorMessage } : {}),
      ...(tool.argsSummary ? { argsSummary: tool.argsSummary } : {}),
      ...(tool.argsFull ? { argsFull: tool.argsFull } : {}),
      ...(tool.resultText ? { resultText: tool.resultText } : {}),
      ...(tool.resultTruncated ? { resultTruncated: true } : {}),
    });
  }

  private async resolveProjectId(
    workingDirectory: string | undefined,
    projectHint: string | undefined,
  ): Promise<string> {
    if (!workingDirectory && !projectHint) return DEFAULT_PROJECT_ID;
    const normalizedHint = projectHint?.toLocaleLowerCase();
    const matches = (await this.opts.store.listProjects()).filter((project) => {
      const directoryMatches =
        workingDirectory !== undefined &&
        normalizeWorkingDirectory(project.workingDir) === workingDirectory;
      const hintMatches =
        normalizedHint !== undefined &&
        (project.id === projectHint || project.name.toLocaleLowerCase() === normalizedHint);
      return directoryMatches || hintMatches;
    });
    return matches.length === 1 ? matches[0]!.id : DEFAULT_PROJECT_ID;
  }

  private async withLock<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    return this.locks.run(sessionId, work);
  }
}

function externalSessionId(sourceId: string, externalId: string, gezelId: string): string {
  const digest = createHash('sha256')
    .update(`${sourceId}\0${externalId}\0${gezelId}`)
    .digest('hex')
    .slice(0, 24);
  const safeSource = sourceId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `external-${safeSource || 'app'}-${digest}`;
}

function normalizeWorkingDirectory(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || !isAbsolute(trimmed)) return undefined;
  const normalized = normalize(trimmed);
  let canonical = normalized;
  try {
    // Store project paths are canonicalized. Resolve aliases such as macOS's
    // `/var` -> `/private/var` too, or an external chat can miss the project
    // even though both paths name the same working directory.
    canonical = realpathSync.native(normalized);
  } catch {
    // A caller may report a directory before it exists. Lexical normalization
    // still gives us a stable hint and preserves the existing fallback path.
  }
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}

function externalThreadTitle(
  messages: Array<Pick<ExternalTranscriptMessage, 'role' | 'content'>>,
  sourceName: string,
): string {
  const firstUser = messages.find((message) => message.role === 'user')?.content.trim();
  if (!firstUser) return `${sourceName} conversation`;
  const oneLine = firstUser.replace(/\s+/g, ' ');
  return oneLine.length > 80 ? `${oneLine.slice(0, 77)}…` : oneLine;
}

function normalizeTranscript(
  messages: ExternalTranscriptMessage[],
  sourceId: string,
): NormalizedExternalTranscript {
  const toolResults = new Map<string, string>();
  for (const message of messages) {
    if (message.role === 'tool' && message.toolCallId) {
      toolResults.set(message.toolCallId, message.content);
    }
  }

  const normalized: Array<Omit<ChatMessage, 'at'>> = [];
  let assistant: Omit<ChatMessage, 'at'> | undefined;
  let assistantToolIds: string[] = [];

  const commitAssistant = (): void => {
    if (!assistant) return;
    normalized.push(assistant);
    assistant = undefined;
    assistantToolIds = [];
  };

  for (const message of messages) {
    if (message.role === 'user') {
      // A new user message closes any malformed/incomplete prior tool turn.
      // Ordinary Pi traffic closes it with a non-tool assistant response,
      // but preserving the suffix here is safer than silently dropping it.
      commitAssistant();
      const content = externalUserMessageForDisplay(sourceId, message.content);
      if (content !== null) normalized.push({ role: 'user', content });
      continue;
    }
    if (message.role !== 'assistant') continue;
    const completedTools: ChatMessageToolCall[] = [];
    const completedToolIds: string[] = [];
    for (const call of message.toolCalls ?? []) {
      const result = toolResults.get(call.id);
      if (result === undefined) continue;
      const resultText = boundText(result, MAX_TOOL_RESULT_CHARS);
      const failed = looksLikeFailedToolResult(result);
      completedTools.push({
        name: call.name,
        durationMs: 0,
        success: !failed,
        argsSummary: call.name,
        argsFull: boundText(call.arguments, MAX_TOOL_ARGUMENT_CHARS).text,
        resultText: resultText.text,
        ...(failed ? { errorMessage: resultText.text } : {}),
        ...(resultText.truncated ? { resultTruncated: true } : {}),
      });
      completedToolIds.push(call.id);
    }
    if (message.content.length > 0 || completedTools.length > 0) {
      assistant = {
        role: 'assistant',
        content: joinAssistantContent(assistant?.content ?? '', message.content),
        ...((assistant?.toolCalls?.length ?? 0) + completedTools.length > 0
          ? { toolCalls: [...(assistant?.toolCalls ?? []), ...completedTools] }
          : {}),
      };
      assistantToolIds.push(...completedToolIds);
    }

    // A non-tool assistant message is the caller-visible end of this user
    // turn. Tool-bearing messages remain an open draft until that final reply.
    if ((message.toolCalls?.length ?? 0) === 0) commitAssistant();
  }
  return {
    messages: normalized,
    ...(assistant ? { openAssistant: assistant } : {}),
    openToolIds: assistantToolIds,
  };
}

function normalizeStoredMessagesForSource(
  messages: ChatMessage[],
  sourceId: string,
): ChatMessage[] {
  const normalized: ChatMessage[] = [];
  for (const message of messages) {
    if (message.role !== 'user') {
      normalized.push(message);
      continue;
    }
    const content = externalUserMessageForDisplay(sourceId, message.content);
    if (content === null) continue;
    normalized.push(content === message.content ? message : { ...message, content });
  }
  return normalized;
}

function externalTurnKey(messages: ExternalTranscriptMessage[]): string {
  let lastUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role === 'user') {
      lastUserIndex = index;
      break;
    }
  }
  // Everything through the latest user message is stable across Pi's tool
  // continuations and changes when a new user turn (or branch) starts.
  const stablePrefix = lastUserIndex >= 0 ? messages.slice(0, lastUserIndex + 1) : messages;
  return createHash('sha256').update(JSON.stringify(stablePrefix)).digest('hex');
}

function isOrderedPrefix(prefix: string[], values: string[]): boolean {
  return prefix.length <= values.length && prefix.every((value, index) => values[index] === value);
}

function joinAssistantContent(left: string, right: string): string {
  if (!left) return right;
  if (!right) return left;
  if (/\s$/u.test(left) || /^\s/u.test(right)) return left + right;
  return `${left}\n\n${right}`;
}

function commonPrefixLength(
  existing: ChatMessage[],
  authoritative: Array<Omit<ChatMessage, 'at'>>,
): number {
  const limit = Math.min(existing.length, authoritative.length);
  let index = 0;
  while (
    index < limit &&
    messageFingerprint(existing[index]!) === messageFingerprint(authoritative[index]!)
  ) {
    index += 1;
  }
  return index;
}

function messageFingerprint(message: Omit<ChatMessage, 'at'> | ChatMessage): string {
  return JSON.stringify({
    role: message.role,
    content: message.content,
    toolCalls: message.toolCalls ?? [],
  });
}

function nextTimestamp(previous: string | undefined, nowMs: number): number {
  const previousMs = previous ? Date.parse(previous) : Number.NaN;
  return Number.isFinite(previousMs) ? Math.max(nowMs, previousMs + 1) : nowMs;
}

function scopeFor(record: ChatSession): PublishScope {
  return {
    sessionId: record.id,
    gezelId: record.gezelId,
    projectId: record.projectId,
    ...(record.source ? { sessionSource: record.source } : {}),
  };
}

function boundText(value: string, maxChars: number): { text: string; truncated: boolean } {
  if (value.length <= maxChars) return { text: value, truncated: false };
  const half = Math.floor((maxChars - 32) / 2);
  return {
    text: `${value.slice(0, half)}\n… ${value.length - half * 2} characters omitted …\n${value.slice(-half)}`,
    truncated: true,
  };
}

function captureExternalRequestDiagnostics(
  input: BeginExternalConversationInput,
  capturedAt: Date,
): ExternalRequestDiagnostics {
  const transcript = input.messages.slice(-MAX_DIAGNOSTIC_MESSAGES);
  let transcriptTruncated = transcript.length < input.messages.length;
  const boundedTranscript = transcript.map((message) => {
    const content = boundText(message.content, MAX_DIAGNOSTIC_MESSAGE_CHARS);
    if (content.truncated) transcriptTruncated = true;
    const toolCalls = message.toolCalls?.map((call) => {
      const args = boundText(call.arguments, MAX_DIAGNOSTIC_TOOL_ARGUMENT_CHARS);
      if (args.truncated) transcriptTruncated = true;
      return { id: call.id, name: call.name, arguments: args.text };
    });
    return {
      role: message.role,
      content: content.text,
      ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
      ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
    };
  });
  const systemMessage = boundText(input.effectiveSystemMessage, MAX_DIAGNOSTIC_SYSTEM_CHARS);
  if (systemMessage.truncated) transcriptTruncated = true;
  const actionLedger = input.actionLedger
    ? boundText(input.actionLedger, MAX_DIAGNOSTIC_MESSAGE_CHARS).text
    : undefined;
  return {
    capturedAt: capturedAt.toISOString(),
    systemMessage: systemMessage.text,
    toolNames: [...new Set(input.toolNames)],
    messageCount: input.messages.length,
    ...(transcriptTruncated ? { transcriptTruncated: true } : {}),
    transcript: boundedTranscript,
    ...(actionLedger ? { actionLedger } : {}),
  };
}

function looksLikeFailedToolResult(result: string): boolean {
  const trimmed = result.trim();
  if (!trimmed) return false;
  return (
    /^(?:error|failed|failure|permission denied|access denied|tool .{0,80} failed)\b/iu.test(
      trimmed,
    ) || /^\{\s*"(?:error|isError)"\s*:/u.test(trimmed)
  );
}
