import { Hono } from 'hono';
import { stream as honoStream } from 'hono/streaming';
import { ZodError, z } from 'zod';
import { ModelNotInstalledError } from '../../providers/types.js';
import type {
  ExternalToolCall,
  ExternalToolSpec,
  ProviderName,
  TurnUsage,
} from '../../providers/types.js';
import type { ServiceContext } from '../context.js';
import type { ChatTarget } from '../openai-compat/chat-target.js';
import { resolveChatTarget } from '../openai-compat/chat-target.js';
import {
  type ChatCompletionRequest,
  flattenTranscriptIntoPrompt,
  parseGezelModelRef,
  resolveModelTarget,
  translateMessagesWithPrefix,
} from '../openai-compat/translate.js';

/**
 * `/ollama/v1/*` — Ollama-compatible facade.
 *
 * The narrative split for the casual reviewer:
 *
 *   - `/api/ollama/*` — gezel acts as an Ollama *client* (detect /
 *     start / pull / status of a local Ollama daemon).
 *   - `/v1/*`         — gezel acts as an OpenAI-compatible *server*.
 *   - `/ollama/v1/*`  — gezel acts as an Ollama-compatible *server*,
 *     so apps already targeting Ollama can swap their baseUrl to
 *     gezel and route their inference through every provider gezel
 *     knows about (not just the local Ollama daemon).
 *
 * The same router also backs the opt-in **Ollama emulation listener**
 * (loopback port 11434, unauthenticated — see
 * [ollama-emulation.ts](../ollama-emulation.ts)), mounted there under
 * `/api` so stock Ollama clients' `{host}/api/tags` + `{host}/api/chat`
 * paths line up.
 *
 * Scope: `/tags` (list) + `/chat` (NDJSON, with tool calling). The
 * chat route shares `/v1/chat/completions`' semantics: `gezel:<ref>`
 * targets and the serving-gezel fallback (persona + per-gezel tuning),
 * per-model tuning always, the behavior profile gated by the
 * `supportingBehaviors` switch, and caller-executed tools via
 * `SessionOpts.externalTools`. Message `images` (bare base64, Ollama's
 * multimodal shape) attach to the in-flight prompt like `/v1`'s
 * image_url parts. Generate, pull, show, copy, delete are out of
 * scope — apps that need those should use gezel's own
 * `/v1/models/ensure` (download) and `/v1/models` (list).
 */
const OllamaToolCallSchema = z.object({
  function: z.object({
    name: z.string().min(1),
    // Ollama's native shape carries arguments as a JSON OBJECT (unlike
    // OpenAI's string). Tolerate a pre-encoded string too — clients
    // that round-trip our own output may re-send either.
    arguments: z.union([z.record(z.string(), z.unknown()), z.string()]).default({}),
  }),
});

const OllamaMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string().default(''),
  /**
   * Ollama's multimodal field: BARE base64 image bytes (no data-URI
   * prefix, no mime type — the mime is sniffed from magic bytes).
   * Same reach as `/v1`'s image_url parts: only the LAST message's
   * images ride the in-flight prompt; images on prior turns drop.
   */
  images: z.array(z.string().min(1)).optional(),
  tool_calls: z.array(OllamaToolCallSchema).optional(),
  /** Newer Ollama clients label tool results with the tool's name. Accepted, unused. */
  tool_name: z.string().optional(),
});

const OllamaToolSchema = z.object({
  type: z.literal('function'),
  function: z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    parameters: z.record(z.string(), z.unknown()).default({ type: 'object', properties: {} }),
  }),
});

const OllamaChatRequestSchema = z.object({
  model: z.string().min(1),
  messages: z.array(OllamaMessageSchema).min(1),
  stream: z.boolean().optional(),
  tools: z.array(OllamaToolSchema).optional(),
});

type OllamaMessages = z.infer<typeof OllamaChatRequestSchema>['messages'];

interface OllamaTagsModel {
  name: string;
  model: string;
  modified_at: string;
  size: number;
  digest: string;
  details: {
    parent_model: string;
    format: string;
    family: string;
    families: string[];
    parameter_size: string;
    quantization_level: string;
  };
}

interface OllamaChatStreamChunk {
  model: string;
  created_at: string;
  message?: {
    role: 'assistant';
    content: string;
    tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>;
  };
  done: boolean;
  done_reason?: 'stop';
  total_duration?: number;
  prompt_eval_count?: number;
  eval_count?: number;
}

