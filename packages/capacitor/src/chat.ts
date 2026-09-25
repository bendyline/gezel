import { type ChatRequest, GezelSdkError } from '@bendyline/gezel-app-sdk/browser';
import type { PortableInference } from '@bendyline/gezel/mobile-inference';
import { resolveMobileInferenceBudget } from '@bendyline/gezel/mobile-providers';
import { requireModel } from './models.js';

const unsupported = () =>
  new GezelSdkError('The native text runtime does not support this request option', {
    code: 'unsupported_capability',
  });

export async function prepareChat(inference: PortableInference, input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new GezelSdkError('A chat request is required', { code: 'invalid_request' });
  const request = input as ChatRequest;
  // Reject rather than silently ignoring unsupported model controls or modalities.
  if (
    Object.keys(input).some((key) => !['model', 'messages', 'stream', 'max_tokens'].includes(key))
  )
    throw unsupported();
  if (
    typeof request.model !== 'string' ||
    (request.stream !== undefined && typeof request.stream !== 'boolean')
  )
    throw new GezelSdkError('Invalid model or stream option', { code: 'invalid_request' });
  if (
    request.max_tokens !== undefined &&
    (!Number.isInteger(request.max_tokens) || request.max_tokens < 1)
  )
    throw new GezelSdkError('max_tokens must be a positive integer', { code: 'invalid_request' });
  if (!Array.isArray(request.messages) || !request.messages.length || request.messages.length > 128)
    throw new GezelSdkError('Use 1–128 messages', { code: 'invalid_request' });
  let bytes = 0;
  const messages = request.messages.map((message, index) => {
    if (
      !message ||
      !['system', 'user', 'assistant'].includes(message.role) ||
      typeof message.content !== 'string' ||
      Object.keys(message).some((key) => !['role', 'content'].includes(key))
    )
      throw unsupported();
    if (
      (message.role === 'system' && index !== 0) ||
      message.content.includes('\0') ||
      message.content.length > 64_000
    )
      throw new GezelSdkError('Invalid conversation', { code: 'invalid_request' });
    bytes += new TextEncoder().encode(message.content).byteLength;
    return { role: message.role as 'system' | 'user' | 'assistant', content: message.content };
  });
  if (bytes > 256 * 1024 || messages.at(-1)?.role !== 'user')
    throw new GezelSdkError('Conversation exceeds the native text contract', {
      code: 'invalid_request',
    });
  const { provider, ...identity } = await requireModel(inference, request.model);
  let budget: ReturnType<typeof resolveMobileInferenceBudget>;
  try {
    budget = resolveMobileInferenceBudget(
      provider,
      request.max_tokens === undefined ? undefined : { maxTokens: request.max_tokens },
    );
  } catch (cause) {
    throw new GezelSdkError('Token budget is outside the provider limits', {
      code: 'invalid_request',
      cause,
    });
  }
  return { request, native: { ...identity, ...budget, messages } };
}
