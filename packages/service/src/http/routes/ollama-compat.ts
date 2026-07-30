import { Hono } from 'hono';
import { stream as honoStream } from 'hono/streaming';
import { z } from 'zod';
import { ModelNotInstalledError } from '../../providers/types.js';
import type { ProviderName, TurnUsage } from '../../providers/types.js';
import type { ServiceContext } from '../context.js';
import { flattenTranscriptIntoPrompt, resolveModelTarget } from '../openai-compat/translate.js';

/**
 * `/ollama/v1/*` — minimal Ollama-compatible facade.
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
 * Scope for v1: `/tags` (list) + `/chat` (NDJSON). Generate, pull,
 * show, copy, delete are out of scope — apps that need those should
 * call gezel's own `/v1/models/ensure` (download), `/v1/models`
 * (list), and `/v1/chat/completions` (chat). The Ollama facade is a
 * compatibility shim, not a port of the entire Ollama surface area.
 */
const OllamaMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string(),
});

const OllamaChatRequestSchema = z.object({
  model: z.string().min(1),
  messages: z.array(OllamaMessageSchema).min(1),
  stream: z.boolean().optional(),
});

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
  message?: { role: 'assistant'; content: string };
  done: boolean;
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
    return c.json({ models: buckets.flat() });
  });

  /**
   * `POST /chat` — Ollama-style chat. NDJSON streaming when
   * `stream` is unset or true (Ollama's default is streaming);
   * single-shot when explicitly `stream: false`.
   *
   * Tool calling is not yet supported (same v1 limitation as
   * `/v1/chat/completions`). Requests carrying tool fields receive
   * a clean 400 with a code.
   */
  app.post('/chat', async (c) => {
    const parsed = OllamaChatRequestSchema.parse(await c.req.json());
    const target = resolveModelTarget(parsed.model);
    if (!target) {
      return c.json({ error: 'model not found' }, 404);
    }

    const systems: string[] = [];
    const conversation: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    for (const m of parsed.messages) {
      if (m.role === 'system') systems.push(m.content);
      else conversation.push({ role: m.role, content: m.content });
    }
    if (conversation.length === 0) {
      return c.json({ error: 'no non-system message' }, 400);
    }
    const last = conversation[conversation.length - 1]!;
    if (!last.content.trim()) {
      return c.json({ error: 'last message content is empty' }, 400);
    }
    let prompt = last.content;
    let priorMessages = conversation.slice(0, -1);

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
    // Same stateless-history guard as /v1/chat/completions: providers
    // that ignore SessionOpts.priorMessages (Copilot, CLI providers)
    // get the transcript folded into the prompt instead of losing it.
    if (provider.supportsPriorMessages !== true && priorMessages.length > 0) {
      const flattened = flattenTranscriptIntoPrompt({
        systemMessage: '',
        prompt,
        priorMessages,
        attachments: [],
      });
      prompt = flattened.prompt;
      priorMessages = [];
    }
    const session = await provider.createSession({
      systemMessage: systems.join('\n\n'),
      ...(target.model ? { model: target.model } : {}),
      ...(priorMessages.length > 0 ? { priorMessages } : {}),
    });

    const streamingRequested = parsed.stream !== false;

    if (!streamingRequested) {
      const usageRef: { value: TurnUsage | null } = { value: null };
      const unsubUsage = session.onUsage((u) => {
        usageRef.value = u;
      });
      try {
        const content = await session.sendAndWait(prompt);
        return c.json({
          model: parsed.model,
          created_at: new Date().toISOString(),
          message: { role: 'assistant', content },
          done: true,
          ...(usageRef.value
            ? {
                prompt_eval_count: usageRef.value.inputTokens,
                eval_count: usageRef.value.outputTokens,
                total_duration: usageRef.value.durationMs * 1_000_000,
              }
            : {}),
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
        await session.sendAndWait(prompt);
        const tail: OllamaChatStreamChunk = {
          model: parsed.model,
          created_at: new Date().toISOString(),
          done: true,
          ...(usageRef.value
            ? {
                prompt_eval_count: usageRef.value.inputTokens,
                eval_count: usageRef.value.outputTokens,
                total_duration: usageRef.value.durationMs * 1_000_000,
              }
            : {}),
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
