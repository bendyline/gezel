import { createLogger } from '@bendyline/gezel';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { ZodError } from 'zod';
import {
  type ExternalToolSpec,
  ExternalToolsUnsupportedError,
  ModelNotInstalledError,
  type SessionOpts,
} from '../../providers/types.js';
import type { LLMSession } from '../../providers/types.js';
import type { ServiceContext } from '../context.js';
import { resolveChatTarget } from '../openai-compat/chat-target.js';
import type { ChatTarget } from '../openai-compat/chat-target.js';
import { runNonStreaming, runStreaming } from '../openai-compat/streaming.js';
import {
  type ChatCompletionRequest,
  ChatCompletionRequestSchema,
  parseGezelModelRef,
  resolveModelTarget,
  translateMessagesWithPrefix,
} from '../openai-compat/translate.js';

const log = createLogger('v1-chat');

/**
 * `POST /v1/chat/completions` — OpenAI-compatible chat completions.
 *
 * Backed by gezel's `LLMProvider` abstraction (Copilot, OpenAI,
 * Anthropic, Ollama, llama.cpp, MLX, …). Lifecycle is per-request:
 * we create a fresh {@link LLMSession}, run the turn, then dispose.
 * `/v1` calls explicitly do NOT participate in the UI's gezel
 * sessions, project state, MCP tool wiring, or any project history —
 * this surface is for third-party apps that just want inference.
 *
 * Tool calling, structured outputs, and embeddings are intentionally
 * NOT in v1. Requests carrying `tools` / `tool_choice` /
 * `response_format` return a clear 400 with `code:
 * tool_calling_not_supported_v1` so the app can fall back gracefully
 * instead of silently receiving plain text.
 *
 * Auth is layered at mount time: `bearerAuth(tokenStore)` +
 * `requireScope('openai')`. The root token (scope `root`) also
 * passes — the gezel UI / CLI can hit this route without registering
 * itself as an app.
 */
export function v1ChatRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  app.post('/completions', async (c) => {
    let parsed: ChatCompletionRequest;
    try {
      parsed = ChatCompletionRequestSchema.parse(await c.req.json());
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
    // only for providers that have an implementation. The route hands
    // the request through; if the resolved provider doesn't support
    // external tools, the provider's createSession will throw
    // `ExternalToolsUnsupportedError` and we map that to 400 below.
    //
    // `tool_choice` and `response_format` are still v1-deferred —
    // accepting them silently would let callers assume gezel honors
    // them; the rejection makes the limitation explicit.
    if (parsed.tool_choice !== undefined) {
      return c.json(
        {
          error: {
            message: 'tool_choice is not supported in gezel /v1 yet.',
            type: 'invalid_request_error',
            code: 'tool_choice_not_supported_v1',
          },
        },
        400,
      );
    }
    if (parsed.response_format !== undefined) {
      return c.json(
        {
          error: {
            message: 'response_format is not supported in gezel /v1 yet.',
            type: 'invalid_request_error',
            code: 'structured_outputs_not_supported_v1',
          },
        },
        400,
      );
    }

    // Per-request sampling parameters aren't threaded to the providers yet —
    // sampling is applied per-model via catalog/frontmatter tuning, and each
    // provider builds its own request body. Accepting these silently would
    // let a caller believe gezel honors them (same rationale as tool_choice /
    // response_format above), so we reject explicitly with the offending
    // names. Per-request sampling is a roadmap item.
    const unsupportedSampling = (
      ['temperature', 'max_tokens', 'top_p', 'presence_penalty', 'frequency_penalty'] as const
    ).filter((k) => parsed[k] !== undefined);
    if (unsupportedSampling.length > 0) {
      return c.json(
        {
          error: {
            message: `These sampling parameters aren't honored by gezel /v1 yet: ${unsupportedSampling.join(', ')}. Omit them — sampling is currently set per-model via tuning; per-request sampling is on the roadmap.`,
            type: 'invalid_request_error',
            code: 'sampling_params_not_supported_v1',
          },
        },
        400,
      );
    }

    // Resolve the model field into a (provider, model, systemPrefix).
    // The `gezel:<id-or-name>` shape loads the gezel and routes
    // through ITS configured provider/model; a regular `<provider>:<model>`
    // shape skips straight to the model. Either way the route below
    // only sees a uniform target.
    let target: ChatTarget;
    try {
      const gezelRef = parseGezelModelRef(parsed.model);
      if (gezelRef !== null) {
        target = await resolveChatTarget({ kind: 'gezel', ref: gezelRef }, ctx);
      } else {
        const modelTarget = resolveModelTarget(parsed.model);
        if (!modelTarget) {
          return c.json(
            {
              error: {
                message: `Unknown model "${parsed.model}". Expected "<provider>:<model>" or "gezel:<id-or-name>" — see /v1/models, /v1/gezels.`,
                type: 'invalid_request_error',
                code: 'model_not_found',
              },
            },
            404,
          );
        }
        target = {
          provider: modelTarget.provider,
          model: modelTarget.model,
          systemPrefix: '',
        };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json(
        { error: { message, type: 'invalid_request_error', code: 'gezel_not_found' } },
        404,
      );
    }

    let session: LLMSession | undefined;
    try {
      const translated = translateMessagesWithPrefix(parsed.messages, target.systemPrefix);
      const { systemMessage, prompt, priorMessages, attachments } = translated;
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
      const sessionOpts: SessionOpts = {
        systemMessage,
        ...(target.model ? { model: target.model } : {}),
        ...(priorMessages.length > 0 ? { priorMessages } : {}),
        ...(externalTools && externalTools.length > 0 ? { externalTools } : {}),
      };
      session = await provider.createSession(sessionOpts);

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
          model: parsed.model,
          provider: target.provider,
          messageCount: parsed.messages.length,
          hasTools: (parsed.tools?.length ?? 0) > 0,
          lastMessageRole: lastMessage?.role,
          hasPriorToolMessages: parsed.messages.some((m) => m.role === 'tool'),
        };
        return streamSSE(c, async (stream) => {
          try {
            await runStreaming(
              session!,
              prompt,
              echoModel,
              stream,
              () => Math.floor(Date.now() / 1000),
              attachments,
            );
          } catch (err) {
            // Stream is already open — surface as a final SSE chunk
            // formatted as an OpenAI error envelope. The OpenAI SDK
            // recognizes `data: {error: …}` mid-stream as a failure
            // and rejects the iterator.
            const message = err instanceof Error ? err.message : String(err);
            log.warn(
              `streaming chat completion failed mid-stream: ${message} (request: ${JSON.stringify(requestContext)})`,
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
                  `streaming chat completion: error-envelope writeSSE failed too — ${sseMessage}; client will see fetch_failed`,
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
        attachments,
      );
      return c.json(response);
    } catch (err) {
      if (session) await session.disconnect().catch(() => {});
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
