import type { EmbeddingConnection } from './embedding.js';
import { GezelSdkError } from './errors.js';
import { type KnowledgeContextOptions, withKnowledgeContext } from './knowledge-context.js';
import { notify, sdkError } from './model-manager.js';
import type {
  AppChatProgress,
  ChatCompletionResponse,
  ChatMessage,
  RequestOptions,
} from './types.js';

export interface TextRequest {
  model: string;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  reasoningEffort?: string;
  knowledge?: Omit<KnowledgeContextOptions, 'signal'>;
}
export type TextEvent =
  | { type: 'delta'; text: string }
  | { type: 'progress'; progress: AppChatProgress }
  | {
      type: 'done';
      text: string;
      cancelled: boolean;
      finishReason: string | null;
      model: string;
      usage: ChatCompletionResponse['usage'] | null;
    }
  | { type: 'error'; error: GezelSdkError };
export interface TextOptions extends RequestOptions {
  onEvent?(event: TextEvent): void;
  maxCharacters?: number;
}

/** A single terminal outcome even when observers throw or a provider aborts. */
export async function streamEmbeddingText(
  run: <T>(
    signal: AbortSignal | undefined,
    action: (connection: EmbeddingConnection, signal: AbortSignal) => Promise<T>,
  ) => Promise<T>,
  request: TextRequest,
  options: TextOptions,
): Promise<Extract<TextEvent, { type: 'done' }>> {
  let text = '';
  let finishReason: string | null = null;
  let model = request.model;
  let usage: ChatCompletionResponse['usage'] | null = null;
  const done = (cancelled: boolean): Extract<TextEvent, { type: 'done' }> => ({
    type: 'done',
    text,
    cancelled,
    finishReason,
    model,
    usage,
  });
  try {
    const limit = options.maxCharacters ?? 4 * 1024 * 1024;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 4 * 1024 * 1024)
      throw new GezelSdkError('Invalid text size limit', { code: 'invalid_request' });
    await run(options.signal, async (connection, signal) => {
      const selected = await connection.models.inspect(request.model, { signal });
      if (!selected || selected.availability !== 'available')
        throw new GezelSdkError(selected?.unavailable_reason ?? 'The selected model is not ready', {
          code: selected?.reason_code ?? 'model_not_ready',
        });
      for (const [name, value] of [
        ['temperature', request.temperature],
        ['reasoning_effort', request.reasoningEffort],
      ] as const) {
        if (
          value !== undefined &&
          selected.supported_options &&
          !selected.supported_options.includes(name)
        )
          throw new GezelSdkError(`The selected model does not accept ${name}`, {
            code: 'unsupported_option',
          });
      }
      const messages = request.knowledge
        ? await withKnowledgeContext(connection.knowledge, request.messages, {
            ...request.knowledge,
            signal,
          })
        : request.messages;
      const stream = await connection.app.chat(
        {
          model: selected.id,
          messages,
          stream: true,
          stream_options: { include_usage: true, include_progress: true },
          ...(request.maxTokens === undefined ? {} : { max_tokens: request.maxTokens }),
          ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
          ...(request.reasoningEffort === undefined
            ? {}
            : { reasoning_effort: request.reasoningEffort }),
        },
        { signal },
      );
      for await (const chunk of stream) {
        signal.throwIfAborted();
        if (chunk.gezel_progress)
          notify(options.onEvent, { type: 'progress', progress: chunk.gezel_progress });
        if (typeof chunk.model === 'string' && chunk.model) model = chunk.model;
        if (chunk.usage) usage = chunk.usage;
        const choice = chunk.choices[0];
        const delta = choice?.delta.content;
        if (delta) {
          if (text.length + delta.length > limit)
            throw new GezelSdkError('Response exceeds its size limit', {
              code: 'response_too_large',
            });
          text += delta;
          notify(options.onEvent, { type: 'delta', text: delta });
        }
        if (choice?.finish_reason) finishReason = choice.finish_reason;
      }
      signal.throwIfAborted();
      if (!finishReason)
        throw new GezelSdkError('Chat stream ended without a finish reason', {
          code: 'incomplete_stream',
        });
    });
    const result = done(finishReason === 'cancelled');
    notify(options.onEvent, result);
    return result;
  } catch (error) {
    const normalized = sdkError(error);
    if (normalized.code === 'aborted') {
      const result = done(true);
      notify(options.onEvent, result);
      return result;
    }
    notify(options.onEvent, { type: 'error', error: normalized });
    throw normalized;
  }
}
