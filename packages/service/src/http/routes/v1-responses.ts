import { createLogger } from '@bendyline/gezel';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { streamSSE } from 'hono/streaming';
import { ZodError } from 'zod';
import type { ResolvedTuning } from '../../model-profile/tuning.js';
import {
  ExternalToolsUnsupportedError,
  ModelNotInstalledError,
  type SessionOpts,
  type TurnUsage,
} from '../../providers/types.js';
import type { LLMSession } from '../../providers/types.js';
import type { ServiceContext } from '../context.js';
import { profileForCallerOwnedInference } from '../openai-compat/caller-owned-profile.js';
import { type ChatTarget, resolveChatTarget } from '../openai-compat/chat-target.js';
import {
  runResponsesNonStreaming,
  runResponsesStreaming,
} from '../openai-compat/responses-streaming.js';
import {
  ResponsesRequestSchema,
  type TranslatedResponsesRequest,
  translateResponsesRequest,
} from '../openai-compat/responses-translate.js';
import {
  flattenTranscriptIntoPrompt,
  parseGezelModelRef,
  resolveModelTarget,
} from '../openai-compat/translate.js';

const log = createLogger('v1-responses');
const MAX_RESPONSES_BODY_BYTES = 16 * 1024 * 1024;
const NATIVE_AGENT_LOOP_PROVIDERS = new Set(['anthropic-cli', 'codex-cli']);

/**
 * `POST /v1/responses` — the stateless Responses API subset used by Codex.
 *
 * Codex remains the agent harness: it owns its transcript, sandbox, tools,
 * approvals, and filesystem changes. Gezel only performs one inference turn
 * and returns assistant text/tool calls in Responses wire shapes. The route
 * intentionally does not create a Gezel chat session or attach Gezel MCP.
 *
 * Auth is mounted in `server.ts`: the Connected Apps master switch, bearer
 * authentication, and the `openai` scope all apply. Codex can therefore use
 * an app-scoped token without ever learning the daemon's root credential.
 */
