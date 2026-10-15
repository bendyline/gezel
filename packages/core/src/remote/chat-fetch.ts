/**
 * A paired server's model behind the chat-completions interface a local turn
 * loop already speaks.
 *
 * The shared turn loop (`LlamaCppSession`) drives a llama-server: it POSTs
 * OpenAI-style `/v1/chat/completions` requests and reads streamed chunks.
 * This `fetch` answers those requests by running each one through a paired
 * server's `/v1/remote/infer` instead — the same stateless forward pass a
 * desktop's remote provider uses — and streams the server's frames back as
 * llama-server chunks. The loop, its tools, and the conversation stay on the
 * device that sent the request; only the model runs on the server, and the
 * server keeps none of it.
 *
 * Keep-alive comments the server writes while a long prefill runs are passed
 * through, which the loop already counts as liveness. Once the server has
 * proved it sends them, three missed in a row end the reply with a sentence
 * naming the server rather than waiting out the loop's minutes-long watchdog.
 */

import { awakeNow } from '../suspend-clock.js';
import {
  IMAGE_HISTORY_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  type PriorMessageWire,
  REMOTE_STREAM_HEARTBEAT_MS,
  type RemoteInferFrame,
  RemoteInferFrameSchema,
  type RemoteInferRequest,
} from './wire.js';

export interface RemoteChatFetchOptions {
  /** Reaches the paired server (pinned to its certificate). */
  fetch: typeof fetch;
  baseUrl: string;
  token: string;
  /** The server's own `<provider>:<model>` id. */
  model: string;
  /** Named in what a person reads if the server goes quiet. */
  serverName: string;
  queue?: {
    lane?: 'interactive' | 'background';
    sessionId?: string;
    gezelId?: string;
    projectId?: string;
  };
  /** Engine progress on the server (loading the model, prefill, generating). */
  onPhase?(event: {
    phase: string;
    detail?: string;
    progress?: number;
    outputTokens?: number;
    tokensPerSec?: number;
  }): void;
  /** Told whether the request reached the server, for reachability tracking. */
  onReachability?(reachable: boolean): void;
  /**
   * The sentence a failed request ends with, as a person should read it. The
   * loop above reports a failure in its own words (an HTTP status, a stream
   * error); a host shows this instead.
   */
  onFailure?(message: string): void;
  /** Test seam for the stall watchdog. */
  idleMs?: number;
}

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null | Array<{ type: string; text?: string; image_url?: { url: string } }>;
  tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

interface OpenAITool {
  type?: string;
  function?: { name: string; description?: string; parameters?: Record<string, unknown> };
}

function textOf(content: OpenAIMessage['content']): string {
  if (typeof content === 'string') return content;
  if (!content) return '';
  return content
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
}

/** `data:image/png;base64,AAAA` → `{ base64: 'AAAA', mimeType: 'image/png' }`. */
function imagesOf(content: OpenAIMessage['content']): Array<{ base64: string; mimeType: string }> {
  if (!Array.isArray(content)) return [];
  const out: Array<{ base64: string; mimeType: string }> = [];
  for (const part of content) {
    const url = part.type === 'image_url' ? part.image_url?.url : undefined;
    const match = url?.match(/^data:([^;,]+);base64,(.+)$/s);
    if (match) out.push({ mimeType: match[1]!, base64: match[2]! });
  }
  return out;
}

/**
 * The chat-completions body as a `/v1/remote/infer` request: the first system
 * message is the system prompt and a second one the volatile band (how the
 * loop sends them); the last user message is this turn's prompt, or the
 * prompt is empty when the request continues after a tool result.
 */
