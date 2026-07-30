import { GezelSdkError, errorFromResponse } from './errors.js';
import { readSseDataChunks } from './sse.js';
import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ChatRequest,
  ChatStream,
  EmbeddingsRequest,
  EmbeddingsResponse,
  EnsureModelEvent,
  EnsureModelInput,
  EnsureModelResult,
  ModelListResponse,
} from './types.js';

export interface GezelAppOptions {
  baseUrl: string;
  token: string;
  fetch: typeof fetch;
}

/**
 * A connected, scoped client for a third-party app to talk to gezel's
 * OpenAI-compatible `/v1/*` surface. Returned from {@link connect}; can
 * also be instantiated directly when the app has already stored a
 * baseUrl + token from a previous run.
 *
 * Lifecycle: stateless. Every method does its own HTTP request and
 * cleans up. No `close()` is required — the underlying fetch agent
 * stays alive as long as the host process does.
 */
export class GezelApp {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchFn: typeof fetch;

  constructor(opts: GezelAppOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.token = opts.token;
    this.fetchFn = opts.fetch;
  }

  /**
   * One chat turn.
   *
   *   const resp = await app.chat({
   *     model: 'llama-cpp:qwen3-4b',
   *     messages: [{role: 'user', content: 'hi'}],
   *   });
   *   console.log(resp.choices[0].message.content);
   *
   * For streaming:
   *
   *   const stream = await app.chat({ ..., stream: true });
   *   for await (const chunk of stream) {
   *     process.stdout.write(chunk.choices[0]?.delta?.content ?? '');
   *   }
   */
  async chat(req: ChatRequest & { stream: true }): Promise<ChatStream>;
  async chat(req: ChatRequest & { stream?: false | undefined }): Promise<ChatCompletionResponse>;
  async chat(req: ChatRequest): Promise<ChatCompletionResponse | ChatStream>;
  async chat(req: ChatRequest): Promise<ChatCompletionResponse | ChatStream> {
    const res = await this.fetchFn(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.token}`,
        ...(req.stream ? { Accept: 'text/event-stream' } : {}),
      },
      body: JSON.stringify(req),
    });

    if (!res.ok) {
      throw await errorFromResponse(res);
    }

    if (req.stream === true) {
      if (!res.body) {
        throw new GezelSdkError('streaming response had no body', {
          code: 'no_stream_body',
        });
      }
      return parseChatStream(res.body);
    }

    return (await res.json()) as ChatCompletionResponse;
  }

  /**
   * Generate embeddings for `input` (single string or batch). Returns
   * vectors in caller order plus token usage. Providers that don't
   * implement embeddings (most local engines today) fail with a
   * `GezelSdkError` carrying `code: 'embeddings_not_supported'`.
   */
  async embeddings(req: EmbeddingsRequest): Promise<EmbeddingsResponse> {
    const res = await this.fetchFn(`${this.baseUrl}/v1/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify(req),
    });
    if (!res.ok) throw await errorFromResponse(res);
    return (await res.json()) as EmbeddingsResponse;
  }

  /** List selectable gezels plus models across every configured provider. */
  async models(): Promise<ModelListResponse> {
    const res = await this.fetchFn(`${this.baseUrl}/v1/models`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) throw await errorFromResponse(res);
    return (await res.json()) as ModelListResponse;
  }

  /**
   * Make sure a local model is downloaded and ready. Returns
   * immediately on the `ready` branch; for downloads, returns a
   * `job_id` the caller can poll or stream events from.
   */
  async ensureModel(input: EnsureModelInput): Promise<EnsureModelResult> {
    const res = await this.fetchFn(`${this.baseUrl}/v1/models/ensure`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify({ model: input.model }),
    });
    if (!res.ok) throw await errorFromResponse(res);
    return (await res.json()) as EnsureModelResult;
  }

  /**
   * SSE companion to {@link ensureModel}. Yields every event the
   * orchestrator emits until the install hits a terminal `done` or
   * `error`.
   */
  async *streamEnsureEvents(jobId: string): AsyncIterable<EnsureModelEvent> {
    const res = await this.fetchFn(
      `${this.baseUrl}/v1/models/ensure/${encodeURIComponent(jobId)}/events`,
      { headers: { Authorization: `Bearer ${this.token}` } },
    );
    if (!res.ok) throw await errorFromResponse(res);
    if (!res.body) {
      throw new GezelSdkError('ensure-events stream had no body', {
        code: 'no_stream_body',
      });
    }
    for await (const chunk of readSseDataChunks(res.body)) {
      // Keepalive frames carry `event: ping` and an empty data — our
      // SSE reader only yields `data:` payloads, so an empty string
      // is the ping signal. Skip.
      if (!chunk || chunk === '[DONE]') continue;
      let event: EnsureModelEvent;
      try {
        event = JSON.parse(chunk) as EnsureModelEvent;
      } catch {
        continue;
      }
      yield event;
      if (event.type === 'done' || event.type === 'error') return;
    }
  }

  /**
   * Self-revoke the app's token. After this returns, the app's stored
   * token will fail authorization. Call {@link connect} again to
   * re-register and get a fresh token (the user is prompted again).
   */
  async revokeMyToken(appId: string): Promise<void> {
    const res = await this.fetchFn(`${this.baseUrl}/v1/apps/${encodeURIComponent(appId)}/token`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) throw await errorFromResponse(res);
  }
}

async function* parseChatStream(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<ChatCompletionChunk> {
  for await (const chunk of readSseDataChunks(body)) {
    if (!chunk) continue;
    if (chunk === '[DONE]') return;
    let parsed: ChatCompletionChunk | { error: { message: string; code?: string } };
    try {
      parsed = JSON.parse(chunk) as
        | ChatCompletionChunk
        | {
            error: { message: string; code?: string };
          };
    } catch {
      continue;
    }
    // Errors mid-stream arrive as `data: {error: {...}}`. Surface as
    // an exception so the consumer's `for await` rejects, matching
    // the OpenAI SDK's behavior.
    if ('error' in parsed) {
      throw new GezelSdkError(parsed.error.message, {
        ...(parsed.error.code ? { code: parsed.error.code } : {}),
      });
    }
    yield parsed;
  }
}