const PROVIDERS_FOR_TAGS: readonly ProviderName[] = [
  'copilot',
  'openai',
  'anthropic',
  'anthropic-cli',
  'codex-cli',
  'ollama',
  'llama-cpp',
  'mlx',
];

/**
 * Sniff an image mime type from base64 magic bytes. Ollama's wire
 * format carries no mime — clients send whatever bytes they have — so
 * we recognize the common containers and default to PNG (vision
 * backends key off the bytes anyway; the mime mostly names the
 * attachment file).
 */
function sniffImageMime(base64: string): string {
  if (base64.startsWith('/9j/')) return 'image/jpeg';
  if (base64.startsWith('iVBOR')) return 'image/png';
  if (base64.startsWith('R0lGOD')) return 'image/gif';
  if (base64.startsWith('UklGR')) return 'image/webp';
  return 'image/png';
}

/** Bare-base64 (Ollama) → data-URI image_url part; data URIs pass through. */
function toImageUrlPart(image: string): { type: 'image_url'; image_url: { url: string } } {
  const url = image.startsWith('data:') ? image : `data:${sniffImageMime(image)};base64,${image}`;
  return { type: 'image_url', image_url: { url } };
}

/**
 * Convert Ollama-wire messages into the OpenAI shape `translateMessages`
 * consumes. The impedance mismatches are small but real:
 *
 *   - Ollama tool calls have no ids and OBJECT arguments; OpenAI needs
 *     string ids + JSON-string arguments. Ids are synthesized in order
 *     (`call_0`, `call_1`, …) and each `role: 'tool'` result consumes
 *     the oldest unmatched id — Ollama's contract is positional.
 *   - Ollama images are bare base64 alongside the text; OpenAI wants
 *     multimodal content parts. User-message images become image_url
 *     parts (mime sniffed); the shared translate layer then applies
 *     its normal rule — last message's images attach, earlier ones
 *     drop.
 */
