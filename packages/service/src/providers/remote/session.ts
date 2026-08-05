/**
 * RemoteSession — Device A's `LLMSession` for a model hosted on a paired
 * server (Device B). The agentic tool loop runs HERE on A (where the project
 * files live); only the model forward-pass is remoted. Structurally this is
 * the OpenAISession tool loop, but instead of calling a cloud SDK it POSTs to
 * `B/v1/remote/infer` and streams back gezel-native SSE frames.
 *
 * Per iteration: POST the transcript → B runs ONE forward-pass and either
 * streams text to completion (done) or halts on a tool call and returns it
 * (B never executes tools). On a tool call A runs it against its LOCAL bridge,
 * appends the result to `priorMessages`, and POSTs again. B stays stateless.
 */

import { createLogger } from '@bendyline/gezel';
import type { McpBridgePool } from '../mcp-bridge-pool.js';
import { computeToolBudgetChars } from '../mcp-bridge.js';
import type { ProviderQueue } from '../queue.js';
import { runInQueue } from '../queue.js';
import {
  PROJECT_MACRO_FAILURE_CAP,
  deriveProjectMacroClosing,
} from '../project-macro-loop-bail.js';
import { StreamingSessionBase } from '../streaming-session.js';
import type {
  ExternalToolCall,
  ImageAttachment,
  LLMSession,
  ProviderSessionState,
  SendAndWaitOpts,
  SessionOpts,
} from '../types.js';
import { buildTurnUsage } from '../usage-builder.js';
import {
  PROTOCOL_VERSION,
  type PriorMessageWire,
  type RemoteCacheWarmRequest,
  RemoteInferFrameSchema,
  type RemoteInferRequest,
} from './wire.js';

const log = createLogger('remote-session');

/** Hard bound on local tool-call loops so a runaway remote model can't hang. */
const MAX_TOOL_LOOPS = 24;
const MID_LOOP_COMPACT_RATIO = 0.7;
const MID_LOOP_COMPACT_MIN_PRIOR = 2;

export interface RemoteSessionDeps {
  baseUrl: string;
  token: string;
  fetch: typeof fetch;
  /**
   * Refreshable connection for runtime-managed brokers. Existing chat
   * sessions survive broker restarts (rotated port, cert, and token) by
   * resolving this immediately before every forward pass.
   */
  resolveConnection?: () => { baseUrl: string; token: string; fetch: typeof fetch };
  queue: ProviderQueue;
  /** A's LOCAL tool bridge — tool calls execute here, on A's files. */
  bridges: McpBridgePool;
  systemMessage: string;
  /** B-native model id (the `remote:<id>/` prefix already stripped). */
  model: string;
  systemPromptLayers?: { gezel: string; project: string };
  volatileContext?: string;
  reasoningEffort?: string;
  tuning?: Record<string, unknown>;
  priorMessages: PriorMessageWire[];
  /** Broker-reported post-admission context window. */
  numCtx: number;
  requestCompaction?: NonNullable<SessionOpts['requestCompaction']>;
  timeoutMs: number;
}

export class RemoteSession extends StreamingSessionBase implements LLMSession {
  private lastReasoning: string | undefined;
  private systemMessage: string;
  /** Full A-owned transcript; B deliberately remains stateless. */
  private transcript: PriorMessageWire[];
  /** In-flight view used by pressure estimation during a tool loop. */
  private activePriorMessages: PriorMessageWire[] | null = null;
  private pendingPrompt = '';
  private compactedThisTurn = false;
  numCtx: number;
  readonly model: string;

  constructor(private readonly deps: RemoteSessionDeps) {
    super();
    this.systemMessage = deps.systemMessage;
    this.transcript = [...deps.priorMessages];
    this.numCtx = deps.numCtx;
    this.model = deps.model;
  }

  providerState(): ProviderSessionState {
    return {}; // B is stateless w.r.t. this session — nothing to persist.
  }

  async disconnect(): Promise<void> {
    this.clearHandlers();
    await this.deps.bridges.stop().catch(() => {});
  }

  getLastTurnReasoning(): string | undefined {
    return this.lastReasoning;
  }

  getRegisteredToolNames(): string[] {
    return this.deps.bridges.isEmpty() ? [] : this.deps.bridges.getOpenAITools().map((t) => t.name);
  }

  setSystemMessage(text: string): void {
    this.systemMessage = text;
  }

  estimatePromptChars(): number {
    return this.estimatePromptCharsFor(
      this.activePriorMessages ?? this.transcript,
      this.pendingPrompt,
    );
  }

