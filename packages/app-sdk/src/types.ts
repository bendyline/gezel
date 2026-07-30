/**
 * Narrow type definitions for the public SDK. These intentionally
 * mirror the OpenAI Chat Completions API shape (with a few gezel-
 * specific extensions for ensure-model) so that an app written
 * against `@bendyline/gezel-app-sdk` can swap to any OpenAI-compatible
 * backend with minimal code changes.
 *
 * We deliberately do NOT import from `@bendyline/gezel` — pulling the
 * full internal contract into every consumer would lock us into
 * maintaining that contract publicly. The shapes here are stable.
 */

export interface DetectResult {
  /**
   * The daemon has been launched at least once on this machine and
   * wrote runtime files to `~/.gezel/runtime/`. The runtime files
   * are NOT proof that the daemon is currently up — that's `running`.
   */
  installed: boolean;
  /**
   * Health probe succeeded — the daemon is up right now.
   */
  running: boolean;
  /**
   * Base URL the daemon is listening on (e.g. `https://127.0.0.1:54321`).
   * Present when the runtime files exist, regardless of `running`.
   */
  baseUrl?: string;
  /**
   * The root bearer token from `~/.gezel/runtime/auth-token`. Apps
   * SHOULD NOT use this; it's surfaced so dev/debug tools can talk to
   * the daemon as root. Public app integrations register via
   * {@link connect} instead, getting a per-app scoped token.
   */
  rootToken?: string;
  /** Daemon version (semver) when health probe succeeded. */
  version?: string;
}

export interface ConnectInput {
  /**
   * Stable identifier the user sees in Settings → Connected Apps. Lowercase
   * letters / digits / `._-`, 1–64 chars. Pick something unique to your
   * app — e.g. `docblocks`, `acme.notes`.
   */
  appId: string;
  /** Display name shown in the consent dialog and Settings list. */
  appName: string;
  /**
   * The scope set you're asking for. For OpenAI-shaped chat /
   * embeddings / models / ensure, request `['openai']`. External clients
   * that use ordinary Gezel product APIs request `['product']`; the Gezel CLI
   * requests `['cli']`. Both stateful scopes trigger the requester-visible
   * code handshake. Third-party apps should request the narrowest available
   * scope.
   */
  scopes: string[];
  /**
   * Require the daemon-generated connection-code step even when all requested
   * scopes are inference-only. Useful for first-party clients such as the
   * VS Code extension that want stronger proof of user intent without asking
   * for broader authority.
   */
  requireVerificationCode?: boolean;
  /** Optional icon URL surfaced in the consent dialog. */
  iconUrl?: string;
  /**
   * Explicit base URL override. When omitted, the SDK runs
   * {@link DetectResult.baseUrl}. Useful for browser apps that can't
   * read `~/.gezel/runtime/`.
   */
  baseUrl?: string;
  /**
   * Pre-existing token to reuse instead of running the register +
   * grant-poll handshake. When set, the SDK skips registration and
   * goes straight to `chat`/`models`/`ensure`. Useful for apps that
   * already persisted the token from a prior session.
   */
  existingToken?: string;
  /**
   * Persistence hooks for the issued token. The SDK calls
   * `save(appId, token)` on successful approval; subsequent runs
   * should call `connect({existingToken: await load(appId)})`.
   * Default is no persistence. Call {@link authorize} when your integration
   * needs the raw authorized connection to pass into another client.
   */
  tokenStorage?: {
    save(appId: string, token: string): Promise<void> | void;
    load?(appId: string): Promise<string | null> | string | null;
  };
  /**
   * Max seconds to wait for the user to approve the grant. Default
   * 120s (2 min). Set higher for apps where the user might Alt-Tab to
   * the gezel desktop app, scroll to Settings, and approve manually.
   */
  approvalTimeoutSec?: number;
  /**
   * Called with the daemon-generated verification code for grants carrying
   * stateful authority. Show this code in the requesting application so the
   * user can type it into Gezel's approval dialog. The desktop app never
   * receives or displays the code.
   */
  onVerificationCode?(code: string): Promise<void> | void;
  /** Override the underlying fetch (tests inject; Node default trusts the loopback cert). */
  fetch?: typeof fetch;
}

/**
 * Generic result of the discovery + consent protocol. Consumers that only
 * need the OpenAI-compatible API can use {@link connect}; integrations that
 * also have a typed product client can pass this token and transport into it.
 */
export interface AuthorizedConnection {
  baseUrl: string;
  token: string;
  fetch: typeof fetch;
}

export type ChatMessageRole = 'system' | 'user' | 'assistant' | 'tool';

