import { randomUUID } from 'node:crypto';
import { type ProviderName, createLogger, isLocalProvider } from '@bendyline/gezel';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { ZodError } from 'zod';
import type { ExternalConversationTurn } from '../../chat/external-conversation-recorder.js';
import { OLLAMA_TURN_TIMEOUT_MS } from '../../chat/manager.js';
import {
  type ExternalToolSpec,
  ExternalToolsUnsupportedError,
  ModelNotInstalledError,
  type SessionOpts,
  type TurnUsage,
} from '../../providers/types.js';
import type { LLMSession } from '../../providers/types.js';
import type { ServiceContext } from '../context.js';
import {
  EXTERNAL_CONVERSATION_ID_HEADER,
  EXTERNAL_PROJECT_HEADER,
  EXTERNAL_WORKING_DIRECTORY_HEADER,
} from '../external-conversation-headers.js';
import { appendCallerOwnedActionLedger } from '../openai-compat/action-ledger.js';
import { profileForCallerOwnedInference } from '../openai-compat/caller-owned-profile.js';
import { resolveChatTarget, resolveFallbackGezelId } from '../openai-compat/chat-target.js';
import type { ChatTarget } from '../openai-compat/chat-target.js';
import { overlayOpenAiRequestTuning } from '../openai-compat/request-tuning.js';
import {
  createStreamingDiagnostics,
  snapshotStreamingDiagnostics,
} from '../openai-compat/streaming-telemetry.js';
import { runNonStreaming, runStreaming } from '../openai-compat/streaming.js';
import {
  type ChatCompletionRequest,
  ChatCompletionRequestSchema,
  flattenTranscriptIntoPrompt,
  parseGezelModelRef,
  resolveModelTarget,
  translateMessagesWithPrefix,
} from '../openai-compat/translate.js';

const log = createLogger('v1-chat');

// Match ChatManager's user-turn ceilings. Caller-owned app routes create a
// fresh provider session and previously omitted timeoutMs altogether, which
// made llama.cpp fall back to its low-level 120s default even while tokens
// were still arriving. Local reasoning/tool turns routinely need longer;
// provider idle watchdogs and the HTTP abort signal remain the real stall and
// cancellation controls inside these generous hard backstops.
const CALLER_OWNED_CLOUD_TURN_TIMEOUT_MS = 2 * 60 * 60 * 1000;
// Imported, not re-declared: this literal drifted from ChatManager the moment
// that ceiling moved, and "match ChatManager" is only true if it cannot drift.
const CALLER_OWNED_LOCAL_TURN_TIMEOUT_MS = OLLAMA_TURN_TIMEOUT_MS;

function callerOwnedTurnTimeoutMs(provider: ProviderName): number {
  return isLocalProvider(provider) || provider === 'remote'
    ? CALLER_OWNED_LOCAL_TURN_TIMEOUT_MS
    : CALLER_OWNED_CLOUD_TURN_TIMEOUT_MS;
}

export type ExternalConversationRouteOptions = {
  sessionIdHeaders?: string[];
  workingDirectoryHeader?: string;
  projectHeader?: string;
} & (
  | {
      sourceId: string;
      sourceName: string;
      sourceFromAuth?: false;
    }
  | {
      /** Use the authenticated connected app's id/name as thread provenance. */
      sourceFromAuth: true;
      sourceId?: never;
      sourceName?: never;
    }
);

export interface V1ChatRoutesOptions {
  /**
   * Forward a provider's private-reasoning channel in streamed Chat
   * Completions as `delta.reasoning_content`. Reserved for clients, such as
   * pi, whose adapter explicitly understands this compatibility extension.
   */
  includeReasoning?: boolean;
  /**
   * Emit ignorable SSE comments during otherwise silent generation. Used by
   * pi to stay below its HTTP body-idle timeout; absent means no keepalive.
   */
  keepaliveIntervalMs?: number;
  /**
   * Forward live provider tool-argument fragments as incremental OpenAI
   * `delta.tool_calls` chunks. Reserved for agent clients that render tool
   * input while it is being generated.
   */
  streamToolCallDeltas?: boolean;
  /**
   * Opt-in durable mirror for an external app bridge or authenticated generic
   * `/v1` caller. A mirror is created only when a stable conversation header
   * and a concrete gezel target are both present.
   */
  externalConversation?: ExternalConversationRouteOptions;
  /**
   * Recover a stable external thread by matching the caller's authoritative
   * transcript when the client protocol supplies no conversation id.
   */
  inferConversationFromTranscript?: boolean;
}