  /**
   * Ask B to prefill this session's exact current prefix. Unlike the old
   * `/api/cache/warm` proxy, this carries every prompt component B cannot read
   * from disk: system bands, transcript, tuning, and A's local tool schemas.
   */
  async prewarm(sessionId: string): Promise<void> {
    const connection = this.deps.resolveConnection?.() ?? this.deps;
    const tools = this.deps.bridges.isEmpty()
      ? undefined
      : this.deps.bridges
          .getOpenAITools()
          .map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
    const body: RemoteCacheWarmRequest = {
      protocolVersion: PROTOCOL_VERSION,
      model: this.deps.model,
      sessionId,
      systemMessage: this.systemMessage,
      ...(this.deps.systemPromptLayers ? { systemPromptLayers: this.deps.systemPromptLayers } : {}),
      ...(this.deps.volatileContext ? { volatileContext: this.deps.volatileContext } : {}),
      priorMessages: [...this.transcript],
      ...(tools ? { tools } : {}),
      ...(this.deps.tuning ? { tuning: this.deps.tuning } : {}),
    };
    const res = await connection.fetch(`${connection.baseUrl}/v1/remote/cache/warm`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${connection.token}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(
        `[remote] /v1/remote/cache/warm returned HTTP ${res.status}${detail ? ` ${detail}` : ''}`,
      );
    }
  }

  private estimatePromptCharsFor(priorMessages: PriorMessageWire[], prompt: string): number {
    let total =
      this.systemMessage.length + (this.deps.volatileContext?.length ?? 0) + prompt.length;
    for (const message of priorMessages) {
      total += message.content.length;
      if ('toolCalls' in message) total += JSON.stringify(message.toolCalls).length;
      if ('toolCallId' in message) total += message.toolCallId.length;
    }
    if (!this.deps.bridges.isEmpty()) {
      for (const tool of this.deps.bridges.getOpenAITools()) total += JSON.stringify(tool).length;
    }
    return total;
  }

  async sendAndWait(prompt: string, opts?: SendAndWaitOpts): Promise<string> {
    return runInQueue(this.deps.queue, opts?.queue, () => this.sendAndWaitInner(prompt, opts));
  }

  private async sendAndWaitInner(prompt: string, opts?: SendAndWaitOpts): Promise<string> {
    this.lastReasoning = undefined;
    this.compactedThisTurn = false;
    const deadline = Date.now() + (opts?.timeoutMs ?? this.deps.timeoutMs);
    const priorMessages: PriorMessageWire[] = [...this.transcript];
    let currentTurnStartIdx = priorMessages.length;
    let userMessageAdded = false;
    let nextPrompt = prompt;
    let fullText = '';
    let projectMacroResult: string | null = null;
    let projectMacroFailureCount = 0;
    let lastProjectMacroFailure = '';
    this.activePriorMessages = priorMessages;
    this.pendingPrompt = prompt;

    try {
      for (let turn = 0; turn < MAX_TOOL_LOOPS; turn++) {
        if (Date.now() > deadline) {
          throw new Error(
            `[remote] turn timed out after ${Math.round(this.deps.timeoutMs / 1000)}s`,
          );
        }
        const { text, toolCalls } = await this.postInfer(nextPrompt, priorMessages, opts);
        fullText += text;

        // The first forward pass carries the user message in `prompt`; every
        // continuation must move it into priorMessages because B is stateless.
        if (!userMessageAdded) {
          priorMessages.push({ role: 'user', content: prompt });
          userMessageAdded = true;
        }
        this.pendingPrompt = '';

        if (toolCalls.length === 0) {
          priorMessages.push({ role: 'assistant', content: text });
          this.transcript = [...priorMessages];
          return fullText;
        }

        priorMessages.push({ role: 'assistant', content: text, toolCalls });

        // Execute the model's tool calls LOCALLY on A, then continue the loop.
        // The adaptive cap uses the broker-admitted numCtx, exactly like the
        // in-process llama.cpp/MLX/Ollama sessions.
        for (const call of toolCalls) {
          let args: Record<string, unknown> = {};
          try {
            args = call.arguments ? JSON.parse(call.arguments) : {};
          } catch {
            /* leave empty — the tool will surface its own validation error */
          }
          const isProjectMacro = call.name === 'start_project' || call.name === 'start_job';
          let output: string;
          let outputIsError = false;
          if (isProjectMacro && projectMacroResult) {
            output =
              'The project was already started successfully by an earlier kickoff call in this turn. This duplicate was suppressed; end the turn now.';
          } else {
            try {
              const budgetChars = computeToolBudgetChars(this.numCtx, this.estimatePromptChars());
              const rich = await this.deps.bridges.callToolRich(call.name, args, {
                budgetChars,
                numCtxTokens: this.numCtx,
              });
              output = rich.text;
              outputIsError = rich.isError;
            } catch (err) {
              output = `ERROR: ${err instanceof Error ? err.message : String(err)}`;
              outputIsError = true;
            }
          }
          if (isProjectMacro && !projectMacroResult) {
            if (outputIsError) {
              projectMacroFailureCount++;
              lastProjectMacroFailure = output;
            } else {
              projectMacroResult = output;
            }
          }
          priorMessages.push({ role: 'tool', content: output, toolCallId: call.id });
        }
        if (projectMacroResult) {
          const closing = deriveProjectMacroClosing(projectMacroResult);
          priorMessages.push({ role: 'assistant', content: closing });
          this.transcript = [...priorMessages];
          return fullText ? `${fullText}\n${closing}` : closing;
        }
        if (projectMacroFailureCount >= PROJECT_MACRO_FAILURE_CAP) {
          const detail = lastProjectMacroFailure
            .replace(/^ERROR:\s*/i, '')
            .replace(/^start_(?:project|job) failed:\s*/i, '')
            .trim();
          const closing = `I couldn't start the project after ${PROJECT_MACRO_FAILURE_CAP} attempts.${detail ? ` ${detail}` : ''}`;
          priorMessages.push({ role: 'assistant', content: closing });
          this.transcript = [...priorMessages];
          return fullText ? `${fullText}\n${closing}` : closing;
        }
        currentTurnStartIdx = await this.maybeCompactMidLoop(priorMessages, currentTurnStartIdx);
        nextPrompt = ''; // tool results drive the next forward-pass
      }
      throw new Error('[remote] too many tool-call loops; aborting');
    } finally {
      this.activePriorMessages = null;
      this.pendingPrompt = '';
    }
  }