export function inferRequestFromChat(
  body: { messages?: OpenAIMessage[]; tools?: OpenAITool[] },
  opts: Pick<RemoteChatFetchOptions, 'model' | 'queue'>,
): RemoteInferRequest {
  const messages = [...(body.messages ?? [])];
  const systems: string[] = [];
  while (messages[0]?.role === 'system') systems.push(textOf(messages.shift()!.content));
  const last = messages.at(-1);
  const current = last?.role === 'user' ? messages.pop() : undefined;

  const prior: PriorMessageWire[] = [];
  for (const m of messages) {
    if (m.role === 'system') {
      // Mid-conversation system text has no wire slot; it joins the prompt.
      systems.push(textOf(m.content));
    } else if (m.role === 'tool') {
      prior.push({ role: 'tool', content: textOf(m.content), toolCallId: m.tool_call_id ?? '' });
    } else if (m.role === 'assistant' && m.tool_calls?.length) {
      prior.push({
        role: 'assistant',
        content: textOf(m.content),
        toolCalls: m.tool_calls.map((call) => ({
          id: call.id,
          name: call.function.name,
          arguments: call.function.arguments,
        })),
      });
    } else if (m.role === 'user') {
      const images = imagesOf(m.content).map((image) => image.base64);
      prior.push({
        role: 'user',
        content: textOf(m.content),
        ...(images.length ? { images } : {}),
      });
    } else {
      prior.push({ role: 'assistant', content: textOf(m.content) });
    }
  }
  const attachments = current ? imagesOf(current.content) : [];
  const tools = (body.tools ?? [])
    .map((tool) => tool.function)
    .filter((fn): fn is NonNullable<OpenAITool['function']> => Boolean(fn?.name))
    .map((fn) => ({
      name: fn.name,
      ...(fn.description ? { description: fn.description } : {}),
      parameters: fn.parameters ?? { type: 'object' },
    }));
  return {
    protocolVersion: prior.some((m) => m.role === 'user' && m.images?.length)
      ? IMAGE_HISTORY_PROTOCOL_VERSION
      : PROTOCOL_VERSION,
    model: opts.model,
    systemMessage: systems[0] ?? '',
    ...(systems.length > 1 ? { volatileContext: systems.slice(1).join('\n\n') } : {}),
    prompt: current ? textOf(current.content) : '',
    priorMessages: prior,
    ...(tools.length ? { tools } : {}),
    ...(attachments.length
      ? {
          attachments: attachments.map((a, i) => ({
            base64: a.base64,
            mimeType: a.mimeType,
            filename: `image-${i + 1}`,
          })),
        }
      : {}),
    queue: {
      lane: opts.queue?.lane ?? 'interactive',
      ...(opts.queue?.sessionId ? { sessionId: opts.queue.sessionId } : {}),
      ...(opts.queue?.gezelId ? { gezelId: opts.queue.gezelId } : {}),
      ...(opts.queue?.projectId ? { projectId: opts.queue.projectId } : {}),
      affinity: true,
    },
  };
}

const encoder = new TextEncoder();

