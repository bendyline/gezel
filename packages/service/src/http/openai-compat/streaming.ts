import { randomUUID } from 'node:crypto';
import type {
  ExternalToolCall,
  ImageAttachment,
  LLMSession,
  TurnUsage,
} from '../../providers/types.js';

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

/**
 * Translate a single `sendAndWait` round-trip into an OpenAI chat
 * completion response. Usage tokens come from `LLMSession.onUsage`;
 * we fall back to zero when the provider doesn't emit one
 * (some local engines on short prompts).
 */
export interface RunNonStreamingOpts {
  attachments?: ImageAttachment[];
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
  const { attachments, lengthCapTokens } = opts;
  // Wrapped so TypeScript's control-flow narrowing doesn't infer
  // `usage` as `never` after the post-callback null check — closures
  // that assign to a captured variable confuse the analyzer.
  // See note in runStreaming about the ref wrapper.
  const usageRef: { value: TurnUsage | null } = { value: null };
  const unsubUsage = session.onUsage((u) => {
    usageRef.value = u;
  });
  try {
    const sendOpts = attachments && attachments.length > 0 ? { attachments } : undefined;
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
}

export interface RunStreamingOpts {
  attachments?: ImageAttachment[];
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
): Promise<void> {
  const { attachments, includeUsage = false, lengthCapTokens } = opts;
  const id = `chatcmpl-${randomUUID()}`;
  const created = nowSeconds();
  // Spread onto every non-final chunk when the caller opted into usage
  // reporting — OpenAI's contract is `usage: null` on all chunks except
  // the dedicated final usage chunk.
  const nullUsage = includeUsage ? { usage: null } : {};
  // Wrapped so TypeScript's control-flow narrowing doesn't infer
  // `usage` as `never` after the post-callback null check — closures
  // that assign to a captured variable confuse the analyzer.
  const usageRef: { value: TurnUsage | null } = { value: null };
  const unsubUsage = session.onUsage((u) => {
    usageRef.value = u;
  });
  const unsubDelta = session.onDelta((chunk) => {
    if (!chunk) return;
    // Fire-and-forget: SSE writes are async but we can't await inside
    // a synchronous callback. Order is preserved because every write
    // serializes through the underlying stream's queue. Errors close
    // the stream — caught at the route level.
    void sink
      .writeSSE({
        data: JSON.stringify({
          id,
          object: 'chat.completion.chunk',
          created,
          model: echoModel,
          choices: [
            {
              index: 0,
              delta: { content: chunk },
              finish_reason: null,
            },
          ],
          ...nullUsage,
        }),
      })
      .catch(() => {
        /* stream closed by client */
      });
  });

  try {
    // Opening chunk announces the assistant role with empty content.
    // OpenAI's SDK uses this to initialize its accumulated message.
    await sink.writeSSE({
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
    });

    const sendOpts = attachments && attachments.length > 0 ? { attachments } : undefined;
    await session.sendAndWait(prompt, sendOpts);

    const captured = session.capturedToolCalls?.() ?? [];
    const hasToolCalls = captured.length > 0;

    if (hasToolCalls) {
      // Emit the full tool_calls payload as a single delta chunk so
      // OpenAI SDKs accumulate it correctly. Each call gets `index: i`
      // per the streaming spec.
      await sink.writeSSE({
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
      });
    }

    // Final content chunk: finish_reason=stop (or tool_calls).
    await sink.writeSSE({
      data: JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created,
        model: echoModel,
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: inferFinishReason(hasToolCalls, usageRef.value, lengthCapTokens),
          },
        ],
        ...nullUsage,
      }),
    });
    if (includeUsage) {
      // Dedicated usage chunk per OpenAI's stream_options contract:
      // empty choices, real usage, right before [DONE]. Zero-fallback
      // when the provider never emitted usage (some local engines on
      // short prompts) — the field must be present once requested.
      await sink.writeSSE({
        data: JSON.stringify({
          id,
          object: 'chat.completion.chunk',
          created,
          model: echoModel,
          choices: [],
          usage: {
            prompt_tokens: usageRef.value?.inputTokens ?? 0,
            completion_tokens: usageRef.value?.outputTokens ?? 0,
            total_tokens: (usageRef.value?.inputTokens ?? 0) + (usageRef.value?.outputTokens ?? 0),
          },
        }),
      });
    }
    await sink.writeSSE({ data: '[DONE]' });
  } finally {
    unsubDelta();
    unsubUsage();
  }
}
