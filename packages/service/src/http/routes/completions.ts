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
  AwakeBudget,
  type ProjectCompletionRequest,
  ProjectCompletionRequestSchema,
  type ProjectCompletionResponse,
  createLogger,
} from '@bendyline/gezel';
import { isRambleAbortMessage } from '@bendyline/gezel/local-loop';
import { type Context, Hono } from 'hono';
import type { ResolveTuningInput } from '../../model-profile/tuning.js';
import {
  isCapacityDeniedError,
  isEngineBusyError,
} from '../../providers/native/capacity-broker.js';
import { ModelNotInstalledError } from '../../providers/types.js';
import type { ServiceContext } from '../context.js';

const DEFAULT_COMPLETION_TIMEOUT_MS = 600_000;
/** How often a call waiting for another model to give up the engine tries again. */
const WAIT_POLL_MS = 15_000;
/** How long a capacity refusal is waited out before it is reported. */
const CAPACITY_WAIT_MS = 120_000;
const log = createLogger('completions');

export function completionRoutes(
  ctx: ServiceContext,
  waits: { pollMs?: number; capacityMs?: number } = {},
): Hono {
  const pollMs = waits.pollMs ?? WAIT_POLL_MS;
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
    const signal = c.req.raw.signal;
    const budget = new AwakeBudget(body.timeoutMs ?? DEFAULT_COMPLETION_TIMEOUT_MS);
    const requestedMs = body.timeoutMs ?? DEFAULT_COMPLETION_TIMEOUT_MS;
    const capacityBudget = new AwakeBudget(waits.capacityMs ?? CAPACITY_WAIT_MS);
    let content: string;
    for (let attempt = 0; ; attempt++) {
      try {
        content = await ctx.chat.oneShotCompletion(
          body.prompt,
          attempt === 0 ? requestedMs : Math.max(1_000, budget.remainingMs()),
          {
            ...(body.gezelId ? { gezelId: body.gezelId } : {}),
            ...(body.provider ? { providerName: body.provider } : {}),
            ...(body.model ? { model: body.model } : {}),
            systemMessage: body.system ?? '',
            tuning: completionTuning(body),
            projectId: id,
            jobLabel: body.label ?? 'workflow completion',
            signal,
          },
        );
        break;
      } catch (err) {
        // Another model holds the engine: night-shift work on a different
        // model, or a daemon that has not measured host memory yet (its
        // budget is re-derived about a minute after start). Nothing reached
        // a model, so wait for the room instead of failing the workflow's
        // step. A busy engine drains on its own; a capacity refusal gets a
        // short wait, since a model that genuinely does not fit never will.
        const busy = isEngineBusyError(err);
        const denied =
          !busy &&
          isCapacityDeniedError(err) &&
          (err as { reason?: string }).reason !== 'resident-below-minimum';
        if (
          (busy || (denied && !capacityBudget.expired())) &&
          !budget.expired() &&
          !signal.aborted
        ) {
          log.info(
            `[completions] ${body.label ?? 'workflow completion'}: ${busy ? 'engine busy' : 'capacity denied'}; retrying in ${Math.round(pollMs / 1000)}s`,
          );
          await pause(Math.min(pollMs, budget.remainingMs()), signal);
          continue;
        }
        return completionFailure(c, err, body.label);
      }
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

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

function completionFailure(c: Context, err: unknown, label: string | undefined): Response {
  // Every 5xx body is made opaque by the HTTP layer, so the outcomes a
  // workflow must act on travel as 4xx: retry after a timeout, while an
  // engine downloads, or once another model's turn drains; fix the request
  // for a missing model. Anything else stays an opaque 500 with a request id
  // in the service log.
  if (isEngineBusyError(err)) {
    return c.json({ error: (err as Error).message, code: 'engine_busy' }, 409);
  }
  if (isCapacityDeniedError(err)) {
    return c.json({ error: (err as Error).message, code: 'capacity_denied' }, 409);
  }
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
  // A local engine's loop guard stopped the answer. Its message is a
  // corrective addressed to an agent ("start with a tool call"), which
  // means nothing to a workflow, and as an unhandled error it surfaced as an
  // opaque 500 the caller could not tell from a daemon fault.
  if (isRambleAbortMessage(err.message)) {
    log.warn(`[completions] ${label ?? 'workflow completion'}: ${err.message}`);
    return c.json(
      {
        error:
          'The local engine stopped the answer because it looked like a runaway loop. Retrying usually succeeds; a lower temperature or a smaller request makes it less likely.',
        code: 'output_aborted',
      },
      422,
    );
  }
  throw err;
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