function chunk(delta: Record<string, unknown>, finishReason: string | null = null): string {
  return `data: ${JSON.stringify({
    object: 'chat.completion.chunk',
    model: 'remote',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

function jsonError(status: number, message: string, code?: string): Response {
  return new Response(JSON.stringify({ error: { message, ...(code ? { code } : {}) } }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function retryAfterMs(header: string | null, attempt: number): number {
  const seconds = header ? Number.parseFloat(header) : Number.NaN;
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, 30_000);
  return Math.min(1_000 * 2 ** attempt, 15_000);
}

function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error('aborted'));
      },
      { once: true },
    );
  });
}

export function remoteChatFetch(opts: RemoteChatFetchOptions): typeof fetch {
  const idleMs = opts.idleMs ?? REMOTE_STREAM_HEARTBEAT_MS * 3;
  const failed = (status: number, message: string, code?: string) => {
    opts.onFailure?.(message);
    return jsonError(status, message, code);
  };
  const silent = () => {
    const message = `${opts.serverName} stopped responding partway through this reply. It may have gone to sleep or left this network.`;
    opts.onFailure?.(message);
    return `data: ${JSON.stringify({ error: { message, code: 'remote_unreachable' } })}\n\n`;
  };
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    if (url.pathname.endsWith('/slots')) return new Response('', { status: 404 });
    if (
      (init?.method ?? 'GET').toUpperCase() !== 'POST' ||
      !url.pathname.endsWith('/v1/chat/completions')
    ) {
      return new Response('', { status: 404 });
    }
    const signal = init?.signal ?? null;
    let request: RemoteInferRequest;
    try {
      request = inferRequestFromChat(JSON.parse(String(init?.body ?? '{}')), opts);
    } catch {
      return failed(400, 'The request could not be read.');
    }

    let upstream: Response;
    for (let attempt = 0; ; attempt++) {
      try {
        upstream = await opts.fetch(`${opts.baseUrl}/v1/remote/infer`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${opts.token}`,
            Accept: 'text/event-stream',
          },
          body: JSON.stringify(request),
          ...(signal ? { signal } : {}),
        });
      } catch (err) {
        if (signal?.aborted) throw err;
        opts.onReachability?.(false);
        return failed(
          503,
          `${opts.serverName} isn't reachable right now. It may be asleep, or this device may not be on its network.`,
          'remote_unreachable',
        );
      }
      opts.onReachability?.(true);
      // The server is at its per-device limit or its engine is busy: wait
      // as the desktop's remote provider does, until it frees or the person stops.
      if ((upstream.status === 429 || upstream.status === 503) && attempt < 30) {
        await upstream.body?.cancel().catch(() => {});
        opts.onPhase?.({ phase: 'queued' });
        await sleep(retryAfterMs(upstream.headers.get('retry-after'), attempt), signal);
        continue;
      }
      break;
    }
    if (!upstream.ok || !upstream.body) {
      const detail = await upstream.text().catch(() => '');
      let message = `${opts.serverName} answered with HTTP ${upstream.status}.`;
      let code: string | undefined;
      try {
        const parsed = JSON.parse(detail) as { error?: string; message?: string };
        code = parsed.error;
        if (parsed.error === 'model_not_loaded') {
          message = `${opts.serverName} doesn't have this model ready to run. Choose another of its models.`;
        } else if (parsed.message) {
          message = parsed.message;
        }
      } catch {
        /* plain-text body */
      }
      return failed(upstream.status, message, code);
    }

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let reasoningStreamed = false;
    let toolCalls = false;
    let heartbeats = false;
    let lastHeard = awakeNow();
    let stalled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const emit = (text: string) => controller.enqueue(encoder.encode(text));
        const watchdog = setInterval(
          () => {
            if (!heartbeats || awakeNow() - lastHeard <= idleMs) return;
            stalled = true;
            void reader.cancel(new Error('remote stream went silent')).catch(() => {});
          },
          Math.min(5_000, Math.max(10, Math.floor(idleMs / 4))),
        );
        const handle = (frame: RemoteInferFrame) => {
          switch (frame.type) {
            case 'delta':
              emit(chunk({ content: frame.text }));
              break;
            case 'reasoning_delta':
              reasoningStreamed = true;
              emit(chunk({ reasoning_content: frame.text }));
              break;
            case 'reasoning':
              if (!reasoningStreamed) emit(chunk({ reasoning_content: frame.text }));
              break;
            case 'tool_call':
              toolCalls = true;
              emit(
                chunk({
                  tool_calls: frame.calls.map((call, index) => ({
                    index,
                    id: call.id,
                    type: 'function',
                    function: { name: call.name, arguments: call.arguments },
                  })),
                }),
              );
              break;
            case 'usage':
              emit(
                `data: ${JSON.stringify({
                  object: 'chat.completion.chunk',
                  model: 'remote',
                  choices: [],
                  usage: {
                    prompt_tokens: frame.inputTokens,
                    completion_tokens: frame.outputTokens,
                    total_tokens: frame.inputTokens + frame.outputTokens,
                    ...(frame.cachedInputTokens !== undefined
                      ? { prompt_tokens_details: { cached_tokens: frame.cachedInputTokens } }
                      : {}),
                  },
                })}\n\n`,
              );
              break;
            case 'phase':
              opts.onPhase?.({
                phase: frame.phase,
                ...(frame.detail ? { detail: frame.detail } : {}),
                ...(frame.progress !== undefined ? { progress: frame.progress } : {}),
                ...(frame.outputTokens !== undefined ? { outputTokens: frame.outputTokens } : {}),
                ...(frame.tokensPerSec !== undefined ? { tokensPerSec: frame.tokensPerSec } : {}),
              });
              break;
            case 'queued':
              opts.onPhase?.({ phase: 'queued' });
              break;
            case 'wire_pulse':
            case 'tool_args_delta':
              // Liveness the loop can see, without content it would misread.
              emit(': pulse\n\n');
              break;
            case 'error':
              opts.onFailure?.(frame.message);
              emit(
                `data: ${JSON.stringify({ error: { message: frame.message, code: frame.code } })}\n\n`,
              );
              break;
            case 'done':
              emit(chunk({}, toolCalls ? 'tool_calls' : 'stop'));
              emit('data: [DONE]\n\n');
              break;
            default:
              break;
          }
        };
        void (async () => {
          let buffer = '';
          try {
            for (;;) {
              const { value, done } = await reader.read();
              if (done) break;
              lastHeard = awakeNow();
              buffer += decoder.decode(value, { stream: true });
              let boundary = buffer.indexOf('\n\n');
              while (boundary !== -1) {
                const event = buffer.slice(0, boundary);
                buffer = buffer.slice(boundary + 2);
                const lines = event.split('\n');
                if (lines.some((line) => line.startsWith(':'))) {
                  heartbeats = true;
                  emit(': keepalive\n\n');
                }
                const data = lines
                  .filter((line) => line.startsWith('data:'))
                  .map((line) => line.slice(5).trim())
                  .join('');
                if (data) {
                  try {
                    const parsed = RemoteInferFrameSchema.safeParse(JSON.parse(data));
                    if (parsed.success) handle(parsed.data);
                  } catch {
                    /* an unparseable frame is skipped, as on the desktop */
                  }
                }
                boundary = buffer.indexOf('\n\n');
              }
            }
            if (stalled && !signal?.aborted) {
              opts.onReachability?.(false);
              emit(silent());
            }
            controller.close();
          } catch (err) {
            if (signal?.aborted) {
              controller.error(err);
              return;
            }
            opts.onReachability?.(false);
            emit(silent());
            controller.close();
          } finally {
            clearInterval(watchdog);
          }
        })();
      },
      cancel(reason) {
        void reader.cancel(reason).catch(() => {});
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  }) as typeof fetch;
}
