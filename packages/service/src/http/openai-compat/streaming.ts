import { randomUUID } from 'node:crypto';
import type {
  ExternalToolCall,
  ImageAttachment,
  LLMSession,
  SendAndWaitOpts,
  TurnUsage,
} from '../../providers/types.js';
import {
  type StreamingDiagnostics,
  type StreamingOutboundKind,
  noteStreamingOutbound,
  noteStreamingProviderActivity,
} from './streaming-telemetry.js';
import { ToolCallStreamFilter } from './tool-call-stream-filter.js';

/**
 * One-shot, non-streaming chat completion. Subscribes to usage to fill
 * the OpenAI `usage` envelope and returns the full response in the
 * shape OpenAI's SDK expects.
 *
 * Lifecycle: caller owns the {@link LLMSession} — this function attaches
 * its own onUsage listener and detaches it on resolve/reject so the
 * session can be reused or disposed afterwards.
 */
export interface NonStreamingChatResult {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: [
    {
      index: 0;
      message: {
        role: 'assistant';
        content: string;
        tool_calls?: Array<{
          id: string;
          type: 'function';
          function: { name: string; arguments: string };
        }>;
      };
      finish_reason: 'stop' | 'tool_calls' | 'length';
    },
  ];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/**
 * Truncation detection: providers don't surface the engine's own finish
 * reason through `LLMSession`, so we infer `length` from usage — the
 * turn consumed at least the effective output cap. Callers that
 * auto-continue on `length` (agent loops, long-form writers) need this;
 * reporting truncation as `stop` silently ends their loop mid-thought.
 */
function inferFinishReason(
  hasToolCalls: boolean,
  usage: TurnUsage | null,
  lengthCapTokens: number | undefined,
): 'stop' | 'tool_calls' | 'length' {
  if (hasToolCalls) return 'tool_calls';
  if (
    lengthCapTokens !== undefined &&
    lengthCapTokens > 0 &&
    usage !== null &&
    usage.outputTokens >= lengthCapTokens
  ) {
    return 'length';
  }
  return 'stop';
}

function toOpenAIToolCalls(
  calls: ExternalToolCall[],
): Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> {
  return calls.map((c) => ({
    id: c.id,
    type: 'function' as const,
    function: { name: c.name, arguments: c.arguments },
  }));
}

function textualToolName(body: string, allowedNames: ReadonlySet<string>): string | undefined {
  const candidates: string[] = [];
  const jsonName = body.match(/"(?:name|tool|tool_name)"\s*:\s*"((?:\\.|[^"\\])*)"/i)?.[1];
  if (jsonName !== undefined) {
    try {
      candidates.push(JSON.parse(`"${jsonName}"`) as string);
    } catch {
      /* incomplete JSON string */
    }
  }
  const patterns = [
    /<function=([a-zA-Z_][a-zA-Z0-9_.-]*)\s*>/i,
    /<invoke\s+name=["']([a-zA-Z_][a-zA-Z0-9_.-]*)["']/i,
    /(?:^|\s)call\s*:\s*([a-zA-Z_][a-zA-Z0-9_.-]*)\s*\{/i,
    /^\s*([a-zA-Z_][a-zA-Z0-9_.-]*)\s*(?:\{|<arg_key>|[a-zA-Z_]\w*\s*=)/i,
  ];
  for (const pattern of patterns) {
    const candidate = body.match(pattern)?.[1];
    if (candidate) candidates.push(candidate);
  }
  return candidates.find((candidate) => allowedNames.has(candidate));
}

function textualJsonArgumentsStart(body: string): number | undefined {
  const match = /"(?:arguments|parameters|args)"\s*:\s*/i.exec(body);
  if (!match) return undefined;
  const start = match.index + match[0].length;
  return body[start] === '{' ? start : undefined;
}

/**
 * Return the currently safe end of an object-valued JSON fragment. Before the
 * object closes every received byte belongs to the arguments value; after it
 * closes, stop before the outer tool envelope's own `}`.
 */
function streamedJsonObjectEnd(body: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < body.length; i += 1) {
    const char = body[i]!;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return body.length;
}

/**
 * Translate a single `sendAndWait` round-trip into an OpenAI chat
 * completion response. Usage tokens come from `LLMSession.onUsage`;
 * we fall back to zero when the provider doesn't emit one
 * (some local engines on short prompts).
 */
export interface RunNonStreamingOpts {
  attachments?: ImageAttachment[];
  /** Queue/cancellation context supplied by the HTTP request boundary. */
  sendOptions?: Omit<SendAndWaitOpts, 'attachments'>;
  /** Effective output-token cap — reaching it reports `finish_reason: 'length'`. */
  lengthCapTokens?: number;
}

export async function runNonStreaming(
  session: LLMSession,
  prompt: string,
  echoModel: string,
  nowSeconds: () => number,
  opts: RunNonStreamingOpts = {},
): Promise<NonStreamingChatResult> {
  const { attachments, sendOptions, lengthCapTokens } = opts;
  // Wrapped so TypeScript's control-flow narrowing doesn't infer
  // `usage` as `never` after the post-callback null check — closures
  // that assign to a captured variable confuse the analyzer.
  // See note in runStreaming about the ref wrapper.
  const usageRef: { value: TurnUsage | null } = { value: null };
  const unsubUsage = session.onUsage((u) => {
    usageRef.value = u;
  });
  try {
    const sendOpts: SendAndWaitOpts | undefined =
      sendOptions || (attachments && attachments.length > 0)
        ? {
            ...sendOptions,
            ...(attachments && attachments.length > 0 ? { attachments } : {}),
          }
        : undefined;
    const content = await session.sendAndWait(prompt, sendOpts);
    const captured = session.capturedToolCalls?.() ?? [];
    const hasToolCalls = captured.length > 0;
    return {
      id: `chatcmpl-${randomUUID()}`,
      object: 'chat.completion' as const,
      created: nowSeconds(),
      model: echoModel,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant' as const,
            content,
            ...(hasToolCalls ? { tool_calls: toOpenAIToolCalls(captured) } : {}),
          },
          finish_reason: inferFinishReason(hasToolCalls, usageRef.value, lengthCapTokens),
        },
      ],
      usage: {
        prompt_tokens: usageRef.value?.inputTokens ?? 0,
        completion_tokens: usageRef.value?.outputTokens ?? 0,
        total_tokens: (usageRef.value?.inputTokens ?? 0) + (usageRef.value?.outputTokens ?? 0),
      },
    };
  } finally {
    unsubUsage();
  }
}

