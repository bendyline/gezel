/**
 * Bounded one-shot model calls for repository workflows (`gezel workflow`,
 * a custom craftbook's driver module). A deterministic driver that needs
 * model judgment on an input it already holds — extract facts from this
 * page, check this paragraph against these quotations — makes one
 * structured call here instead of creating an agentic task that has to read
 * its own input back through tools and write its answer through tools.
 *
 * Runs through {@link ChatManager.oneShotCompletion}, so it shares the
 * engine queue (background lane), awake-time deadline, usage accounting and
 * engine telemetry of every other one-shot. Not a model-session route: the
 * scope guard denies it to session tokens.
 *
 * Mounted under `/api/projects`, so the URL is `/api/projects/:id/completions`.
 */

import {
  type ProjectCompletionRequest,
  ProjectCompletionRequestSchema,
  type ProjectCompletionResponse,
} from '@bendyline/gezel';
import { Hono } from 'hono';
import type { ResolveTuningInput } from '../../model-profile/tuning.js';
import { ModelNotInstalledError } from '../../providers/types.js';
import type { ServiceContext } from '../context.js';

const DEFAULT_COMPLETION_TIMEOUT_MS = 600_000;

export function completionRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  app.post('/:id/completions', async (c) => {
    const id = c.req.param('id');
    const body = ProjectCompletionRequestSchema.parse(await c.req.json());
    const project = await ctx.store.getProject(id).catch(() => null);
    if (!project) return c.json({ error: `Project "${id}" not found.` }, 404);
    if (body.gezelId && !(await ctx.store.getGezel(body.gezelId).catch(() => null))) {
      return c.json({ error: `Gezel "${body.gezelId}" not found.` }, 404);
    }

    const started = Date.now();
    let content: string;
    try {
      content = await ctx.chat.oneShotCompletion(
        body.prompt,
        body.timeoutMs ?? DEFAULT_COMPLETION_TIMEOUT_MS,
        {
          ...(body.gezelId ? { gezelId: body.gezelId } : {}),
          ...(body.provider ? { providerName: body.provider } : {}),
          ...(body.model ? { model: body.model } : {}),
          systemMessage: body.system ?? '',
          tuning: completionTuning(body),
          projectId: id,
          jobLabel: body.label ?? 'workflow completion',
          signal: c.req.raw.signal,
        },
      );
    } catch (err) {
      // Every 5xx body is made opaque by the HTTP layer, so the outcomes a
      // workflow must act on travel as 4xx: retry after a timeout or while an
      // engine downloads, fix the request for a missing model. Anything else
      // stays an opaque 500 with a request id in the service log.
      if (err instanceof ModelNotInstalledError) {
        return c.json({ error: err.message, code: 'model_not_installed' }, 404);
      }
      if (!(err instanceof Error)) throw err;
      if (err.name === 'TimeoutError') {
        return c.json({ error: err.message, code: 'completion_timeout' }, 408);
      }
      if (err.name === 'AbortError') {
        return c.json({ error: err.message, code: 'completion_cancelled' }, 409);
      }
      if ((err as Error & { isActionable?: boolean }).isActionable === true) {
        return c.json({ error: err.message, code: 'provider_unavailable' }, 409);
      }
      throw err;
    }

    const response: ProjectCompletionResponse = {
      content,
      elapsedMs: Date.now() - started,
      ...(body.jsonSchema ? parseJsonAnswer(content) : {}),
    };
    return c.json(response);
  });

  return app;
}

export function completionTuning(
  body: Pick<ProjectCompletionRequest, 'temperature' | 'maxTokens' | 'thinking' | 'jsonSchema'>,
): NonNullable<ResolveTuningInput['override']> {
  return {
    ...(body.temperature !== undefined || body.maxTokens !== undefined
      ? {
          sampling: {
            ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
            ...(body.maxTokens !== undefined ? { maxTokens: body.maxTokens } : {}),
          },
        }
      : {}),
    ...(body.thinking !== undefined ? { reasoning: { enableThinking: body.thinking } } : {}),
    ...(body.jsonSchema ? { output: { jsonSchema: body.jsonSchema } } : {}),
  };
}

/** Grammar-constrained output is usually bare JSON; tolerate a Markdown fence around it. */
export function parseJsonAnswer(content: string): { json: unknown } | { jsonError: string } {
  const text = content
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  try {
    return { json: JSON.parse(text) };
  } catch (err) {
    return { jsonError: err instanceof Error ? err.message : String(err) };
  }
}
