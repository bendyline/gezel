/**
 * The composer's sparkle menu: rewrite or review a draft before it is sent.
 * One one-shot through {@link ChatManager.oneShotCompletion} on the
 * interactive lane, because a person is waiting with the composer open. The
 * route only answers; the composer puts the result in front of the person,
 * who reads, edits or undoes it before Send. Not a model-session route: the
 * scope guard denies it to session tokens.
 *
 * Mounted under `/api/projects`, so the URL is `/api/projects/:id/prompt-assist`.
 */
import {
  PromptAssistRequestSchema,
  type PromptAssistResponse,
  buildPromptAssistInput,
  createLogger,
  parsePromptAssistReply,
} from '@bendyline/gezel';
import { isEngineBusyError } from '@bendyline/gezel-inference/internal/providers/native/capacity-broker';
import { type Context, Hono } from 'hono';
import type { ServiceContext } from '../context.js';
import { renderedModelPromptGuide, resolveImageModelManifest } from './image-gen.js';
import { providerKind } from './image-models.js';

/** A person is waiting; past this a rewrite is not worth the wait. */
const PROMPT_ASSIST_TIMEOUT_MS = 90_000;
const log = createLogger('prompt-assist');

export function promptAssistRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  app.post('/:id/prompt-assist', async (c) => {
    const id = c.req.param('id');
    const parsed = PromptAssistRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const body = parsed.data;
    const project = await ctx.store.getProject(id).catch(() => null);
    if (!project) return c.json({ error: `Project "${id}" not found.` }, 404);
    const gezel = body.gezelId ? await ctx.store.getGezel(body.gezelId).catch(() => null) : null;
    const imageGuide =
      body.action === 'shape-image' ? await imagePromptGuideFor(ctx, body.imageModel) : undefined;
    const input = buildPromptAssistInput(body.action, body.text, {
      ...(gezel ? { recipient: gezel.name } : {}),
      ...(imageGuide ? { imageGuide } : {}),
      ...(body.notes ? { notes: body.notes } : {}),
    });
    let reply: string;
    try {
      reply = await ctx.chat.oneShotCompletion(input, PROMPT_ASSIST_TIMEOUT_MS, {
        ...(gezel ? { gezelId: gezel.id } : {}),
        projectId: id,
        lane: 'interactive',
        jobLabel: `prompt ${body.action}`,
        // A rewrite needs no reasoning, and a person is waiting. Gemma 4 E4B
        // otherwise spent its whole answer budget thinking and returned
        // nothing for every Animagine prompt (2026-10-19).
        tuning: { reasoning: { enableThinking: false } },
        signal: c.req.raw.signal,
      });
    } catch (err) {
      return assistFailure(c, err);
    }
    const result = parsePromptAssistReply(body.action, reply, body.text);
    if (!result) {
      return c.json(
        { error: 'The model did not give back a usable answer. Your message is unchanged.' },
        422,
      );
    }
    const response: PromptAssistResponse = result;
    return c.json(response);
  });

  return app;
}

/** How the image model that will draw this reads a prompt, for `shape-image`. */
async function imagePromptGuideFor(
  ctx: ServiceContext,
  imageModel: string | undefined,
): Promise<string | undefined> {
  try {
    const provider = await ctx.imageProvider.providerForModel(imageModel);
    const manifest = await resolveImageModelManifest(ctx, provider, imageModel);
    const modelId =
      imageModel ??
      manifest?.id ??
      (await provider.resolveDefaultModelId?.().catch(() => undefined));
    return modelId
      ? renderedModelPromptGuide(providerKind(provider.name), manifest, modelId)
      : undefined;
  } catch {
    return undefined;
  }
}

function assistFailure(c: Context, err: unknown): Response {
  // A 5xx body is made opaque by the HTTP layer; the composer needs words.
  const message = err instanceof Error ? err.message : String(err);
  if (isEngineBusyError(err)) {
    return c.json({ error: 'Another chat is using the model. Try again when it finishes.' }, 409);
  }
  if (/timed out|timeout/i.test(message)) {
    return c.json({ error: 'The model took too long. Your message is unchanged.' }, 408);
  }
  log.warn(`[prompt-assist] failed: ${message}`);
  return c.json({ error: `Could not rewrite the message: ${message}` }, 400);
}