/**
 * Minimal SSE-stream sink interface. Tests pass a fake that captures
 * every write; the route adapter passes Hono's `streamSSE` callback's
 * `stream`.
 */
export interface SSEWriter {
  writeSSE(message: { data: string; event?: string }): Promise<void>;
  /** Raw SSE write, used only for standards-safe `:` comment keepalives. */
  write?(input: Uint8Array | string): Promise<unknown>;
}

export interface RunStreamingOpts {
  attachments?: ImageAttachment[];
  /** Queue/cancellation context supplied by the HTTP request boundary. */
  sendOptions?: Omit<SendAndWaitOpts, 'attachments'>;
  /**
   * Forward the provider's distinct private-reasoning channel as
   * `delta.reasoning_content`. This is an opt-in compatibility extension:
   * pi understands it and renders live thinking blocks, while ordinary
   * OpenAI-compatible callers continue to receive the standard surface.
   */
  includeReasoning?: boolean;
  /**
   * Emit an SSE comment after this many milliseconds without an outbound
   * chunk. Zero/absent disables keepalives. Comments reset HTTP body-idle
   * timers but are ignored by OpenAI-compatible event parsers.
   */
  keepaliveIntervalMs?: number;
  /** Optional request-local counters for structured route diagnostics. */
  diagnostics?: StreamingDiagnostics;
  /**
   * Hide serialized `<tool_call>` envelopes from content deltas. Enable only
   * when the caller supplied tools; tool-less prompts may request the literal
   * markup as ordinary output.
   */
  suppressTextualToolCalls?: boolean;
  /**
   * OpenAI `stream_options.include_usage` semantics. When true, every
   * chunk carries `usage: null` and a dedicated final chunk (empty
   * `choices`) carries the real usage right before `[DONE]`. When
   * false/absent, no usage field appears anywhere in the stream —
   * matching OpenAI's default.
   */
  includeUsage?: boolean;
  /** Effective output-token cap — reaching it reports `finish_reason: 'length'`. */
  lengthCapTokens?: number;
  /** Mirror hooks for an externally-owned conversation ledger. */
  onContentDelta?: (content: string) => void;
  onReasoningDelta?: (content: string) => void;
  onToolArgsDelta?: (name: string, content: string) => void;
  /**
   * Forward live provider tool-argument fragments as standard streamed
   * `delta.tool_calls` chunks. The final captured calls are reconciled with
   * what was already sent so OpenAI-compatible clients do not accumulate the
   * arguments twice.
   */
  streamToolCallDeltas?: boolean;
  /** Tool names supplied by the caller; gates early textual-call detection. */
  toolCallNames?: readonly string[];
}