function visibleMessageContent(
  content: ChatCompletionRequest['messages'][number]['content'],
): string {
  if (content === null) return '';
  if (typeof content === 'string') return content;
  return content.map((part) => (part.type === 'text' ? part.text : '[Image attached]')).join('\n');
}

function externalTranscript(messages: ChatCompletionRequest['messages']) {
  return messages.map((message) => ({
    role: message.role,
    content: visibleMessageContent(message.content),
    ...(message.role === 'assistant' && message.tool_calls
      ? {
          toolCalls: message.tool_calls.map((call) => ({
            id: call.id,
            name: call.function.name,
            arguments: call.function.arguments,
          })),
        }
      : {}),
    ...(message.role === 'tool' ? { toolCallId: message.tool_call_id } : {}),
  }));
}

function describeErrorChain(error: unknown): Array<Record<string, unknown>> {
  const chain: Array<Record<string, unknown>> = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== undefined && current !== null && chain.length < 5 && !seen.has(current)) {
    seen.add(current);
    if (current instanceof Error) {
      const code = (current as NodeJS.ErrnoException).code;
      chain.push({
        name: current.name,
        message: current.message,
        ...(code ? { code } : {}),
      });
      current = current.cause;
    } else {
      chain.push({ message: String(current) });
      break;
    }
  }
  return chain;
}

/**
 * `POST /v1/chat/completions` — OpenAI-compatible chat completions.
 *
 * Backed by gezel's `LLMProvider` abstraction (Copilot, OpenAI,
 * Anthropic, Ollama, llama.cpp, MLX, …). Lifecycle is per-request:
 * we create a fresh {@link LLMSession}, run the turn, then dispose.
 * Calls remain outside Gezel's MCP tool wiring and project history — this
 * surface is for third-party apps that own their own agent loop. A bridge or
 * authenticated app may opt into a read-only transcript mirror via
 * `externalConversation`; that records what the caller did but still leaves
 * its tool/action loop caller-owned.
 *
 * Honored per request: `tools` (caller-executed; providers without
 * external-tool support 400), string-form `tool_choice`, sampling
 * params + `response_format` (overlaid onto the model's resolved
 * tuning), `stream_options.include_usage`, and multimodal image_url
 * data URIs. Embeddings live at `/v1/embeddings`.
 *
 * Auth is layered at mount time: `bearerAuth(tokenStore)` +
 * `requireScope('openai')`. The root token (scope `root`) also
 * passes — the gezel UI / CLI can hit this route without registering
 * itself as an app.
 */