  /** Compact older turns while a single remote tool loop is still running. */
  private async maybeCompactMidLoop(
    priorMessages: PriorMessageWire[],
    currentTurnStartIdx: number,
  ): Promise<number> {
    if (this.compactedThisTurn || !this.deps.requestCompaction) return currentTurnStartIdx;
    const estimatedTokens = Math.ceil(this.estimatePromptChars() / 4);
    if (estimatedTokens / this.numCtx < MID_LOOP_COMPACT_RATIO) return currentTurnStartIdx;
    const prior = priorMessages
      .slice(0, currentTurnStartIdx)
      .filter(
        (m): m is Extract<PriorMessageWire, { role: 'user' | 'assistant' }> =>
          (m.role === 'user' || m.role === 'assistant') && m.content.length > 0,
      )
      .map((m) => ({ role: m.role, content: m.content }));
    if (prior.length < MID_LOOP_COMPACT_MIN_PRIOR) return currentTurnStartIdx;
    this.compactedThisTurn = true;
    try {
      const result = await this.deps.requestCompaction({
        priorMessages: prior,
        estimatedTokens,
        numCtx: this.numCtx,
      });
      if (!result) return currentTurnStartIdx;
      priorMessages.splice(0, currentTurnStartIdx, {
        role: 'assistant',
        content: result.syntheticContent,
      });
      this.emitWarning(
        'Compacted earlier conversation to free up working window for the current turn.',
      );
      log.info(
        `[remote] mid-loop compacted ${currentTurnStartIdx} prior message(s) → 1 synthesis (${result.syntheticContent.length} chars)`,
      );
      return 1;
    } catch (err) {
      log.warn(
        `[remote] mid-loop compaction request failed (continuing un-compacted): ${err instanceof Error ? err.message : String(err)}`,
      );
      return currentTurnStartIdx;
    }
  }