export interface RunStreamingResult {
  content: string;
  reasoning: string;
  toolCalls: ExternalToolCall[];
  finishReason: 'stop' | 'tool_calls' | 'length';
}

/**
 * Drive a streaming chat completion. Pipes `LLMSession.onDelta` deltas
 * out as OpenAI-shaped chunks, terminates with a final `finish_reason`
 * chunk and the sentinel `data: [DONE]`.
 *
 * The first chunk emits a `role: 'assistant'` delta with no content —
 * that's the SDK convention used by the OpenAI client to set up the
 * message role before any text arrives.
 *
 * The function awaits `sendAndWait` to know when the model is finished
 * and to read the final aggregate text. Deltas arrive via the callback;
 * we do NOT re-emit the aggregate string (would double-stream every
 * token).
 */
export async function runStreaming(
  session: LLMSession,
  prompt: string,
  echoModel: string,
  sink: SSEWriter,
  nowSeconds: () => number,
  opts: RunStreamingOpts = {},
): Promise<RunStreamingResult> {
  const {
    attachments,
    sendOptions,
    includeReasoning = false,
    keepaliveIntervalMs = 0,
    diagnostics,
    suppressTextualToolCalls = false,
    includeUsage = false,
    lengthCapTokens,
    onContentDelta,
    onReasoningDelta,
    onToolArgsDelta,
    streamToolCallDeltas = false,
    toolCallNames = [],
  } = opts;
  const id = `chatcmpl-${randomUUID()}`;
  if (diagnostics) diagnostics.responseId = id;
  const created = nowSeconds();
  let lastOutboundAtMs = Date.now();
  const recordOutbound = (kind: StreamingOutboundKind): void => {
    const atMs = Date.now();
    lastOutboundAtMs = atMs;
    noteStreamingOutbound(diagnostics, kind, atMs);
  };
  const writeSSE = async (
    message: { data: string; event?: string },
    kind: StreamingOutboundKind,
  ): Promise<void> => {
    await sink.writeSSE(message);
    recordOutbound(kind);
  };
  // Spread onto every non-final chunk when the caller opted into usage
  // reporting — OpenAI's contract is `usage: null` on all chunks except
  // the dedicated final usage chunk.
  const nullUsage = includeUsage ? { usage: null } : {};
  // Wrapped so TypeScript's control-flow narrowing doesn't infer
  // `usage` as `never` after the post-callback null check — closures
  // that assign to a captured variable confuse the analyzer.
  const usageRef: { value: TurnUsage | null } = { value: null };
  let visibleContent = '';
  let reasoningContent = '';
  interface LiveToolCall {
    index: number;
    id: string;
    name: string;
    arguments: string;
  }
  const liveToolCalls: LiveToolCall[] = [];
  let activeLiveToolCall: LiveToolCall | undefined;
  let unnamedToolArguments = '';
  const indexedUnnamedToolArguments = new Map<number, string>();
  // Provider callbacks are synchronous while Hono's stream writer is async.
  // Serialize callback-originated writes and drain them before the terminal
  // tool/finish frames so a fast provider cannot close the response ahead of
  // its final reasoning/content/tool-argument delta.
  let callbackWrites = Promise.resolve();
  const enqueueSSE = (
    message: { data: string; event?: string },
    kind: StreamingOutboundKind,
  ): void => {
    callbackWrites = callbackWrites
      .then(() => writeSSE(message, kind))
      .catch(() => {
        /* stream closed by client */
      });
  };
  const nextLiveToolIndex = (): number =>
    liveToolCalls.reduce((highest, call) => Math.max(highest, call.index), -1) + 1;
  const openLiveToolCall = (
    name: string,
    argumentsChunk: string,
    meta: { index?: number; id?: string } = {},
  ): LiveToolCall => {
    const call: LiveToolCall = {
      index: meta.index ?? nextLiveToolIndex(),
      id: meta.id ?? `call_${randomUUID()}`,
      name,
      arguments: argumentsChunk,
    };
    liveToolCalls.push(call);
    activeLiveToolCall = call;
    enqueueSSE(
      {
        data: JSON.stringify({
          id,
          object: 'chat.completion.chunk',
          created,
          model: echoModel,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: call.index,
                    id: call.id,
                    type: 'function',
                    function: { name: call.name, arguments: call.arguments },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
          ...nullUsage,
        }),
      },
      'tool_calls',
    );
    return call;
  };
  const appendLiveToolArguments = (call: LiveToolCall, chunk: string): void => {
    if (!chunk) return;
    call.arguments += chunk;
    enqueueSSE(
      {
        data: JSON.stringify({
          id,
          object: 'chat.completion.chunk',
          created,
          model: echoModel,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [{ index: call.index, function: { arguments: chunk } }],
              },
              finish_reason: null,
            },
          ],
          ...nullUsage,
        }),
      },
      'tool_calls',
    );
  };

  const allowedToolCallNames = new Set(toolCallNames);
  let textualToolBody = '';
  let textualLiveCall: LiveToolCall | undefined;
  let textualArgumentsStart: number | undefined;
  let textualArgumentsSent = 0;
  const resetTextualToolProgress = (): void => {
    textualToolBody = '';
    textualLiveCall = undefined;
    textualArgumentsStart = undefined;
    textualArgumentsSent = 0;
  };
  const toolCallFilter = suppressTextualToolCalls
    ? new ToolCallStreamFilter({
        onStart: resetTextualToolProgress,
        onBodyDelta: (chunk) => {
          if (!streamToolCallDeltas || allowedToolCallNames.size === 0) return;
          textualToolBody += chunk;
          if (!textualLiveCall) {
            const name = textualToolName(textualToolBody, allowedToolCallNames);
            if (name) textualLiveCall = openLiveToolCall(name, '');
          }
          if (!textualLiveCall) return;
          textualArgumentsStart ??= textualJsonArgumentsStart(textualToolBody);
          if (textualArgumentsStart === undefined) return;
          const safeEnd = streamedJsonObjectEnd(textualToolBody, textualArgumentsStart);
          const sentThrough = textualArgumentsStart + textualArgumentsSent;
          if (safeEnd <= sentThrough) return;
          const delta = textualToolBody.slice(sentThrough, safeEnd);
          textualArgumentsSent += delta.length;
          appendLiveToolArguments(textualLiveCall, delta);
        },
        onEnd: resetTextualToolProgress,
      })
    : null;
  const unsubUsage = session.onUsage((u) => {
    usageRef.value = u;
  });
  const unsubDelta = session.onDelta((chunk) => {
    if (!chunk) return;
    noteStreamingProviderActivity(diagnostics, 'content');
    const visibleChunk = toolCallFilter ? toolCallFilter.push(chunk) : chunk;
    if (!visibleChunk) return;
    visibleContent += visibleChunk;
    onContentDelta?.(visibleChunk);
    // The callback is synchronous; enqueueSSE serializes the async writes.
    enqueueSSE(
      {
        data: JSON.stringify({
          id,
          object: 'chat.completion.chunk',
          created,
          model: echoModel,
          choices: [
            {
              index: 0,
              delta: { content: visibleChunk },
              finish_reason: null,
            },
          ],
          ...nullUsage,
        }),
      },
      'content',
    );
  });
  const unsubReasoning =
    includeReasoning || diagnostics || onReasoningDelta
      ? session.onReasoningDelta?.((chunk) => {
          if (!chunk) return;
          noteStreamingProviderActivity(diagnostics, 'reasoning');
          reasoningContent += chunk;
          onReasoningDelta?.(chunk);
          if (!includeReasoning) return;
          // pi's OpenAI-completions adapter recognizes reasoning_content and
          // turns it into a separate thinking_delta. Never fold this into
          // `content`: it must not enter the visible assistant reply or the
          // textual tool-call filter.
          enqueueSSE(
            {
              data: JSON.stringify({
                id,
                object: 'chat.completion.chunk',
                created,
                model: echoModel,
                choices: [
                  {
                    index: 0,
                    delta: { reasoning_content: chunk },
                    finish_reason: null,
                  },
                ],
                ...nullUsage,
              }),
            },
            'reasoning',
          );
        })
      : undefined;
  const unsubToolArgs =
    diagnostics || onToolArgsDelta || streamToolCallDeltas
      ? session.onToolArgsDelta?.((name, chunk, meta) => {
          if (name || chunk) {
            noteStreamingProviderActivity(diagnostics, 'tool_arguments');
            onToolArgsDelta?.(name, chunk);
          }
          if (!streamToolCallDeltas || (!name && !chunk)) return;

          const indexedCall =
            meta?.index !== undefined
              ? liveToolCalls.find((call) => call.index === meta.index)
              : undefined;

          if (!name && !indexedCall) {
            // A few compatible servers put argument bytes in the chunk before
            // the first fragment carrying function.name. Hold those bytes
            // until the call can be announced in a schema-valid frame.
            if (meta?.index !== undefined) {
              indexedUnnamedToolArguments.set(
                meta.index,
                (indexedUnnamedToolArguments.get(meta.index) ?? '') + chunk,
              );
            } else {
              unnamedToolArguments += chunk;
            }
            return;
          }

          const continuedCall =
            indexedCall ??
            (meta?.index === undefined && activeLiveToolCall?.name === name
              ? activeLiveToolCall
              : undefined);
          if (!continuedCall) {
            const index = meta?.index ?? nextLiveToolIndex();
            const buffered = (indexedUnnamedToolArguments.get(index) ?? '') + unnamedToolArguments;
            indexedUnnamedToolArguments.delete(index);
            unnamedToolArguments = '';
            openLiveToolCall(name, buffered + chunk, {
              index,
              ...(meta?.id ? { id: meta.id } : {}),
            });
            return;
          }

          activeLiveToolCall = continuedCall;
          appendLiveToolArguments(activeLiveToolCall, chunk);
        })
      : undefined;
  const unsubWirePulse = diagnostics
    ? session.onWirePulse?.(() => noteStreamingProviderActivity(diagnostics, 'wire_pulse'))
    : undefined;
  const unsubHeartbeat = diagnostics
    ? session.onHeartbeat?.(() => noteStreamingProviderActivity(diagnostics, 'heartbeat'))
    : undefined;

  let keepaliveTimer: NodeJS.Timeout | undefined;
  let keepaliveWriteInFlight = false;
  const startKeepalives = (): void => {
    const writeRaw = sink.write?.bind(sink);
    if (keepaliveIntervalMs <= 0 || !writeRaw) return;
    keepaliveTimer = setInterval(() => {
      if (keepaliveWriteInFlight || Date.now() - lastOutboundAtMs < keepaliveIntervalMs) return;
      keepaliveWriteInFlight = true;
      void writeRaw(': keepalive\n\n')
        .then(() => recordOutbound('keepalive'))
        .catch(() => {
          /* stream closed by client */
        })
        .finally(() => {
          keepaliveWriteInFlight = false;
        });
    }, keepaliveIntervalMs);
    keepaliveTimer.unref?.();
  };

  try {
    // Opening chunk announces the assistant role with empty content.
    // OpenAI's SDK uses this to initialize its accumulated message.
    await writeSSE(
      {
        data: JSON.stringify({
          id,
          object: 'chat.completion.chunk',
          created,
          model: echoModel,
          choices: [
            {
              index: 0,
              delta: { role: 'assistant', content: '' },
              finish_reason: null,
            },
          ],
          ...nullUsage,
        }),
      },
      'opener',
    );
    startKeepalives();

    const sendOpts: SendAndWaitOpts | undefined =
      sendOptions || (attachments && attachments.length > 0)
        ? {
            ...sendOptions,
            ...(attachments && attachments.length > 0 ? { attachments } : {}),
          }
        : undefined;
    await session.sendAndWait(prompt, sendOpts);
    await callbackWrites;

    // A marker-like prefix is held across chunks so split tags cannot leak.
    // Once generation ends, release any tail that proved to be ordinary text.
    const trailingContent = toolCallFilter?.flush() ?? '';
    if (trailingContent) {
      visibleContent += trailingContent;
      onContentDelta?.(trailingContent);
      await writeSSE(
        {
          data: JSON.stringify({
            id,
            object: 'chat.completion.chunk',
            created,
            model: echoModel,
            choices: [
              {
                index: 0,
                delta: { content: trailingContent },
                finish_reason: null,
              },
            ],
            ...nullUsage,
          }),
        },
        'content',
      );
    }

    const captured = session.capturedToolCalls?.() ?? [];
    if (diagnostics) diagnostics.capturedToolCalls = captured.length;
    const hasToolCalls = captured.length > 0;

    if (hasToolCalls) {
      if (!streamToolCallDeltas || liveToolCalls.length === 0) {
        // Providers without a live tool-arguments channel retain the ordinary
        // single full-call chunk.
        await writeSSE(
          {
            data: JSON.stringify({
              id,
              object: 'chat.completion.chunk',
              created,
              model: echoModel,
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: captured.map((c, i) => ({
                      index: i,
                      id: c.id,
                      type: 'function',
                      function: { name: c.name, arguments: c.arguments },
                    })),
                  },
                  finish_reason: null,
                },
              ],
              ...nullUsage,
            }),
          },
          'tool_calls',
        );
      } else {
        // Match the provider's authoritative captured calls to the live
        // streams by provider id when available, then by tool name. Send only
        // any suffix that did not arrive live; never replay the complete
        // arguments, which would make clients concatenate invalid JSON.
        const matchedLive = new Set<LiveToolCall>();
        for (const call of captured) {
          const live = liveToolCalls.find(
            (candidate) =>
              !matchedLive.has(candidate) &&
              (candidate.id === call.id || candidate.name === call.name),
          );
          if (!live) {
            const index =
              liveToolCalls.reduce((highest, candidate) => Math.max(highest, candidate.index), -1) +
              1;
            liveToolCalls.push({
              index,
              id: call.id,
              name: call.name,
              arguments: call.arguments,
            });
            await writeSSE(
              {
                data: JSON.stringify({
                  id,
                  object: 'chat.completion.chunk',
                  created,
                  model: echoModel,
                  choices: [
                    {
                      index: 0,
                      delta: {
                        tool_calls: [
                          {
                            index,
                            id: call.id,
                            type: 'function',
                            function: { name: call.name, arguments: call.arguments },
                          },
                        ],
                      },
                      finish_reason: null,
                    },
                  ],
                  ...nullUsage,
                }),
              },
              'tool_calls',
            );
            continue;
          }

          matchedLive.add(live);
          if (call.arguments.startsWith(live.arguments)) {
            const suffix = call.arguments.slice(live.arguments.length);
            if (suffix) {
              live.arguments += suffix;
              await writeSSE(
                {
                  data: JSON.stringify({
                    id,
                    object: 'chat.completion.chunk',
                    created,
                    model: echoModel,
                    choices: [
                      {
                        index: 0,
                        delta: {
                          tool_calls: [
                            {
                              index: live.index,
                              function: { arguments: suffix },
                            },
                          ],
                        },
                        finish_reason: null,
                      },
                    ],
                    ...nullUsage,
                  }),
                },
                'tool_calls',
              );
            }
          }
        }
      }
    }

    // Final content chunk: finish_reason=stop (or tool_calls).
    const finishReason = inferFinishReason(hasToolCalls, usageRef.value, lengthCapTokens);
    await writeSSE(
      {
        data: JSON.stringify({
          id,
          object: 'chat.completion.chunk',
          created,
          model: echoModel,
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: finishReason,
            },
          ],
          ...nullUsage,
        }),
      },
      'finish',
    );
    if (includeUsage) {
      // Dedicated usage chunk per OpenAI's stream_options contract:
      // empty choices, real usage, right before [DONE]. Zero-fallback
      // when the provider never emitted usage (some local engines on
      // short prompts) — the field must be present once requested.
      await writeSSE(
        {
          data: JSON.stringify({
            id,
            object: 'chat.completion.chunk',
            created,
            model: echoModel,
            choices: [],
            usage: {
              prompt_tokens: usageRef.value?.inputTokens ?? 0,
              completion_tokens: usageRef.value?.outputTokens ?? 0,
              total_tokens:
                (usageRef.value?.inputTokens ?? 0) + (usageRef.value?.outputTokens ?? 0),
            },
          }),
        },
        'usage',
      );
    }
    await writeSSE({ data: '[DONE]' }, 'done');
    return {
      content: visibleContent,
      reasoning: reasoningContent,
      toolCalls: captured,
      finishReason,
    };
  } finally {
    if (keepaliveTimer) clearInterval(keepaliveTimer);
    unsubHeartbeat?.();
    unsubWirePulse?.();
    unsubToolArgs?.();
    unsubReasoning?.();
    unsubDelta();
    unsubUsage();
  }
}
