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
 *
 * `registerAppTools` is here too: it needs only fetch and streams, so a
 * renderer that holds a `product` token can offer tools of its own (the
 * Office task pane registers its document tools this way).
 */
export { registerAppTools } from './app-tools.js';
export { GezelApp } from './client.js';
export { GezelSdkError } from './errors.js';
export type {
  AppToolCallContext,
  AppToolDefinition,
  AppToolHandlerResult,
  AppToolsRegistration,
  RegisterAppToolsInput,
  AuthorizedConnection,
  ChatCompletionChunk,
  ChatCompletionResponse,
  ChatMessage,
  ChatMessageContent,
  ChatMessageRole,
  ChatRequest,
  ChatStream,
  ChatTool,
  ChatToolCall,
  ConnectInput,
  EmbeddingsRequest,
  EmbeddingsResponse,
  EnsureModelEvent,
  EnsureModelInput,
  EnsureModelResult,
  ModelListEntry,
  ModelListResponse,
  RequestOptions,
  SdkError,
} from './types.js';

export type {
  ChatResponseFormat,
  PortableFinishReason,
  PortableChatCompletionResponse,
  PortableChatCompletionChunk,
  ChatResponseFor,
  ChatStreamFor,
} from './types.js';
