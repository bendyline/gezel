import { RewriteTextRequestSchema } from '@bendyline/gezel';
import { Hono } from 'hono';
import { rewriteText } from '../../rewrite/generator.js';
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

  return app;
}
