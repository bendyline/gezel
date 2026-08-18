import { externalGezelModelId } from '@bendyline/gezel';
import { Hono } from 'hono';
import { stream as honoStream } from 'hono/streaming';
import { ZodError, z } from 'zod';
import { ModelNotInstalledError } from '../../providers/types.js';
import type {
  ExternalToolCall,
  ExternalToolSpec,
  ImageAttachment,
  ProviderName,
  TurnUsage,
} from '../../providers/types.js';
import type { ServiceContext } from '../context.js';
import { profileForCallerOwnedInference } from '../openai-compat/caller-owned-profile.js';
import type { ChatTarget } from '../openai-compat/chat-target.js';
import { resolveChatTarget } from '../openai-compat/chat-target.js';
import {
  type OllamaRequestOptions,
  overlayOllamaRequestTuning,
} from '../openai-compat/request-tuning.js';
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
 * `/api` so stock Ollama clients' `{host}/api/*` paths line up.
 *
 * Surface: `/tags`, `/chat` (NDJSON, tools + images + options/format),
 * `/generate` (single-turn), `/embed` + legacy `/embeddings`, `/show`,
 * `/ps`. Chat and generate share `/v1/chat/completions`' semantics:
 * `gezel:<ref>` targets and the serving-gezel fallback (persona +
 * per-gezel tuning), per-model tuning with the request's
 * `options`/`format` overlaid on top, the behavior profile gated by
 * the `supportingBehaviors` switch, and caller-executed tools. Pull,
 * copy, delete are out of scope — use gezel's own `/v1/models/ensure`
 * (download) and `/v1/models` (list).
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

/**
 * Ollama's per-request `options`. Only sampling-shaped keys are typed
 * and honored (overlaid onto resolved tuning); engine-level knobs the
 * pool owns (`num_ctx`, `num_thread`, `num_gpu`, …) are stripped by
 * the schema and ignored.
 */
const OllamaOptionsSchema = z.object({
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  top_k: z.number().int().optional(),
  min_p: z.number().optional(),
  num_predict: z.number().int().optional(),
  seed: z.number().int().optional(),
  repeat_penalty: z.number().optional(),
  presence_penalty: z.number().optional(),
  frequency_penalty: z.number().optional(),
});

/** Ollama structured output: `'json'` or a bare JSON schema object. */
const OllamaFormatSchema = z.union([z.literal('json'), z.record(z.string(), z.unknown())]);

const OllamaChatRequestSchema = z.object({
  model: z.string().min(1),
  messages: z.array(OllamaMessageSchema).min(1),
  stream: z.boolean().optional(),
  tools: z.array(OllamaToolSchema).optional(),
  options: OllamaOptionsSchema.optional(),
  format: OllamaFormatSchema.optional(),
});

const OllamaGenerateRequestSchema = z.object({
  model: z.string().min(1),
  prompt: z.string().min(1),
  system: z.string().optional(),
  images: z.array(z.string().min(1)).optional(),
  stream: z.boolean().optional(),
  options: OllamaOptionsSchema.optional(),
  format: OllamaFormatSchema.optional(),
});

const OllamaEmbedRequestSchema = z.object({
  model: z.string().min(1),
  input: z.union([z.string(), z.array(z.string()).min(1)]),
});

const OllamaLegacyEmbeddingsRequestSchema = z.object({
  model: z.string().min(1),
  prompt: z.string().min(1),
});

