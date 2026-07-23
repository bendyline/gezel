import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import type { ServiceContext } from '../context.js';
import { resolveModelTarget } from '../openai-compat/translate.js';

/**
 * `POST /v1/embeddings` — OpenAI-compatible embeddings.
 *
 * Backed by `LLMProvider.createEmbedding`. Providers that don't
 * implement embeddings (most local engines today, anthropic CLI, etc.)
 * fail with `400 embeddings_not_supported` so the caller sees a clear
 * error instead of a silent fallback to a different provider.
 *
 * The `model` field carries the same `<provider>:<model>` qualifier as
 * `/v1/chat/completions` so an app can route chat + embeddings against
 * the same backend with one set of envelopes.
 */
const EmbeddingsRequestSchema = z.object({
  model: z.string().min(1),
  input: z.union([z.string(), z.array(z.string()).min(1)]),
  encoding_format: z.enum(['float', 'base64']).optional(),
  dimensions: z.number().int().positive().optional(),
  user: z.string().optional(),
});

export function v1EmbeddingsRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  app.post('/', async (c) => {
    const parsed = EmbeddingsRequestSchema.parse(await c.req.json());

    if (parsed.encoding_format === 'base64') {
      return c.json(
        {
          error: {
            message: 'base64 encoding is not supported in gezel /v1 yet.',
            type: 'invalid_request_error',
            code: 'encoding_format_not_supported',
          },
        },
        400,
      );
    }

    const target = resolveModelTarget(parsed.model);
    if (!target) {
      return c.json(
        {
          error: {
            message: `Unknown model "${parsed.model}". Expected "<provider>:<model>" — see /v1/models.`,
            type: 'invalid_request_error',
            code: 'model_not_found',
          },
        },
        404,
      );
    }

    try {
      const provider = await ctx.chat.getProvider(target.provider);
      if (!provider.createEmbedding) {
        return c.json(
          {
            error: {
              message: `Provider "${target.provider}" does not support embeddings.`,
              type: 'invalid_request_error',
              code: 'embeddings_not_supported',
            },
          },
          400,
        );
      }
      const result = await provider.createEmbedding({
        input: parsed.input,
        ...(target.model ? { model: target.model } : {}),
      });

      const data = result.vectors.map((vec, index) => ({
        object: 'embedding' as const,
        index,
        embedding: vec,
      }));

      return c.json({
        object: 'list' as const,
        data,
        model: parsed.model,
        usage: {
          prompt_tokens: result.usage.inputTokens,
          total_tokens: result.usage.inputTokens,
        },
        // Audit identifier so callers can correlate to gezel-side logs.
        id: `embd-${randomUUID()}`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: { message, type: 'server_error', code: 'provider_error' } }, 500);
    }
  });

  return app;
}
