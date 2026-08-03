import {
  RewriteTextRequestSchema,
  type TransformStreamEvent,
  TransformTextRequestSchema,
} from '@bendyline/gezel';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { rewriteText, transformText } from '../../rewrite/generator.js';
import type { ServiceContext } from '../context.js';

export function aiRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  app.post('/rewrite', async (c) => {
    const body = RewriteTextRequestSchema.parse(await c.req.json());
    // Empty text is only meaningful when the caller supplies enough
    // context for a synthesize-from-scratch flow (currently:
    // task-description with a subject, or any context with an
    // explicit instruction).
    const hasSynthesisContext =
      (body.context === 'task-description' && Boolean(body.subject?.trim())) ||
      Boolean(body.instruction?.trim());
    if (!body.text.trim() && !hasSynthesisContext) {
      return c.json({ error: 'empty text' }, 400);
    }
    try {
      const text = await rewriteText(ctx.chat, {
        text: body.text,
        context: body.context,
        instruction: body.instruction,
        isSelection: body.isSelection,
        subject: body.subject,
        parentContext: body.parentContext,
      });
      if (!text) return c.json({ error: 'rewrite returned empty content' }, 500);
      return c.json({ text });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  app.post('/transform', async (c) => {
    const body = TransformTextRequestSchema.parse(await c.req.json());
    if (body.mode === 'insert' && !body.instruction?.trim()) {
      return c.json({ error: 'insert mode requires an instruction' }, 400);
    }
    if (body.mode === 'rewrite' && !body.text.trim()) {
      return c.json({ error: 'empty text' }, 400);
    }
    return streamSSE(c, async (stream) => {
      // Delta hooks fire synchronously; serialize the async SSE writes
      // so events keep their order on the wire.
      let chain = Promise.resolve();
      const write = (event: TransformStreamEvent) => {
        chain = chain.then(() => stream.writeSSE({ data: JSON.stringify(event) })).catch(() => {});
      };
      write({ type: 'status', phase: 'started' });
      try {
        const text = await transformText(
          ctx.chat,
          {
            mode: body.mode,
            text: body.text,
            context: body.context,
            instruction: body.instruction,
            subject: body.subject,
            parentContext: body.parentContext,
            textBefore: body.textBefore,
            textAfter: body.textAfter,
          },
          {
            onThinking: (text) => write({ type: 'thinking-delta', text }),
            onOutput: (text) => write({ type: 'output-delta', text }),
            onQueued: (aheadOf) =>
              write({
                type: 'status',
                phase: 'queued',
                detail: aheadOf > 0 ? `${aheadOf} ahead` : undefined,
              }),
          },
        );
        if (text) write({ type: 'done', text });
        else write({ type: 'error', error: 'transform returned empty content' });
      } catch (err) {
        write({ type: 'error', error: err instanceof Error ? err.message : String(err) });
      }
      await chain;
    });
  });

  return app;
}