const OllamaShowRequestSchema = z.object({
  model: z.string().optional(),
  name: z.string().optional(),
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

type OllamaDoneReason = 'stop' | 'length';

interface OllamaChatStreamChunk {
  model: string;
  created_at: string;
  message?: {
    role: 'assistant';
    content: string;
    tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>;
  };
  done: boolean;
  done_reason?: OllamaDoneReason;
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

/** Bare-base64 → ImageAttachment for the single-turn /generate path. */
function toAttachment(image: string, index: number): ImageAttachment {
  const mimeType = sniffImageMime(image);
  return {
    base64: image,
    mimeType,
    filename: `image-${index}.${mimeType.split('/').pop() ?? 'bin'}`,
  };
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

/** Truncation inference — same heuristic as /v1 (see streaming.ts). */
function doneReason(usage: TurnUsage | null, cap: number | undefined): OllamaDoneReason {
  if (cap !== undefined && cap > 0 && usage !== null && usage.outputTokens >= cap) return 'length';
  return 'stop';
}

interface EndpointsConfigSlice {
  servingGezelId?: string;
  supportingBehaviors?: boolean;
}

async function readEndpointsConfig(ctx: ServiceContext): Promise<EndpointsConfigSlice> {
  return ctx.store
    .readConfig()
    .then((cfg) => cfg.openaiEndpoints ?? {})
    .catch(() => ({}));
}

/**
 * Shared target resolution for chat + generate + show: `gezel:<ref>` →
 * that gezel; `<provider>:<model>` → the model; anything else → the
 * serving gezel when designated. Returns null for "model not found"
 * (caller 404s in Ollama's flat-error shape); throws on a bad gezel
 * ref (caller 404s with the message).
 */
async function resolveOllamaTarget(
  ctx: ServiceContext,
  model: string,
  endpointsConfig: EndpointsConfigSlice,
): Promise<ChatTarget | null> {
  const gezelRef = parseGezelModelRef(model);
  if (gezelRef !== null) return resolveChatTarget({ kind: 'gezel', ref: gezelRef }, ctx);
  const modelTarget = resolveModelTarget(model);
  if (modelTarget) {
    return { provider: modelTarget.provider, model: modelTarget.model, systemPrefix: '' };
  }
  if (endpointsConfig.servingGezelId) {
    return resolveChatTarget({ kind: 'gezel', ref: endpointsConfig.servingGezelId }, ctx);
  }
  return null;
}

export function ollamaCompatRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  const logCompletion = (
    appId: string,
    model: string,
    provider: ProviderName,
    usage: TurnUsage | null,
  ): void => {
    void ctx.history
      .log({
        kind: 'v1.chat.completion',
        summary: `${appId} · chat completion (${model})`,
        details: {
          appId,
          surface: 'ollama',
          model,
          provider,
          ...(usage ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } : {}),
        },
      })
      .catch(() => {});
  };

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
            name: externalGezelModelId(gezel),
            model: externalGezelModelId(gezel),
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

  /** `GET /ps` — running models. Engine residency isn't surfaced yet; an empty list is valid. */
  app.get('/ps', (c) => c.json({ models: [] }));

  /**
   * `POST /show` — model metadata. Minimal but honest: enough shape
   * for clients that read `model_info.<arch>.context_length`
   * (LangChain's ChatOllama) and `capabilities`.
   */
  app.post('/show', async (c) => {
    let parsed: z.infer<typeof OllamaShowRequestSchema>;
    try {
      parsed = OllamaShowRequestSchema.parse(await c.req.json());
    } catch {
      return c.json({ error: 'invalid request body' }, 400);
    }
    const modelField = parsed.model ?? parsed.name;
    if (!modelField) return c.json({ error: 'model is required' }, 400);
    const endpointsConfig = await readEndpointsConfig(ctx);
    let target: ChatTarget | null;
    try {
      target = await resolveOllamaTarget(ctx, modelField, endpointsConfig);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 404);
    }
    if (!target) return c.json({ error: `model "${modelField}" not found` }, 404);
    let contextWindow: number | undefined;
    try {
      const models = await ctx.chat.listModelsForProvider(target.provider);
      contextWindow = models.find((m) => m.id === target.model)?.contextWindow;
    } catch {
      /* provider unavailable — serve the generic shape */
    }
    return c.json({
      modelfile: '',
      parameters: '',
      template: '',
      details: {
        parent_model: '',
        format: '',
        family: 'gezel',
        families: ['gezel'],
        parameter_size: '',
        quantization_level: '',
      },
      model_info: {
        'general.architecture': 'gezel',
        ...(contextWindow ? { 'gezel.context_length': contextWindow } : {}),
      },
      capabilities: ['completion', 'tools'],
    });
  });

  /**
   * `POST /embed` (and the legacy `POST /embeddings` single-prompt
   * form) — Ollama's embeddings endpoints, backed by
   * `LLMProvider.createEmbedding` like `/v1/embeddings`.
   */
  app.post('/embed', async (c) => {
    let parsed: z.infer<typeof OllamaEmbedRequestSchema>;
    try {
      parsed = OllamaEmbedRequestSchema.parse(await c.req.json());
    } catch {
      return c.json({ error: 'invalid request body' }, 400);
    }
    const target = resolveModelTarget(parsed.model);
    if (!target) return c.json({ error: `model "${parsed.model}" not found` }, 404);
    try {
      const provider = await ctx.chat.getProvider(target.provider);
      if (!provider.createEmbedding) {
        return c.json({ error: `provider "${target.provider}" does not support embeddings` }, 400);
      }
      const result = await provider.createEmbedding({
        input: parsed.input,
        ...(target.model ? { model: target.model } : {}),
      });
      return c.json({ model: parsed.model, embeddings: result.vectors });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.post('/embeddings', async (c) => {
    let parsed: z.infer<typeof OllamaLegacyEmbeddingsRequestSchema>;
    try {
      parsed = OllamaLegacyEmbeddingsRequestSchema.parse(await c.req.json());
    } catch {
      return c.json({ error: 'invalid request body' }, 400);
    }
    const target = resolveModelTarget(parsed.model);
    if (!target) return c.json({ error: `model "${parsed.model}" not found` }, 404);
    try {
      const provider = await ctx.chat.getProvider(target.provider);
      if (!provider.createEmbedding) {
        return c.json({ error: `provider "${target.provider}" does not support embeddings` }, 400);
      }
      const result = await provider.createEmbedding({
        input: parsed.prompt,
        ...(target.model ? { model: target.model } : {}),
      });
      return c.json({ embedding: result.vectors[0] ?? [] });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  /**
   * `POST /generate` — Ollama's single-turn completion. Same target
   * resolution, tuning overlay, and observability as `/chat`; the
   * response text rides `response` instead of `message.content`.
   */
  app.post('/generate', async (c) => {
    let parsed: z.infer<typeof OllamaGenerateRequestSchema>;
    try {
      parsed = OllamaGenerateRequestSchema.parse(await c.req.json());
    } catch (err) {
      const message =
        err instanceof ZodError
          ? err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
          : 'invalid JSON body';
      return c.json({ error: message }, 400);
    }
    const endpointsConfig = await readEndpointsConfig(ctx);
    let target: ChatTarget | null;
    try {
      target = await resolveOllamaTarget(ctx, parsed.model, endpointsConfig);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 404);
    }
    if (!target) return c.json({ error: `model "${parsed.model}" not found` }, 404);

    let provider: Awaited<ReturnType<typeof ctx.chat.getProviderForModel>>;
    try {
      provider = await ctx.chat.getProviderForModel(target.provider, target.model);
    } catch (err) {
      if (err instanceof ModelNotInstalledError) return c.json({ error: err.message }, 404);
      throw err;
    }

    const defaults = await ctx.chat
      .resolveModelSessionDefaults(target.provider, target.model, target.tuningOverrides ?? {})
      .catch(() => null);
    const tuning = defaults
      ? overlayOllamaRequestTuning(defaults.tuning, parsed.options, parsed.format)
      : null;
    const lengthCap = tuning?.sampling.maxTokens;

    const systemMessage = [target.systemPrefix, parsed.system ?? '']
      .filter((s) => s.trim().length > 0)
      .join('\n\n---\n\n');
    const session = await provider.createSession({
      systemMessage,
      ...(target.model ? { model: target.model } : {}),
      ...(tuning ? { tuning } : {}),
      ...(defaults && endpointsConfig.supportingBehaviors !== false
        ? { profile: profileForCallerOwnedInference(defaults.profile) }
        : {}),
    });
    const usageRef: { value: TurnUsage | null } = { value: null };
    session.onUsage((u) => {
      usageRef.value = u;
      ctx.chat.recordExternalUsage(target.provider, u);
    });
    const appId = c.get('auth')?.appId ?? 'unauthenticated';
    const attachments = (parsed.images ?? []).map(toAttachment);
    const sendOpts = attachments.length > 0 ? { attachments } : undefined;

    if (parsed.stream === false) {
      try {
        const response = await session.sendAndWait(parsed.prompt, sendOpts);
        logCompletion(appId, parsed.model, target.provider, usageRef.value);
        return c.json({
          model: parsed.model,
          created_at: new Date().toISOString(),
          response,
          done: true,
          done_reason: doneReason(usageRef.value, lengthCap),
          ...usageFields(usageRef.value),
        });
      } finally {
        await session.disconnect().catch(() => {});
      }
    }

    return honoStream(c, async (writer) => {
      writer.onAbort(async () => {
        await session.disconnect().catch(() => {});
      });
      c.res.headers.set('content-type', 'application/x-ndjson');
      const unsubDelta = session.onDelta((chunk) => {
        if (!chunk) return;
        void writer
          .write(
            `${JSON.stringify({
              model: parsed.model,
              created_at: new Date().toISOString(),
              response: chunk,
              done: false,
            })}\n`,
          )
          .catch(() => {});
      });
      try {
        await session.sendAndWait(parsed.prompt, sendOpts);
        logCompletion(appId, parsed.model, target.provider, usageRef.value);
        await writer.write(
          `${JSON.stringify({
            model: parsed.model,
            created_at: new Date().toISOString(),
            response: '',
            done: true,
            done_reason: doneReason(usageRef.value, lengthCap),
            ...usageFields(usageRef.value),
          })}\n`,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await writer.write(`${JSON.stringify({ error: message })}\n`).catch(() => {});
      } finally {
        unsubDelta();
        await session.disconnect().catch(() => {});
      }
    });
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

    const endpointsConfig = await readEndpointsConfig(ctx);

    let target: ChatTarget | null;
    try {
      target = await resolveOllamaTarget(ctx, parsed.model, endpointsConfig);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 404);
    }
    if (!target) return c.json({ error: `model "${parsed.model}" not found` }, 404);

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

    // Same session defaults as /v1/chat/completions: tuning always
    // (with the request's options/format overlaid on top), behavior
    // profile gated by the Connected Apps switch. Caller-owned inference
    // keeps compatibility behaviors without Gezel action-loop enforcement.
    const defaults = await ctx.chat
      .resolveModelSessionDefaults(target.provider, target.model, target.tuningOverrides ?? {})
      .catch(() => null);
    const tuning = defaults
      ? overlayOllamaRequestTuning(defaults.tuning, parsed.options, parsed.format)
      : null;
    const lengthCap = tuning?.sampling.maxTokens;

    const session = await provider.createSession({
      systemMessage,
      ...(target.model ? { model: target.model } : {}),
      ...(priorMessages.length > 0 ? { priorMessages } : {}),
      ...(externalTools && externalTools.length > 0 ? { externalTools } : {}),
      ...(tuning ? { tuning } : {}),
      ...(defaults && endpointsConfig.supportingBehaviors !== false
        ? { profile: profileForCallerOwnedInference(defaults.profile) }
        : {}),
    });

    const usageRef: { value: TurnUsage | null } = { value: null };
    session.onUsage((u) => {
      usageRef.value = u;
      ctx.chat.recordExternalUsage(target.provider, u);
    });
    const appId = c.get('auth')?.appId ?? 'unauthenticated';

    const streamingRequested = parsed.stream !== false;

    if (!streamingRequested) {
      try {
        const content = await session.sendAndWait(prompt, sendOpts);
        const captured = session.capturedToolCalls?.() ?? [];
        logCompletion(appId, parsed.model, target.provider, usageRef.value);
        return c.json({
          model: parsed.model,
          created_at: new Date().toISOString(),
          message: {
            role: 'assistant',
            content,
            ...(captured.length > 0 ? { tool_calls: toOllamaToolCalls(captured) } : {}),
          },
          done: true,
          done_reason: doneReason(usageRef.value, lengthCap),
          ...usageFields(usageRef.value),
        });
      } finally {
        await session.disconnect().catch(() => {});
      }
    }

    // Streaming branch — emit NDJSON line per delta.
    return honoStream(c, async (writer) => {
      writer.onAbort(async () => {
        await session.disconnect().catch(() => {});
      });
      c.res.headers.set('content-type', 'application/x-ndjson');

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
        logCompletion(appId, parsed.model, target.provider, usageRef.value);
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
          done_reason: doneReason(usageRef.value, lengthCap),
          ...usageFields(usageRef.value),
        };
        await writer.write(`${JSON.stringify(tail)}\n`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await writer.write(`${JSON.stringify({ error: message })}\n`).catch(() => {});
      } finally {
        unsubDelta();
        await session.disconnect().catch(() => {});
      }
    });
  });

  return app;
}
