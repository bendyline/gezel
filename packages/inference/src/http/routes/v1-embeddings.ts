import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { ZodError, z } from 'zod';
import type { InferenceContext } from '../inference-context.js';
import { MAX_EMBEDDING_INPUTS, createEmbeddings } from '../openai-compat/embeddings.js';

/**
 * `POST /v1/embeddings` — OpenAI-compatible embeddings.
 *
 * `gezel:embeddings` (or the embedder's own model id) runs the on-device
 * text embedder every Gezel host already carries for memory and search. A
 * `<provider>:<model>` id is served by that provider's `createEmbedding`;
 * a provider without one fails with `400 embeddings_not_supported` rather
 * than falling back to a different model.
 */
const EmbeddingsRequestSchema = z.object({
  model: z.string().min(1),
  input: z.union([z.string(), z.array(z.string()).min(1).max(MAX_EMBEDDING_INPUTS)]),
  encoding_format: z.enum(['float', 'base64']).optional(),
  dimensions: z.number().int().positive().optional(),
  user: z.string().optional(),
});

/** 2048 inputs of the embedder's ~8,000-character working length. */
const MAX_BODY_BYTES = 16 * 1024 * 1024;

function invalidRequest(code: string, message: string) {
  return { error: { message, type: 'invalid_request_error', code } };
}

export function v1EmbeddingsRoutes(ctx: Pick<InferenceContext, 'chat'>): Hono {
  const app = new Hono();

  app.use(
    '*',
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) =>
        c.json(invalidRequest('request_too_large', 'Request body is too large.'), 413),
    }),
  );

  app.post('/', async (c) => {
    // Same request-boundary handling as /v1/chat/completions: malformed
    // JSON and schema mismatches are the caller's mistake — 400 with the
    // OpenAI error envelope, never the internal 422/500 shapes.
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json(invalidRequest('invalid_json', 'Request body is not valid JSON.'), 400);
    }
    let parsed: z.infer<typeof EmbeddingsRequestSchema>;
    try {
      parsed = EmbeddingsRequestSchema.parse(raw);
    } catch (err) {
      if (err instanceof ZodError) {
        return c.json(
          invalidRequest(
            'invalid_body',
            err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
          ),
          400,
        );
      }
      throw err;
    }

    if (parsed.encoding_format === 'base64') {
      return c.json(
        invalidRequest(
          'encoding_format_not_supported',
          'base64 encoding is not supported in gezel /v1 yet.',
        ),
        400,
      );
    }

    const outcome = await createEmbeddings(ctx, parsed.model, parsed.input);
    if (!outcome.ok) {
      const type = outcome.status >= 500 ? 'server_error' : 'invalid_request_error';
      return c.json(
        { error: { message: outcome.message, type, code: outcome.code } },
        outcome.status,
      );
    }

    // None of these models can shorten its vectors, so a request for a
    // different size is refused rather than answered at the wrong one.
    const width = outcome.vectors[0]?.length;
    if (parsed.dimensions !== undefined && width !== undefined && width !== parsed.dimensions) {
      return c.json(
        invalidRequest(
          'dimensions_not_supported',
          `"${parsed.model}" returns ${width}-dimensional vectors and cannot produce ${parsed.dimensions}; omit "dimensions".`,
        ),
        400,
      );
    }

    return c.json({
      object: 'list' as const,
      data: outcome.vectors.map((embedding, index) => ({
        object: 'embedding' as const,
        index,
        embedding,
      })),
      model: outcome.model,
      usage: { prompt_tokens: outcome.inputTokens, total_tokens: outcome.inputTokens },
      // Audit identifier so callers can correlate to gezel-side logs.
      id: `embd-${randomUUID()}`,
    });
  });

  return app;
}