function toOpenAiMessages(messages: OllamaMessages): ChatCompletionRequest['messages'] {
  const out: ChatCompletionRequest['messages'] = [];
  const pendingToolCallIds: string[] = [];
  let counter = 0;
  for (const m of messages) {
    if (m.role === 'user' && m.images && m.images.length > 0) {
      out.push({
        role: 'user',
        content: [
          ...(m.content ? [{ type: 'text' as const, text: m.content }] : []),
          ...m.images.map(toImageUrlPart),
        ],
      });
      continue;
    }
    if (m.role === 'assistant') {
      const toolCalls = (m.tool_calls ?? []).map((tc) => {
        const id = `call_${counter++}`;
        pendingToolCallIds.push(id);
        return {
          id,
          type: 'function' as const,
          function: {
            name: tc.function.name,
            arguments:
              typeof tc.function.arguments === 'string'
                ? tc.function.arguments
                : JSON.stringify(tc.function.arguments),
          },
        };
      });
      out.push({
        role: 'assistant',
        content: m.content,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
    } else if (m.role === 'tool') {
      out.push({
        role: 'tool',
        content: m.content,
        tool_call_id: pendingToolCallIds.shift() ?? `call_${counter++}`,
      });
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  return out;
}

/** Captured external calls → Ollama's tool_calls shape (object arguments, no ids). */
function toOllamaToolCalls(
  calls: ExternalToolCall[],
): Array<{ function: { name: string; arguments: Record<string, unknown> } }> {
  return calls.map((call) => {
    let args: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(call.arguments);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        args = parsed as Record<string, unknown>;
      }
    } catch {
      /* malformed arguments → empty object; the name still routes */
    }
    return { function: { name: call.name, arguments: args } };
  });
}

function usageFields(usage: TurnUsage | null): Record<string, number> {
  if (!usage) return {};
  return {
    prompt_eval_count: usage.inputTokens,
    eval_count: usage.outputTokens,
    total_duration: usage.durationMs * 1_000_000,
  };
}

export function ollamaCompatRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  /**
   * `GET /tags` — Ollama's "what models are installed" endpoint.
   * Mapped to gezel's full provider roster. Each model is reported
   * with a backend-qualified name so the caller's later `model:` field
   * unambiguously routes to the same backend.
   */
  app.get('/tags', async (c) => {
    const now = new Date().toISOString();
    const buckets = await Promise.all(
      PROVIDERS_FOR_TAGS.map(async (provider) => {
        try {
          const models = await ctx.chat.listModelsForProvider(provider);
          return models.map<OllamaTagsModel>((m) => ({
            name: `${provider}:${m.id}`,
            model: `${provider}:${m.id}`,
            modified_at: now,
            // We don't know on-disk size for cloud models; surface 0
            // rather than fabricating one. Local-engine sizes could
            // come from LlamaCppModelManager.listInstalled() / mlx
            // equivalent — Phase 6.5 work.
            size: 0,
            digest: '',
            details: {
              parent_model: '',
              format: provider === 'llama-cpp' ? 'gguf' : '',
              family: '',
              families: [],
              parameter_size: m.parameterSize ?? '',
              quantization_level: '',
            },
          }));
        } catch {
          return [];
        }
      }),
    );
    // The serving gezel leads the listing, mirroring /v1/models — a
    // client that picks the first tag lands on the user's chosen
    // front-door gezel.
    const servingEntry: OllamaTagsModel[] = [];
    try {
      const config = await ctx.store.readConfig();
      const servingGezelId = config.openaiEndpoints?.servingGezelId;
      if (servingGezelId) {
        const gezel = await ctx.store.getGezel(servingGezelId).catch(() => null);
        if (gezel) {
          servingEntry.push({
            name: `gezel:${gezel.name}`,
            model: `gezel:${gezel.name}`,
            modified_at: now,
            size: 0,
            digest: '',
            details: {
              parent_model: '',
              format: '',
              family: 'gezel',
              families: ['gezel'],
              parameter_size: '',
              quantization_level: '',
            },
          });
        }
      }
    } catch {
      /* config unreadable — serve the provider roster alone */
    }
    return c.json({ models: [...servingEntry, ...buckets.flat()] });
  });

  /**
   * `POST /chat` — Ollama-style chat. NDJSON streaming when `stream`
   * is unset or true (Ollama's default is streaming); single-shot when
   * explicitly `stream: false`. Tool calling follows Ollama's native
   * contract: caller sends `tools`, captured calls come back as
   * `message.tool_calls` with OBJECT arguments, and the caller posts
   * results back as `role: 'tool'` messages.
   */
  app.post('/chat', async (c) => {
    let parsed: z.infer<typeof OllamaChatRequestSchema>;
    try {
      parsed = OllamaChatRequestSchema.parse(await c.req.json());
    } catch (err) {
      // Ollama's error envelope is a flat string; 400 for caller
      // mistakes (malformed JSON or schema mismatch) rather than the
      // internal 422/500 shapes.
      const message =
        err instanceof ZodError
          ? err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
          : 'invalid JSON body';
      return c.json({ error: message }, 400);
    }

    const endpointsConfig: { servingGezelId?: string; supportingBehaviors?: boolean } =
      await ctx.store
        .readConfig()
        .then((cfg) => cfg.openaiEndpoints ?? {})
        .catch(() => ({}));

    // Target resolution mirrors /v1/chat/completions: `gezel:<ref>`
    // routes through that gezel; `<provider>:<model>` goes straight to
    // the model; anything else falls back to the serving gezel when
    // one is designated, else 404s loudly.
    let target: ChatTarget;
    try {
      const gezelRef = parseGezelModelRef(parsed.model);
      if (gezelRef !== null) {
        target = await resolveChatTarget({ kind: 'gezel', ref: gezelRef }, ctx);
      } else {
        const modelTarget = resolveModelTarget(parsed.model);
        if (modelTarget) {
          target = {
            provider: modelTarget.provider,
            model: modelTarget.model,
            systemPrefix: '',
          };
        } else if (endpointsConfig.servingGezelId) {
          target = await resolveChatTarget(
            { kind: 'gezel', ref: endpointsConfig.servingGezelId },
            ctx,
          );
        } else {
          return c.json({ error: `model "${parsed.model}" not found` }, 404);
        }
      }
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 404);
    }

    let translated: ReturnType<typeof translateMessagesWithPrefix>;
    try {
      translated = translateMessagesWithPrefix(
        toOpenAiMessages(parsed.messages),
        target.systemPrefix,
      );
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }

    // Model-aware resolve — local providers route through the engine
    // pool so any installed local model can be named per request.
    let provider: Awaited<ReturnType<typeof ctx.chat.getProviderForModel>>;
    try {
      provider = await ctx.chat.getProviderForModel(target.provider, target.model);
    } catch (err) {
      if (err instanceof ModelNotInstalledError) {
        // Ollama's own envelope shape for an unknown model.
        return c.json({ error: err.message }, 404);
      }
      throw err;
    }

    const externalTools: ExternalToolSpec[] | undefined = parsed.tools?.map((t) => ({
      name: t.function.name,
      ...(t.function.description ? { description: t.function.description } : {}),
      parameters: t.function.parameters,
    }));
    if (externalTools && externalTools.length > 0 && provider.supportsExternalTools !== true) {
      return c.json(
        {
          error: `provider "${provider.name}" does not support tools — omit them or pick another model`,
        },
        400,
      );
    }

    // Same stateless-history guard as /v1/chat/completions: providers
    // that ignore SessionOpts.priorMessages (Copilot, CLI providers)
    // get the transcript folded into the prompt instead of losing it.
    if (provider.supportsPriorMessages !== true) {
      translated = flattenTranscriptIntoPrompt(translated);
    }
    const { systemMessage, prompt, priorMessages, attachments } = translated;
    const sendOpts = attachments.length > 0 ? { attachments } : undefined;

    // Same session defaults as /v1/chat/completions: tuning always,
    // behavior profile gated by the Connected Apps switch.
    const defaults = await ctx.chat
      .resolveModelSessionDefaults(target.provider, target.model, target.tuningOverrides ?? {})
      .catch(() => null);

    const session = await provider.createSession({
      systemMessage,
      ...(target.model ? { model: target.model } : {}),
      ...(priorMessages.length > 0 ? { priorMessages } : {}),
      ...(externalTools && externalTools.length > 0 ? { externalTools } : {}),
      ...(defaults ? { tuning: defaults.tuning } : {}),
      ...(defaults && endpointsConfig.supportingBehaviors !== false
        ? { profile: defaults.profile }
        : {}),
    });

    const streamingRequested = parsed.stream !== false;

    if (!streamingRequested) {
      const usageRef: { value: TurnUsage | null } = { value: null };
      const unsubUsage = session.onUsage((u) => {
        usageRef.value = u;
      });
      try {
        const content = await session.sendAndWait(prompt, sendOpts);
        const captured = session.capturedToolCalls?.() ?? [];
        return c.json({
          model: parsed.model,
          created_at: new Date().toISOString(),
          message: {
            role: 'assistant',
            content,
            ...(captured.length > 0 ? { tool_calls: toOllamaToolCalls(captured) } : {}),
          },
          done: true,
          done_reason: 'stop',
          ...usageFields(usageRef.value),
        });
      } finally {
        unsubUsage();
        await session.disconnect().catch(() => {});
      }
    }

    // Streaming branch — emit NDJSON line per delta.
    return honoStream(c, async (writer) => {
      writer.onAbort(async () => {
        await session.disconnect().catch(() => {});
      });
      c.res.headers.set('content-type', 'application/x-ndjson');

      const usageRef: { value: TurnUsage | null } = { value: null };
      const unsubUsage = session.onUsage((u) => {
        usageRef.value = u;
      });
      const unsubDelta = session.onDelta((chunk) => {
        if (!chunk) return;
        const line: OllamaChatStreamChunk = {
          model: parsed.model,
          created_at: new Date().toISOString(),
          message: { role: 'assistant', content: chunk },
          done: false,
        };
        void writer.write(`${JSON.stringify(line)}\n`).catch(() => {});
      });

      try {
        await session.sendAndWait(prompt, sendOpts);
        const captured = session.capturedToolCalls?.() ?? [];
        if (captured.length > 0) {
          const toolLine: OllamaChatStreamChunk = {
            model: parsed.model,
            created_at: new Date().toISOString(),
            message: {
              role: 'assistant',
              content: '',
              tool_calls: toOllamaToolCalls(captured),
            },
            done: false,
          };
          await writer.write(`${JSON.stringify(toolLine)}\n`);
        }
        // Final chunk carries the empty assistant message + done_reason
        // real Ollama emits — clients like LangChain's ChatOllama read
        // done_reason to close out the turn.
        const tail: OllamaChatStreamChunk = {
          model: parsed.model,
          created_at: new Date().toISOString(),
          message: { role: 'assistant', content: '' },
          done: true,
          done_reason: 'stop',
          ...usageFields(usageRef.value),
        };
        await writer.write(`${JSON.stringify(tail)}\n`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await writer.write(`${JSON.stringify({ error: message })}\n`).catch(() => {});
      } finally {
        unsubDelta();
        unsubUsage();
        await session.disconnect().catch(() => {});
      }
    });
  });

  return app;
}
