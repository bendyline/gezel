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
import type { ProviderQueue } from '../queue.js';
import { runInQueue } from '../queue.js';
import { StreamingSessionBase } from '../streaming-session.js';
import type {
  ExternalToolCall,
  ImageAttachment,
  LLMSession,
  ProviderSessionState,
  SendAndWaitOpts,
} from '../types.js';
import { buildTurnUsage } from '../usage-builder.js';
import {
  PROTOCOL_VERSION,
  type PriorMessageWire,
  RemoteInferFrameSchema,
  type RemoteInferRequest,
} from './wire.js';

const log = createLogger('remote-session');

/** Hard bound on local tool-call loops so a runaway remote model can't hang. */
const MAX_TOOL_LOOPS = 24;

export interface RemoteSessionDeps {
  baseUrl: string;
  token: string;
  fetch: typeof fetch;
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
  timeoutMs: number;
}

export class RemoteSession extends StreamingSessionBase implements LLMSession {
  private lastReasoning: string | undefined;

  constructor(private readonly deps: RemoteSessionDeps) {
    super();
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

  async sendAndWait(prompt: string, opts?: SendAndWaitOpts): Promise<string> {
    return runInQueue(this.deps.queue, opts?.queue, () => this.sendAndWaitInner(prompt, opts));
  }

  private async sendAndWaitInner(prompt: string, opts?: SendAndWaitOpts): Promise<string> {
    this.lastReasoning = undefined;
    const deadline = Date.now() + (opts?.timeoutMs ?? this.deps.timeoutMs);
    const priorMessages: PriorMessageWire[] = [...this.deps.priorMessages];
    let nextPrompt = prompt;
    let fullText = '';

    for (let turn = 0; turn < MAX_TOOL_LOOPS; turn++) {
      if (Date.now() > deadline) {
        throw new Error(`[remote] turn timed out after ${Math.round(this.deps.timeoutMs / 1000)}s`);
      }
      const { text, toolCalls } = await this.postInfer(nextPrompt, priorMessages, opts);
      fullText += text;
      if (toolCalls.length === 0) return fullText;

      // Execute the model's tool calls LOCALLY on A, then continue the loop.
      const toolResults: PriorMessageWire[] = [];
      for (const call of toolCalls) {
        let args: Record<string, unknown> = {};
        try {
          args = call.arguments ? JSON.parse(call.arguments) : {};
        } catch {
          /* leave empty — the tool will surface its own validation error */
        }
        let output: string;
        try {
          const rich = await this.deps.bridges.callToolRich(call.name, args);
          output = rich.text;
        } catch (err) {
          output = `ERROR: ${err instanceof Error ? err.message : String(err)}`;
        }
        toolResults.push({ role: 'tool', content: output, toolCallId: call.id });
      }
      priorMessages.push({ role: 'assistant', content: text, toolCalls }, ...toolResults);
      nextPrompt = ''; // tool results drive the next forward-pass
    }
    throw new Error('[remote] too many tool-call loops; aborting');
  }

  private async postInfer(
    prompt: string,
    priorMessages: PriorMessageWire[],
    opts?: SendAndWaitOpts,
  ): Promise<{ text: string; toolCalls: ExternalToolCall[] }> {
    const start = Date.now();
    const tools = this.deps.bridges.isEmpty()
      ? undefined
      : this.deps.bridges
          .getOpenAITools()
          .map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));

    const body: RemoteInferRequest = {
      protocolVersion: PROTOCOL_VERSION,
      model: this.deps.model,
      systemMessage: this.deps.systemMessage,
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

    const res = await this.deps.fetch(`${this.deps.baseUrl}/v1/remote/infer`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.deps.token}`,
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