  private async postInfer(
    prompt: string,
    priorMessages: PriorMessageWire[],
    opts?: SendAndWaitOpts,
  ): Promise<{ text: string; toolCalls: ExternalToolCall[] }> {
    const start = Date.now();
    const connection = this.deps.resolveConnection?.() ?? this.deps;
    const tools = this.deps.bridges.isEmpty()
      ? undefined
      : this.deps.bridges
          .getOpenAITools()
          .map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));

    const body: RemoteInferRequest = {
      protocolVersion: PROTOCOL_VERSION,
      model: this.deps.model,
      systemMessage: this.systemMessage,
      ...(this.deps.systemPromptLayers ? { systemPromptLayers: this.deps.systemPromptLayers } : {}),
      ...(this.deps.volatileContext ? { volatileContext: this.deps.volatileContext } : {}),
      prompt,
      priorMessages,
      ...(tools ? { tools } : {}),
      ...(opts?.attachments && opts.attachments.length > 0
        ? {
            attachments: opts.attachments.map((a: ImageAttachment) => ({
              base64: a.base64,
              mimeType: a.mimeType,
              filename: a.filename,
            })),
          }
        : {}),
      ...(this.deps.reasoningEffort ? { reasoningEffort: this.deps.reasoningEffort } : {}),
      ...(this.deps.tuning ? { tuning: this.deps.tuning } : {}),
      queue: {
        lane: opts?.queue?.lane ?? 'interactive',
        ...(opts?.queue?.sessionId ? { sessionId: opts.queue.sessionId } : {}),
        ...(opts?.queue?.gezelId ? { gezelId: opts.queue.gezelId } : {}),
        ...(opts?.queue?.projectId ? { projectId: opts.queue.projectId } : {}),
        ...(opts?.queue?.actorLabel ? { actorLabel: opts.queue.actorLabel } : {}),
        ...(opts?.queue?.job ? { job: opts.queue.job } : {}),
        affinity: opts?.queue?.affinity ?? true,
      },
    };

    const res = await connection.fetch(`${connection.baseUrl}/v1/remote/infer`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${connection.token}`,
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
      ...(opts?.queue?.signal ? { signal: opts.queue.signal } : {}),
    });
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '');
      throw new Error(`[remote] /v1/remote/infer returned HTTP ${res.status} ${detail}`.trim());
    }

    let text = '';
    let toolCalls: ExternalToolCall[] = [];
    let errFrame: { code: string; message: string } | null = null;

    await readSseFrames(res.body as ReadableStream<Uint8Array>, (raw) => {
      const parsed = RemoteInferFrameSchema.safeParse(raw);
      if (!parsed.success) {
        log.warn(`[remote] dropping unrecognized frame: ${JSON.stringify(raw).slice(0, 120)}`);
        return;
      }
      const frame = parsed.data;
      switch (frame.type) {
        case 'delta':
          text += frame.text;
          this.emitDelta(frame.text);
          break;
        case 'tool_call':
          toolCalls = frame.calls.map((c) => ({ id: c.id, name: c.name, arguments: c.arguments }));
          break;
        case 'usage':
          if (frame.contextUtilization?.limit && frame.contextUtilization.limit > 0) {
            // Capacity can change between admission and inference. Keep A's
            // next pressure check calibrated to B's latest empirical limit.
            this.numCtx = frame.contextUtilization.limit;
          }
          this.emitUsage(
            buildTurnUsage({
              model: frame.model,
              inputTokens: frame.inputTokens,
              outputTokens: frame.outputTokens,
              durationMs: frame.durationMs ?? Date.now() - start,
              ...(frame.cachedInputTokens !== undefined
                ? { cachedInputTokens: frame.cachedInputTokens }
                : {}),
              ...(frame.contextUtilization !== undefined
                ? { contextUtilization: frame.contextUtilization }
                : {}),
            }),
          );
          break;
        case 'reasoning':
          this.lastReasoning = (this.lastReasoning ?? '') + frame.text;
          break;
        case 'warning':
          this.emitWarning(frame.message);
          break;
        case 'queued':
          opts?.queue?.onQueueWait?.({ aheadOf: frame.aheadOf ?? 0 });
          break;
        case 'error':
          errFrame = { code: frame.code, message: frame.message };
          break;
        default:
          break; // phase/done — no-op for now
      }
    });

    if (errFrame) {
      throw new Error(
        `[remote] ${(errFrame as { code: string }).code}: ${(errFrame as { message: string }).message}`,
      );
    }
    return { text, toolCalls };
  }
}

/**
 * Minimal SSE reader: decode the stream, split on the blank-line frame
 * boundary, JSON-parse each `data:` payload, and hand the raw object to the
 * callback (the caller schema-validates). Tolerates `:`-comment keep-alive
 * lines and multi-line `data:` fields.
 */
async function readSseFrames(
  body: ReadableStream<Uint8Array>,
  onFrame: (raw: unknown) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const rawEvent = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = rawEvent
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .join('');
        if (data) {
          try {
            onFrame(JSON.parse(data));
          } catch {
            /* ignore unparseable frame */
          }
        }
        boundary = buffer.indexOf('\n\n');
      }
    }
  } finally {
    reader.releaseLock();
  }
}