export function v1ChatRoutes(ctx: ServiceContext, opts: V1ChatRoutesOptions = {}): Hono {
  const app = new Hono();

  app.post('/completions', async (c) => {
    // Malformed JSON is the caller's mistake, not ours — OpenAI returns
    // 400 invalid_request_error, never a 500. `c.req.json()` throws a
    // SyntaxError, which isn't a ZodError, so it needs its own guard.
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json(
        {
          error: {
            message: 'Request body is not valid JSON.',
            type: 'invalid_request_error',
            code: 'invalid_json',
          },
        },
        400,
      );
    }
    let parsed: ChatCompletionRequest;
    try {
      parsed = ChatCompletionRequestSchema.parse(raw);
    } catch (err) {
      if (err instanceof ZodError) {
        return c.json(
          {
            error: {
              message: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
              type: 'invalid_request_error',
              code: 'invalid_body',
            },
          },
          400,
        );
      }
      throw err;
    }

    // Tool calling is now supported via SessionOpts.externalTools, but
    // only for providers that have an implementation. The route checks
    // `provider.supportsExternalTools` after resolving the provider and
    // returns 400 for the rest; non-supporting providers also throw
    // `ExternalToolsUnsupportedError` from createSession as defense in
    // depth, mapped to the same 400 below.
    //
    // Per-request sampling, response_format, and the STRING forms of
    // tool_choice are honored: they overlay onto the model's resolved
    // tuning as the topmost layer (see openai-compat/request-tuning.ts)
    // and flow through SessionOpts.tuning to every tuning-consuming
    // provider. The one remaining rejection is the function-pinning
    // tool_choice object — no provider path exists for "force THIS
    // tool" yet, and accepting it silently would let a caller assume
    // the pinned tool must fire.
    if (typeof parsed.tool_choice === 'object' && parsed.tool_choice !== null) {
      return c.json(
        {
          error: {
            message:
              'tool_choice with a pinned function is not supported in gezel /v1 yet — use "auto", "required", or "none".',
            type: 'invalid_request_error',
            code: 'tool_choice_function_not_supported_v1',
          },
        },
        400,
      );
    }

    // Gezel always returns a single choice. `n: 1` is the OpenAI default
    // and passes; anything higher would silently under-deliver, so it's
    // rejected the same way as the other unhonored knobs.
    if (parsed.n !== undefined && parsed.n !== 1) {
      return c.json(
        {
          error: {
            message: `n=${parsed.n} is not supported — gezel /v1 always returns a single choice. Omit n or set it to 1.`,
            type: 'invalid_request_error',
            code: 'n_not_supported_v1',
          },
        },
        400,
      );
    }

    // Resolve the model field into a (provider, model, systemPrefix).
    // The advertised `gezel:<role>-<name>` shape (plus legacy id/name
    // aliases) loads the gezel and routes
    // through ITS configured provider/model; a regular `<provider>:<model>`
    // shape skips straight to the model. Either way the route below
    // only sees a uniform target.
    // One config read serves both the serving-gezel fallback (below)
    // and the supporting-behaviors switch at session build.
    const endpointsConfig: {
      enabled?: boolean;
      servingGezelId?: string;
      supportingBehaviors?: boolean;
    } = await ctx.store
      .readConfig()
      .then((cfg) => cfg.openaiEndpoints ?? {})
      .catch(() => ({}));

    let target: ChatTarget;
    try {
      const gezelRef = parseGezelModelRef(parsed.model);
      if (gezelRef !== null) {
        target = await resolveChatTarget({ kind: 'gezel', ref: gezelRef }, ctx);
      } else {
        const modelTarget = resolveModelTarget(parsed.model);
        if (!modelTarget) {
          // Unknown model string (e.g. a client's hardcoded "gpt-4o").
          // Route through the configured fallback gezel, or the Meester
          // when no explicit override is set. Persona + tuning apply
          // exactly like a `gezel:` target, so every connected app
          // has a useful front door even when it cannot choose one of
          // the gezel entries advertised by GET /v1/models.
          const fallbackGezelId = await resolveFallbackGezelId(ctx, endpointsConfig.servingGezelId);
          if (!fallbackGezelId) {
            return c.json(
              {
                error: {
                  message: `Unknown model "${parsed.model}", and no gezel is available to answer it.`,
                  type: 'invalid_request_error',
                  code: 'gezel_not_found',
                },
              },
              404,
            );
          }
          target = await resolveChatTarget({ kind: 'gezel', ref: fallbackGezelId }, ctx);
        } else {
          target = {
            provider: modelTarget.provider,
            model: modelTarget.model,
            systemPrefix: '',
          };
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json(
        { error: { message, type: 'invalid_request_error', code: 'gezel_not_found' } },
        404,
      );
    }

    let session: LLMSession | undefined;
    let externalTurn: ExternalConversationTurn | undefined;
    const requestStartedAt = Date.now();
    try {
      let translated = translateMessagesWithPrefix(parsed.messages, target.systemPrefix);
      const actionLedger = appendCallerOwnedActionLedger(translated);
      translated = actionLedger.input;
      // Model-aware resolve: local providers route through the engine
      // pool so a request can name ANY installed local model — the
      // pool spools the right llama-server/MLX replica (evicting an
      // idle one under memory pressure). Throws ModelNotInstalledError
      // (mapped to 404 below) for uninstalled local model ids.
      const provider = await ctx.chat.getProviderForModel(target.provider, target.model);

      const externalTools: ExternalToolSpec[] | undefined = parsed.tools?.map((t) => ({
        name: t.function.name,
        ...(t.function.description ? { description: t.function.description } : {}),
        parameters: t.function.parameters,
      }));
      if (externalTools && externalTools.length > 0 && provider.supportsExternalTools !== true) {
        return c.json(
          {
            error: {
              message: `Provider "${provider.name}" does not support external tool calling. Omit tools, or route to a provider that supports them.`,
              type: 'invalid_request_error',
              code: 'tools_not_supported_for_provider',
            },
          },
          400,
        );
      }

      // Providers whose SDK/subprocess owns its own transcript (Copilot,
      // the CLI providers) ignore SessionOpts.priorMessages — and /v1
      // builds a fresh session per request, so explicit history would be
      // silently dropped. Fold the prior turns into the prompt text so
      // multi-turn conversations survive, degraded rather than amnesiac.
      if (provider.supportsPriorMessages !== true) {
        translated = flattenTranscriptIntoPrompt(translated);
      }
      const { systemMessage, prompt, priorMessages, attachments } = translated;

      // Connected apps are foreground callers: put them in the interactive
      // lane so they may use every real engine slot and always dispatch ahead
      // of background/ambient housekeeping. Deliberately omit sessionId — even
      // when Pi has a mirrored ledger thread, the inference turn remains
      // caller-owned, so QueueMeter "open" / "stop" controls cannot operate it.
      const auth = c.get('auth');
      const appName = auth?.appName ?? auth?.appId ?? 'Connected app';
      const queue = {
        lane: 'interactive' as const,
        ...(target.gezelId ? { gezelId: target.gezelId } : {}),
        actorLabel: appName,
        job: appName,
        signal: c.req.raw.signal,
      };

      // Per-model session defaults, mirroring what a UI session on the
      // same model would get. `tuning` (catalog sampling, thinking /
      // instruct folds, per-gezel overrides for gezel: targets) applies
      // unconditionally — it's "what the model is" — with the caller's
      // per-request knobs overlaid on top. The behavior `profile` is the
      // supporting layer the Connected Apps switch gates. Caller-owned
      // inference keeps parsing, grammar, and transcript compatibility but
      // omits interventions which assume Gezel owns the action loop.
      // Best-effort: a resolver failure serves engine defaults rather than
      // failing the request.
      const defaults = await ctx.chat
        .resolveModelSessionDefaults(target.provider, target.model, target.tuningOverrides ?? {})
        .catch(() => null);
      const tuning = defaults ? overlayOpenAiRequestTuning(defaults.tuning, parsed) : null;
      const supportingBehaviors = endpointsConfig.supportingBehaviors !== false;
      // Effective output cap for finish_reason: 'length' inference —
      // per-request max_tokens wins, else the resolved tuning cap.
      const lengthCapTokens = tuning?.sampling.maxTokens;
      const turnTimeoutMs = callerOwnedTurnTimeoutMs(target.provider);

      const sessionOpts: SessionOpts = {
        systemMessage,
        // Stateless app sessions should not synchronously pre-warm their
        // entire (often harness-specific) system prompt. Layered mode lets
        // the first real turn seed the reusable prefix on completion, avoiding
        // a cache-warm request that can sit behind an active MLX batch.
        ...(systemMessage
          ? {
              systemPromptLayers: {
                gezel:
                  target.systemPrefix && systemMessage.startsWith(target.systemPrefix)
                    ? target.systemPrefix
                    : systemMessage,
                project: systemMessage,
              },
            }
          : {}),
        ...(target.model ? { model: target.model } : {}),
        ...(priorMessages.length > 0 ? { priorMessages } : {}),
        ...(externalTools && externalTools.length > 0 ? { externalTools } : {}),
        ...(tuning ? { tuning } : {}),
        ...(defaults && supportingBehaviors
          ? { profile: profileForCallerOwnedInference(defaults.profile) }
          : {}),
      };
      const externalOptions = opts.externalConversation;
      let externalConversationId = (
        externalOptions?.sessionIdHeaders ?? [EXTERNAL_CONVERSATION_ID_HEADER]
      )
        .map((header) => c.req.header(header)?.trim())
        .find((value): value is string => Boolean(value && value.length <= 512));
      const externalSource = externalOptions
        ? externalOptions.sourceFromAuth
          ? (() => {
              const auth = c.get('auth');
              return auth?.appId
                ? { sourceId: auth.appId, sourceName: auth.appName ?? auth.appId }
                : null;
            })()
          : { sourceId: externalOptions.sourceId, sourceName: externalOptions.sourceName }
        : null;
      const transcript = externalOptions ? externalTranscript(parsed.messages) : [];
      if (
        !externalConversationId &&
        opts.inferConversationFromTranscript === true &&
        externalSource &&
        target.gezelId
      ) {
        const requestId = c.req.header('x-request-id')?.trim();
        const fallbackExternalConversationId =
          requestId && requestId.length <= 512 ? requestId : randomUUID();
        externalConversationId = await ctx.chat
          .resolveExternalConversationId({
            sourceId: externalSource.sourceId,
            gezelId: target.gezelId,
            messages: transcript,
            fallbackExternalConversationId,
          })
          .catch((err) => {
            log.warn(
              `external conversation affinity could not be resolved: ${err instanceof Error ? err.message : String(err)}`,
            );
            return fallbackExternalConversationId;
          });
      }
      if (externalOptions && externalSource && externalConversationId && target.gezelId) {
        const workingDirectory = c.req
          .header(externalOptions.workingDirectoryHeader ?? EXTERNAL_WORKING_DIRECTORY_HEADER)
          ?.trim()
          .slice(0, 4096);
        const projectHint = c.req
          .header(externalOptions.projectHeader ?? EXTERNAL_PROJECT_HEADER)
          ?.trim()
          .slice(0, 256);
        try {
          externalTurn = await ctx.chat.beginExternalConversation({
            sourceId: externalSource.sourceId,
            sourceName: externalSource.sourceName,
            externalConversationId,
            ...(workingDirectory ? { workingDirectory } : {}),
            ...(projectHint ? { projectHint } : {}),
            gezelId: target.gezelId,
            providerName: target.provider,
            ...(target.model ? { model: target.model } : {}),
            messages: transcript,
            effectiveSystemMessage: translated.systemMessage,
            toolNames: externalTools?.map((tool) => tool.name) ?? [],
            ...(actionLedger.ledger ? { actionLedger: actionLedger.ledger } : {}),
          });
        } catch (err) {
          log.warn(
            `external conversation mirror could not start: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      session = await provider.createSession(sessionOpts);

      // Observability for a surface that otherwise leaves no trace:
      // token usage feeds the Usage tab, and each completed turn lands
      // one history event with the calling app's id (the emulation
      // listener has no auth context — those turns log as
      // 'unauthenticated').
      const usageRef: { value: TurnUsage | null } = { value: null };
      session.onUsage((u) => {
        usageRef.value = u;
        ctx.chat.recordExternalUsage(target.provider, u);
      });
      const appId = c.get('auth')?.appId ?? 'unauthenticated';
      const logCompletion = (): void => {
        void ctx.history
          .log({
            kind: 'v1.chat.completion',
            summary: `${appId} · chat completion (${parsed.model})`,
            details: {
              appId,
              surface: 'openai',
              model: parsed.model,
              provider: target.provider,
              actionReceiptCount: actionLedger.receiptCount,
              ...(externalTurn ? { externalSessionId: externalTurn.sessionId } : {}),
              ...(usageRef.value
                ? {
                    inputTokens: usageRef.value.inputTokens,
                    outputTokens: usageRef.value.outputTokens,
                  }
                : {}),
            },
          })
          .catch(() => {});
      };

      // Per-app audit (which app made which call) is deferred to a
      // later phase that adds a `v1.chat.completion` kind to the
      // `HistoryEventKind` enum. For now the TokenStore's `lastUsedAt`
      // stamp is the minimum-viable record. The auth context is read
      // here so future audit lands `auth.appId` without route changes.
      void c.get('auth');

      if (parsed.stream === true) {
        const echoModel = parsed.model;
        // Diagnostic context surfaced on any failure during the
        // streaming path. The "VS Code tool-result
        // continuation fails with `fetch failed`" report had no
        // daemon-side breadcrumb — without these fields we can't
        // tell whether the failure correlates with tool-bearing
        // turns, the gezel: route, or the priorMessages shape.
        const lastMessage = parsed.messages[parsed.messages.length - 1];
        const requestContext = {
          appId,
          ...(externalTurn ? { externalSessionId: externalTurn.sessionId } : {}),
          model: parsed.model,
          provider: target.provider,
          messageCount: parsed.messages.length,
          hasTools: (parsed.tools?.length ?? 0) > 0,
          lastMessageRole: lastMessage?.role,
          hasPriorToolMessages: parsed.messages.some((m) => m.role === 'tool'),
          actionReceiptCount: actionLedger.receiptCount,
        };
        return streamSSE(c, async (stream) => {
          const diagnostics = createStreamingDiagnostics();
          const telemetry = (): Record<string, unknown> => ({
            ...requestContext,
            ...snapshotStreamingDiagnostics(diagnostics),
          });
          let clientAborted = false;
          // Client disconnect (stop button, closed tab) must stop paying
          // for generation — tear the session down immediately rather
          // than letting sendAndWait run to completion against a peer
          // that's gone. Mirrors the ollama-compat facade's onAbort.
          stream.onAbort(() => {
            if (!clientAborted) {
              clientAborted = true;
              const signalReason = c.req.raw.signal.reason;
              log.warn(
                `streaming chat completion client-aborted: ${JSON.stringify({
                  ...telemetry(),
                  ...(signalReason !== undefined
                    ? { abortReason: describeErrorChain(signalReason) }
                    : {}),
                })}`,
              );
            }
            void session!.disconnect().catch(() => {});
          });
          try {
            const result = await runStreaming(
              session!,
              prompt,
              echoModel,
              stream,
              () => Math.floor(Date.now() / 1000),
              {
                ...(attachments.length > 0 ? { attachments } : {}),
                sendOptions: { queue, timeoutMs: turnTimeoutMs },
                ...(opts.includeReasoning === true ? { includeReasoning: true } : {}),
                ...(opts.keepaliveIntervalMs !== undefined
                  ? { keepaliveIntervalMs: opts.keepaliveIntervalMs }
                  : {}),
                ...(opts.streamToolCallDeltas === true ? { streamToolCallDeltas: true } : {}),
                ...(opts.streamToolCallDeltas === true && externalTools
                  ? { toolCallNames: externalTools.map((tool) => tool.name) }
                  : {}),
                diagnostics,
                ...(externalTools && externalTools.length > 0
                  ? { suppressTextualToolCalls: true }
                  : {}),
                ...(parsed.stream_options?.include_usage === true ? { includeUsage: true } : {}),
                ...(lengthCapTokens !== undefined ? { lengthCapTokens } : {}),
                ...(externalTurn
                  ? {
                      onContentDelta: externalTurn.onContentDelta,
                      onReasoningDelta: externalTurn.onReasoningDelta,
                      onToolArgsDelta: externalTurn.onToolArgsDelta,
                    }
                  : {}),
              },
            );
            await externalTurn
              ?.finish({
                content: result.content,
                ...(result.reasoning ? { reasoning: result.reasoning } : {}),
                finishReason: result.finishReason,
              })
              .catch((err) => {
                log.warn(
                  `external conversation mirror could not commit: ${err instanceof Error ? err.message : String(err)}`,
                );
              });
            const completedTelemetry = telemetry();
            if (externalTurn || requestContext.hasTools || requestContext.hasPriorToolMessages) {
              log.info(
                `caller-owned chat iteration completed: ${JSON.stringify({
                  ...completedTelemetry,
                  finishReason: result.finishReason,
                })}`,
              );
            } else if (
              (completedTelemetry.elapsedMs as number) >= 60_000 ||
              (completedTelemetry.keepalives as number) > 0
            ) {
              log.info(
                `streaming chat completion completed after a long/silent turn: ${JSON.stringify(completedTelemetry)}`,
              );
            }
            logCompletion();
          } catch (err) {
            // Stream is already open — surface as a final SSE chunk
            // formatted as an OpenAI error envelope. The OpenAI SDK
            // recognizes `data: {error: …}` mid-stream as a failure
            // and rejects the iterator.
            const message = err instanceof Error ? err.message : String(err);
            await externalTurn?.fail(err).catch(() => {});
            log.warn(
              `streaming chat completion failed mid-stream: ${JSON.stringify({
                ...telemetry(),
                clientAborted,
                error: describeErrorChain(err),
              })}`,
            );
            await stream
              .writeSSE({
                data: JSON.stringify({
                  error: {
                    message,
                    type: 'server_error',
                    code: 'provider_error',
                  },
                }),
              })
              .catch((sseErr) => {
                // The catch handler couldn't even emit the error
                // envelope — the client side has half-closed. This
                // is the exact shape the SDK sees as undici
                // `TypeError: fetch failed`. Log the second failure
                // so we know the user-side error wasn't a real
                // bug, just a graceless close.
                const sseMessage = sseErr instanceof Error ? sseErr.message : String(sseErr);
                log.warn(
                  `streaming chat completion error-envelope write failed: ${JSON.stringify({
                    ...telemetry(),
                    clientAborted,
                    originalError: message,
                    writeError: describeErrorChain(sseErr),
                    clientWillSee: 'fetch_failed',
                    writeErrorMessage: sseMessage,
                  })}`,
                );
              });
            await stream.writeSSE({ data: '[DONE]' }).catch(() => {});
          } finally {
            await session!.disconnect().catch(() => {});
          }
        });
      }

      const response = await runNonStreaming(
        session,
        prompt,
        parsed.model,
        () => Math.floor(Date.now() / 1000),
        {
          ...(attachments.length > 0 ? { attachments } : {}),
          sendOptions: { queue, timeoutMs: turnTimeoutMs },
          ...(lengthCapTokens !== undefined ? { lengthCapTokens } : {}),
        },
      );
      const choice = response.choices[0];
      await externalTurn
        ?.finish({
          content: choice.message.content,
          finishReason: choice.finish_reason,
        })
        .catch((err) => {
          log.warn(
            `external conversation mirror could not commit: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      if (
        externalTurn ||
        (parsed.tools?.length ?? 0) > 0 ||
        parsed.messages.some((message) => message.role === 'tool')
      ) {
        log.info(
          `caller-owned chat iteration completed: ${JSON.stringify({
            appId,
            ...(externalTurn ? { externalSessionId: externalTurn.sessionId } : {}),
            model: parsed.model,
            provider: target.provider,
            messageCount: parsed.messages.length,
            toolCount: parsed.tools?.length ?? 0,
            actionReceiptCount: actionLedger.receiptCount,
            finishReason: choice.finish_reason,
            elapsedMs: Date.now() - requestStartedAt,
          })}`,
        );
      }
      logCompletion();
      return c.json(response);
    } catch (err) {
      await externalTurn?.fail(err).catch(() => {});
      if (session) await session.disconnect().catch(() => {});
      if (
        externalTurn ||
        (parsed.tools?.length ?? 0) > 0 ||
        parsed.messages.some((message) => message.role === 'tool')
      ) {
        log.warn(
          `caller-owned chat iteration failed: ${JSON.stringify({
            ...(externalTurn ? { externalSessionId: externalTurn.sessionId } : {}),
            model: parsed.model,
            messageCount: parsed.messages.length,
            elapsedMs: Date.now() - requestStartedAt,
            error: describeErrorChain(err),
          })}`,
        );
      }
      if (err instanceof ModelNotInstalledError) {
        return c.json(
          {
            error: {
              message: err.message,
              type: 'invalid_request_error',
              code: 'model_not_found',
            },
          },
          404,
        );
      }
      if (err instanceof ExternalToolsUnsupportedError) {
        return c.json(
          {
            error: {
              message: err.message,
              type: 'invalid_request_error',
              code: 'tools_not_supported_for_provider',
            },
          },
          400,
        );
      }
      const message = err instanceof Error ? err.message : String(err);
      if (
        message.includes('messages must') ||
        message.includes('empty') ||
        message.includes('cannot be an assistant turn')
      ) {
        return c.json(
          {
            error: { message, type: 'invalid_request_error', code: 'empty_prompt' },
          },
          400,
        );
      }
      return c.json({ error: { message, type: 'server_error', code: 'provider_error' } }, 500);
    }
  });

  return app;
}
