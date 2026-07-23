/**
 * `@bendyline/gezel-app-sdk` — Node entry.
 *
 * Build a third-party app against gezel's OpenAI-compatible `/v1/*`
 * surface. Discovers a running daemon at `~/.gezel/runtime/`, opens a
 * consent grant, and returns a {@link GezelApp} with `chat`,
 * `embeddings`, `models`, and `ensureModel`.
 *
 * Quickstart:
 *
 *   import { detectGezel, connect } from '@bendyline/gezel-app-sdk';
 *
 *   const status = await detectGezel();
 *   if (!status.running) throw new Error('start gezel first');
 *
 *   const app = await connect({
 *     appId: 'docblocks',
 *     appName: 'DocBlocks',
 *     scopes: ['openai'],
 *     tokenStorage: {
 *       async save(id, token) { await keychain.set(id, token); },
 *       async load(id) { return await keychain.get(id); },
 *     },
 *   });
 *
 *   const ensure = await app.ensureModel({ model: 'llama-cpp:qwen3-4b-instruct-q4_k_m' });
 *   if (ensure.status === 'downloading') {
 *     for await (const ev of app.streamEnsureEvents(ensure.job_id!)) {
 *       if (ev.type === 'progress') console.log(`${ev.bytesWritten}/${ev.totalBytes}`);
 *     }
 *   }
 *
 *   const stream = await app.chat({
 *     model: 'llama-cpp:qwen3-4b-instruct-q4_k_m',
 *     messages: [{ role: 'user', content: 'Hello' }],
 *     stream: true,
 *   });
 *   for await (const chunk of stream) {
 *     process.stdout.write(chunk.choices[0]?.delta?.content ?? '');
 *   }
 */
export { detectGezel } from './detect.js';
export { connect } from './connect.js';
export { GezelApp } from './client.js';
export { GezelSdkError } from './errors.js';
export {
  createTrustingFetch,
  createPatientFetch,
} from './tls.js';
export type {
  DetectResult,
  ConnectInput,
  ChatMessage,
  ChatMessageContent,
  ChatMessageRole,
  ChatRequest,
  ChatTool,
  ChatToolCall,
  ChatCompletionResponse,
  ChatCompletionChunk,
  ChatStream,
  ModelListEntry,
  ModelListResponse,
  EnsureModelInput,
  EnsureModelResult,
  EnsureModelEvent,
  EmbeddingsRequest,
  EmbeddingsResponse,
  SdkError,
} from './types.js';