/**
 * OpenAI multimodal content. Either a plain string (the common case)
 * or an array of parts. For image_url parts, the SDK accepts data:
 * URIs natively — pass `{type: 'image_url', image_url: {url: 'data:image/png;base64,...'}}`.
 * HTTP image URLs are not yet wired through gezel's daemon (would
 * require the daemon to make outbound fetches with user network).
 */
export type ChatMessageContent =
  | string
  | Array<
      | { type: 'text'; text: string }
      | {
          type: 'image_url';
          image_url: { url: string; detail?: 'auto' | 'low' | 'high' };
        }
    >;

/**
 * One tool definition advertised to the model. Mirrors OpenAI's
 * `tools[].function` shape exactly. The model can call any of these
 * tools by name; the daemon halts on the first call and returns the
 * captured calls in {@link ChatCompletionResponse} so the caller
 * executes them and posts results back in a follow-up turn.
 */
export interface ChatTool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

/**
 * One captured tool invocation in OpenAI's `tool_calls[]` shape. The
 * SDK consumer parses `function.arguments` as JSON and dispatches to
 * its tool implementation; the result is fed back via a follow-up
 * message with `role: 'tool'` and `tool_call_id: <id>`.
 */
export interface ChatToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/**
 * Discriminated message shape that mirrors OpenAI's broader chat
 * message variants. Assistant messages may carry `tool_calls` (the
 * past model turn that requested tools). Tool messages carry the
 * result of a prior tool call and MUST set `tool_call_id`.
 */
export type ChatMessage =
  | {
      role: 'system' | 'user';
      content: ChatMessageContent;
      name?: string;
    }
  | {
      role: 'assistant';
      content: ChatMessageContent | null;
      tool_calls?: ChatToolCall[];
      name?: string;
    }
  | {
      role: 'tool';
      content: string;
      tool_call_id: string;
    };

export interface ChatRequest {
  /**
   * Qualified gezel model id: `<provider>:<model>` (e.g.
   * `llama-cpp:qwen3-4b-instruct-q4_k_m`). Bare provider names
   * (e.g. `copilot`) ask gezel to pick the provider's configured
   * default.
   */
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  /**
   * Tool definitions advertised to the model. The daemon halts on the
   * first tool call and returns the calls in the response — the
   * caller executes them locally and posts results back via a
   * follow-up request with `role: 'tool'` messages.
   *
   * Providers that don't yet support external tool calling return
   * `400 tools_not_supported_for_provider`.
   */
  tools?: ChatTool[];
}

export interface ChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: 'assistant';
      content: string;
      tool_calls?: ChatToolCall[];
    };
    finish_reason: 'stop' | 'tool_calls';
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface ChatCompletionChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: 'assistant';
      content?: string;
      tool_calls?: Array<{
        index: number;
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason: 'stop' | 'tool_calls' | null;
  }>;
  usage?: ChatCompletionResponse['usage'];
}

export interface ModelListEntry {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
  context_window?: number;
  supports_reasoning?: boolean;
  /** Present when this model entry addresses one of the user's gezels. */
  gezel_id?: string;
  name?: string;
  role?: string;
  /** True for the gezel used when a caller requests an unknown model. */
  is_fallback?: boolean;
}

export interface ModelListResponse {
  object: 'list';
  data: ModelListEntry[];
}

export interface EmbeddingsRequest {
  /** Qualified gezel model id, e.g. `openai:text-embedding-3-small`. */
  model: string;
  /** Single string or batch. The route preserves caller order. */
  input: string | string[];
}

export interface EmbeddingsResponse {
  object: 'list';
  data: Array<{
    object: 'embedding';
    index: number;
    embedding: number[];
  }>;
  model: string;
  usage: { prompt_tokens: number; total_tokens: number };
  id: string;
}

export interface EnsureModelInput {
  /** Backend-qualified model id, e.g. `llama-cpp:qwen3-4b-instruct-q4_k_m`. */
  model: string;
}

export interface EnsureModelResult {
  status: 'ready' | 'downloading';
  model_id: string;
  /** Set when status === 'downloading'. Subscribe via `streamEnsureEvents`. */
  job_id?: string;
}

export type EnsureModelEvent =
  | { type: 'progress'; jobId: string; modelId: string; bytesWritten: number; totalBytes: number }
  | { type: 'verifying'; jobId: string; modelId: string; file?: string }
  | { type: 'extracting-metadata'; jobId: string; modelId: string }
  | {
      type: 'retrying';
      jobId: string;
      modelId: string;
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      reason: string;
    }
  | { type: 'done'; jobId: string; modelId: string; warning?: string }
  | { type: 'error'; jobId: string; modelId: string; error: string };

export type ChatStream = AsyncIterable<ChatCompletionChunk>;

export interface SdkError extends Error {
  code?: string;
  /** HTTP status when the error came from a route response. */
  status?: number;
}
