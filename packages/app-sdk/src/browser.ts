/**
 * `@bendyline/gezel-app-sdk/browser` — browser entry.
 *
 * Browsers can't read `~/.gezel/runtime/` and can't speak to the
 * loopback HTTPS server without a trust anchor anyway, so the browser
 * variant requires the app to supply both `baseUrl` and an existing
 * `token`. The {@link connect} flow with an `existingToken` still
 * works in the browser; full discovery+consent does not.
 *
 * Apps that ship as a browser frontend with a desktop helper should
 * have the helper do the discovery + consent (using the Node entry)
 * and pass the resolved `baseUrl + token` into the browser via
 * postMessage / config.
 */
export { GezelApp } from './client.js';
export { GezelSdkError } from './errors.js';
export type {
  AuthorizedConnection,
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
