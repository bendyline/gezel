import { GezelSdkError } from '@bendyline/gezel-app-sdk/browser';
import type { PortableInference } from '@bendyline/gezel/mobile-inference';
import type { prepareChat } from './chat.js';

/** Use the same model template/parser as desktop when the native host supports it. */
export async function generateText(
  inference: PortableInference,
  prepared: Awaited<ReturnType<typeof prepareChat>>,
  requestId: string,
  onDelta: Parameters<PortableInference['generate']>[1],
  hooks: Parameters<PortableInference['generate']>[3],
): ReturnType<PortableInference['generate']> {
  const { native, request } = prepared;
  if (!prepared.structuredChat)
    return inference.generate({ requestId, ...native }, onDelta, undefined, hooks);
  let text = '';
  let size = 0;
  let finish: 'stop' | 'length' | undefined;
  let failure: GezelSdkError | undefined;
  const reject = (message: string, code = 'native_protocol') => {
    if (failure) return;
    failure = new GezelSdkError(message, { code });
    void inference.cancel(requestId).catch(() => {});
  };
  const result = await inference.chat!(
    {
      requestId,
      providerId: 'llama-cpp',
      modelId: native.modelId,
      contextSize: native.contextSize,
      body: {
        model: request.model,
        messages: native.messages,
        stream: true,
        max_tokens: native.maxTokens,
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
        ...(request.reasoning_effort === undefined
          ? {}
          : { reasoning_effort: request.reasoning_effort }),
      },
    },
    (chunk) => {
      if (failure) return;
      size += JSON.stringify(chunk).length;
      if (size > 4 * 1024 * 1024) {
        reject('Native response exceeded the consumer buffer', 'resource_limit');
        return;
      }
      if (chunk.error) {
        const error = chunk.error;
        reject(
          typeof error === 'object' && 'message' in error && typeof error.message === 'string'
            ? error.message
            : 'Native chat failed',
          'native_error',
        );
        return;
      }
      if (!Array.isArray(chunk.choices)) {
        reject('Invalid native chat choices');
        return;
      }
      for (const choice of chunk.choices) {
        if (
          !choice ||
          typeof choice !== 'object' ||
          choice.index !== 0 ||
          !choice.delta ||
          typeof choice.delta !== 'object'
        ) {
          reject('Invalid native chat delta');
          return;
        }
        if (choice.delta.tool_calls) {
          reject('Unexpected native tool call');
          return;
        }
        const content = choice.delta.content;
        if (content !== undefined && content !== null) {
          if (typeof content !== 'string' || finish) {
            reject('Invalid native answer content');
            return;
          }
          text += content;
          if (content) onDelta({ requestId, delta: content });
        }
        if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
          if (finish || !['stop', 'length'].includes(choice.finish_reason)) {
            reject('Invalid native finish reason');
            return;
          }
          finish = choice.finish_reason;
        }
      }
    },
    hooks,
  );
  if (failure) throw failure;
  if (result.status === 'cancelled') return { text, stopReason: 'cancelled' };
  if (result.status !== 'ok' || !finish)
    throw new GezelSdkError('Native chat ended without a complete response', {
      code: result.status === 'timeout' ? 'timeout' : 'native_protocol',
    });
  return { text, stopReason: finish };
}