export function v1ResponsesRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  app.post(
    '/',
    bodyLimit({
      maxSize: MAX_RESPONSES_BODY_BYTES,
      onError: (c) =>
        c.json(
          {
            error: {
              message: 'Responses request body exceeds the 16 MiB limit.',
              type: 'invalid_request_error',
              code: 'request_too_large',
            },
          },
          413,
        ),
    }),
    async (c) => {
      let raw: unknown;
      try {
        raw = await c.req.json();
      } catch {
        return invalidRequest(c, 'Request body is not valid JSON.', 'invalid_json');
      }

      const rawRecord = asRecord(raw);
      const unsupportedTool = firstUnsupportedHostedTool(rawRecord?.tools);
      if (unsupportedTool) {
        return invalidRequest(
          c,
          `Responses tool "${unsupportedTool}" is provider-hosted and is not available through Gezel local inference. Disable it in Codex (web_search = "disabled") or use a caller-executed function/custom tool.`,
          'unsupported_tool',
        );
      }

      if (
        rawRecord?.previous_response_id != null ||
        rawRecord?.conversation != null ||
        rawRecord?.store === true ||
        rawRecord?.background === true
      ) {
        return invalidRequest(
          c,
          'Gezel Responses inference is stateless. Send store: false and replay input items instead of using previous_response_id, conversation, or background mode.',
          'stored_state_not_supported',
        );
      }

      let translated: TranslatedResponsesRequest;
      let parsed: ReturnType<typeof ResponsesRequestSchema.parse>;
      try {
        parsed = ResponsesRequestSchema.parse(raw);
        translated = translateResponsesRequest(parsed);
      } catch (err) {
        const message =
          err instanceof ZodError
            ? err.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')
            : err instanceof Error
              ? err.message
              : String(err);
        return invalidRequest(c, message, 'invalid_body');
      }

      const endpointsConfig: {
        enabled?: boolean;
        supportingBehaviors?: boolean;
      } = await ctx.store
        .readConfig()
        .then((config) => config.openaiEndpoints ?? {})
        .catch(() => ({}));

      let target: ChatTarget;
      try {
        target = await resolveResponsesTarget(parsed.model, ctx);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const code =
          parseGezelModelRef(parsed.model) !== null ? 'gezel_not_found' : 'model_not_found';
        return c.json({ error: { message, type: 'invalid_request_error', code } }, 404);
      }

      if (NATIVE_AGENT_LOOP_PROVIDERS.has(target.provider)) {
        return invalidRequest(
          c,
          `Provider "${target.provider}" owns a native coding-agent tool loop and cannot be nested behind the inference-only Responses facade. Select a raw local/API model instead.`,
          'provider_not_inference_only',
        );
      }

      let session: LLMSession | undefined;
      try {
        translated.sessionInput = prependSystemPrefix(translated.sessionInput, target.systemPrefix);
        const provider = await ctx.chat.getProviderForModel(target.provider, target.model);

        let externalTools = translated.externalTools;
        const pinnedToolName =
          'name' in translated.toolChoice ? translated.toolChoice.name : undefined;
        if (translated.toolChoice.mode === 'none') {
          externalTools = [];
        } else if (pinnedToolName) {
          externalTools = externalTools.filter((tool) => tool.name === pinnedToolName);
        }
        if (translated.toolChoice.mode === 'required' && externalTools.length === 0) {
          return invalidRequest(
            c,
            'tool_choice is required, but the request does not contain a matching executable tool.',
            'invalid_tool_choice',
          );
        }
        if (externalTools.length > 0 && provider.supportsExternalTools !== true) {
          return invalidRequest(
            c,
            `Provider "${provider.name}" does not support caller-executed tool calls.`,
            'tools_not_supported_for_provider',
          );
        }

        if (provider.supportsPriorMessages !== true) {
          translated.sessionInput = flattenTranscriptIntoPrompt(translated.sessionInput);
        }
        const { systemMessage, prompt, priorMessages, attachments } = translated.sessionInput;

        const defaults = await ctx.chat
          .resolveModelSessionDefaults(target.provider, target.model, target.tuningOverrides ?? {})
          .catch(() => null);
        const tuning = defaults ? overlayResponsesTuning(defaults.tuning, translated) : null;
        const lengthCapTokens = tuning?.sampling.maxTokens ?? translated.maxOutputTokens;
        const supportingBehaviors = endpointsConfig.supportingBehaviors !== false;
        const continueFromToolResult = prompt.length === 0 && priorMessages.at(-1)?.role === 'tool';

        const sessionOpts: SessionOpts = {
          systemMessage,
          ...(target.model ? { model: target.model } : {}),
          ...(priorMessages.length > 0 ? { priorMessages } : {}),
          ...(externalTools.length > 0 ? { externalTools } : {}),
          ...(tuning ? { tuning } : {}),
          ...(typeof translated.reasoning?.effort === 'string'
            ? { reasoningEffort: translated.reasoning.effort }
            : target.tuningOverrides?.reasoningEffort
              ? { reasoningEffort: target.tuningOverrides.reasoningEffort }
              : {}),
          // Codex owns this action loop. Keep model compatibility behavior,
          // but never apply Gezel's must-use-a-tool ramble intervention.
          ...(defaults && supportingBehaviors
            ? { profile: profileForCallerOwnedInference(defaults.profile) }
            : {}),
        };
        session = await provider.createSession(sessionOpts);

        const usageRef: { value: TurnUsage | null } = { value: null };
        session.onUsage((usage) => {
          usageRef.value = usage;
          ctx.chat.recordExternalUsage(target.provider, usage);
        });
        const appId = c.get('auth')?.appId ?? 'root';
        const logOutcome = (outcome: 'completed' | 'incomplete' | 'failed'): void => {
          void ctx.history
            .log({
              kind: 'v1.chat.completion',
              summary: `${appId} · Responses ${outcome} (${parsed.model})`,
              details: {
                appId,
                surface: 'responses',
                outcome,
                model: parsed.model,
                provider: target.provider,
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

        const turnAbort = new AbortController();
        const requestSignal = c.req.raw.signal;
        const abortTurn = (): void => turnAbort.abort();
        if (requestSignal.aborted) abortTurn();
        else requestSignal.addEventListener('abort', abortTurn, { once: true });
        const detachRequestAbort = (): void => {
          requestSignal.removeEventListener('abort', abortTurn);
        };

        const runnerOptions = {
          ...(attachments.length > 0 ? { attachments } : {}),
          ...(lengthCapTokens !== undefined ? { lengthCapTokens } : {}),
          toolBindings: translated.toolBindings,
          toolKinds: translated.toolKinds,
          continueFromToolResult,
          signal: turnAbort.signal,
          onProviderError: (error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            log.warn(`Responses provider failed: ${message}`);
          },
          echo: {
            instructions: parsed.instructions ?? null,
            parallelToolCalls: translated.parallelToolCalls ?? true,
            reasoning: translated.reasoning ?? null,
            store: false,
            toolChoice: parsed.tool_choice,
            tools: parsed.tools,
            maxOutputTokens: translated.maxOutputTokens ?? null,
          },
        } as const;

        if (translated.stream === true) {
          return streamSSE(c, async (stream) => {
            stream.onAbort(() => {
              abortTurn();
              void session!.disconnect().catch(() => {});
            });
            try {
              const response = await runResponsesStreaming(
                session!,
                prompt,
                parsed.model,
                stream,
                () => Math.floor(Date.now() / 1_000),
                runnerOptions,
              );
              logOutcome(
                response.status === 'completed' || response.status === 'incomplete'
                  ? response.status
                  : 'failed',
              );
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              log.warn(`Responses stream failed: ${message}`);
              logOutcome('failed');
              await stream
                .writeSSE({
                  event: 'error',
                  data: JSON.stringify({
                    type: 'error',
                    code: 'provider_error',
                    message: 'The response stream ended unexpectedly.',
                    param: null,
                  }),
                })
                .catch(() => {});
            } finally {
              detachRequestAbort();
              await session!.disconnect().catch(() => {});
            }
          });
        }

        try {
          const response = await runResponsesNonStreaming(
            session,
            prompt,
            parsed.model,
            () => Math.floor(Date.now() / 1_000),
            runnerOptions,
          );
          logOutcome(response.status === 'incomplete' ? 'incomplete' : 'completed');
          return c.json(response);
        } finally {
          detachRequestAbort();
          await session.disconnect().catch(() => {});
          session = undefined;
        }
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
          return invalidRequest(c, err.message, 'tools_not_supported_for_provider');
        }
        const message = err instanceof Error ? err.message : String(err);
        if (
          message.includes('messages must') ||
          message.includes('empty') ||
          message.includes('cannot be an assistant turn')
        ) {
          return invalidRequest(c, message, 'empty_prompt');
        }
        log.warn(`Responses request failed: ${message}`);
        return c.json({ error: { message, type: 'server_error', code: 'provider_error' } }, 500);
      }
    },
  );

  return app;
}

async function resolveResponsesTarget(model: string, ctx: ServiceContext): Promise<ChatTarget> {
  const gezelRef = parseGezelModelRef(model);
  if (gezelRef !== null) {
    return resolveChatTarget({ kind: 'gezel', ref: gezelRef }, ctx);
  }

  const modelTarget = resolveModelTarget(model);
  if (modelTarget) {
    return {
      provider: modelTarget.provider,
      model: modelTarget.model,
      systemPrefix: '',
    };
  }

  throw new Error(
    `Unknown model "${model}". Use an explicit <provider>:<model> id or advertised gezel:<role>-<name> alias.`,
  );
}

function prependSystemPrefix<T extends { systemMessage: string }>(input: T, prefix: string): T {
  if (!prefix) return input;
  return {
    ...input,
    systemMessage: `${prefix}${input.systemMessage ? '\n\n---\n\n' : ''}${input.systemMessage}`,
  };
}

function overlayResponsesTuning(
  base: ResolvedTuning,
  request: TranslatedResponsesRequest,
): ResolvedTuning {
  const sampling = { ...base.sampling };
  if (request.maxOutputTokens !== undefined) sampling.maxTokens = request.maxOutputTokens;
  return {
    ...base,
    sampling,
    toolChoice: request.toolChoice.mode,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function firstUnsupportedHostedTool(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  for (const entry of value) {
    const record = asRecord(entry);
    const type = record?.type;
    if (
      typeof type === 'string' &&
      !['function', 'custom', 'freeform', 'namespace'].includes(type)
    ) {
      return type;
    }
  }
  return null;
}

function invalidRequest(c: Context, message: string, code: string) {
  return c.json({ error: { message, type: 'invalid_request_error', code } }, 400);
}
